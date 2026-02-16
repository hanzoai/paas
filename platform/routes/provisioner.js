import express from "express";
import { authSession } from "../middlewares/authSession.js";
import { checkContentType } from "../middlewares/contentType.js";
import { validateOrg } from "../middlewares/validateOrg.js";
import orgCtrl from "../controllers/organization.js";
import helper from "../util/helper.js";
import {
	createDOKSCluster,
	getDOKSCluster,
	getDOKSKubeconfig,
	deleteDOKSCluster,
	addNodePool,
	updateNodePool,
	deleteNodePool,
	upgradeToHA,
	listNodeSizes,
	listRegions,
	getDropletPricing,
} from "../handlers/provisioner.js";
import ERROR_CODES from "../config/errorCodes.js";
import { recordUsageEvent, calculateOrgCost } from "../handlers/billing.js";

const router = express.Router({ mergeParams: true });

/*
@route      /v1/cluster/doks/fleet
@method     GET
@desc       Returns DOKS cluster info for all orgs the user can access
@access     private
*/
router.get("/fleet", authSession, async (req, res) => {
	try {
		// Get all orgs that have a DOKS cluster
		const orgs = await orgCtrl.getManyByQuery({ "doks.clusterId": { $exists: true, $ne: null } });
		const fleet = await Promise.all(orgs.map(async (org) => {
			const cost = await calculateOrgCost(org);
			return {
				orgId: org._id,
				orgName: org.name,
				clusterId: org.doks.clusterId,
				clusterName: org.doks.clusterName,
				region: org.doks.region,
				status: org.doks.status,
				ha: org.doks.ha || false,
				endpoint: org.doks.endpoint,
				nodePools: org.doks.nodePools || [],
				createdAt: org.doks.createdAt,
				monthlyTotal: cost.monthlyTotal,
			};
		}));
		res.json(fleet);
	} catch (error) {
		helper.handleError(req, res, error);
	}
});

/*
@route      /v1/cluster/doks/options
@method     GET
@desc       Returns available DOKS regions and node sizes
@access     private
*/
router.get("/options", authSession, async (req, res) => {
	try {
		const [options, regions] = await Promise.all([
			listNodeSizes(),
			listRegions(),
		]);
		res.json({ options, regions });
	} catch (error) {
		helper.handleError(req, res, error);
	}
});

/*
@route      /v1/cluster/doks/pricing/:sizeSlug
@method     GET
@desc       Returns pricing for a specific droplet size
@access     private
*/
router.get("/pricing/:sizeSlug", authSession, async (req, res) => {
	try {
		const pricing = await getDropletPricing(req.params.sizeSlug);
		if (!pricing) {
			return res.status(404).json({
				error: "Not Found",
				details: `No pricing found for size '${req.params.sizeSlug}'`,
				code: ERROR_CODES.notFound,
			});
		}
		res.json(pricing);
	} catch (error) {
		helper.handleError(req, res, error);
	}
});

/*
@route      /v1/cluster/doks/provision
@method     POST
@desc       Provisions a new DOKS cluster for an organization
@access     private (org admin only)
*/
router.post(
	"/provision",
	checkContentType,
	authSession,
	async (req, res) => {
		try {
			const { orgId, region, nodeSize, nodeCount, ha } = req.body;

			if (!orgId) {
				return res.status(400).json({
					error: "Bad Request",
					details: "orgId is required",
					code: ERROR_CODES.invalidRequestBody,
				});
			}

			// Get the organization
			const org = await orgCtrl.getOneById(orgId);
			if (!org) {
				return res.status(404).json({
					error: "Not Found",
					details: "Organization not found",
					code: ERROR_CODES.notFound,
				});
			}

			// Check if org already has a cluster
			if (org.doks?.clusterId && org.doks?.status !== "error") {
				return res.status(409).json({
					error: "Conflict",
					details: `Organization already has a DOKS cluster (status: ${org.doks.status})`,
					code: ERROR_CODES.notAllowed,
				});
			}

			// Mark org as provisioning
			await orgCtrl.updateOneById(orgId, {
				"doks.status": "provisioning",
				"doks.region": region || "sfo3",
				"doks.ha": ha || false,
				"doks.createdAt": new Date(),
			});

			// Create DOKS cluster (async - will be polled)
			const cluster = await createDOKSCluster({
				orgId: orgId,
				orgName: org.name,
				region,
				nodeSize,
				nodeCount,
				haControlPlane: ha || false,
			});

			// Update org with cluster info
			const updated = await orgCtrl.updateOneById(orgId, {
				"doks.clusterId": cluster.id,
				"doks.clusterName": cluster.name,
				"doks.region": cluster.region_slug,
				"doks.status": cluster.status.state === "running" ? "running" : "provisioning",
				"doks.endpoint": cluster.endpoint,
				"doks.ha": cluster.ha,
				"doks.nodePools": cluster.node_pools.map((p) => ({
					poolId: p.id,
					name: p.name,
					size: p.size,
					count: p.count,
					autoScale: p.auto_scale,
				})),
			});

			// Track usage event
			recordUsageEvent(orgId, {
				action: "cluster_provision",
				region: cluster.region_slug,
				nodeSize: nodeSize || "s-2vcpu-4gb",
				nodeCount: nodeCount || 2,
				ha: ha || false,
				clusterId: cluster.id,
			});

			res.status(201).json(updated);
		} catch (error) {
			// If provisioning fails, update org with error
			if (req.body?.orgId) {
				try {
					await orgCtrl.updateOneById(req.body.orgId, {
						"doks.status": "error",
						"doks.provisionError": error.message,
					});
				} catch (_) {}
			}
			helper.handleError(req, res, error);
		}
	}
);

/*
@route      /v1/cluster/doks/:orgId/status
@method     GET
@desc       Returns DOKS cluster status for an org (polls DO API)
@access     private
*/
router.get("/:orgId/status", authSession, async (req, res) => {
	try {
		const org = await orgCtrl.getOneById(req.params.orgId);
		if (!org?.doks?.clusterId) {
			return res.status(404).json({
				error: "Not Found",
				details: "No DOKS cluster for this organization",
				code: ERROR_CODES.notFound,
			});
		}

		const cluster = await getDOKSCluster(org.doks.clusterId);

		// Update cached status
		const newStatus = cluster.status.state === "running" ? "running" : org.doks.status;
		if (newStatus !== org.doks.status) {
			await orgCtrl.updateOneById(req.params.orgId, {
				"doks.status": newStatus,
				"doks.endpoint": cluster.endpoint,
				"doks.nodePools": cluster.node_pools.map((p) => ({
					poolId: p.id,
					name: p.name,
					size: p.size,
					count: p.count,
					autoScale: p.auto_scale,
				})),
			});
		}

		res.json({
			status: cluster.status,
			endpoint: cluster.endpoint,
			ha: cluster.ha,
			region: cluster.region_slug,
			version: cluster.version_slug,
			nodePools: cluster.node_pools,
			createdAt: cluster.created_at,
			maintenancePolicy: cluster.maintenance_policy,
		});
	} catch (error) {
		helper.handleError(req, res, error);
	}
});

/*
@route      /v1/cluster/doks/:orgId/kubeconfig
@method     GET
@desc       Returns kubeconfig for org's DOKS cluster
@access     private (org admin only)
*/
router.get("/:orgId/kubeconfig", authSession, async (req, res) => {
	try {
		const org = await orgCtrl.getOneById(req.params.orgId);
		if (!org?.doks?.clusterId) {
			return res.status(404).json({
				error: "Not Found",
				details: "No DOKS cluster for this organization",
				code: ERROR_CODES.notFound,
			});
		}

		const kubeconfig = await getDOKSKubeconfig(org.doks.clusterId);
		res.type("text/yaml").send(kubeconfig);
	} catch (error) {
		helper.handleError(req, res, error);
	}
});

/*
@route      /v1/cluster/doks/:orgId/node-pools
@method     POST
@desc       Add a node pool to org's DOKS cluster
@access     private (org admin only)
*/
router.post(
	"/:orgId/node-pools",
	checkContentType,
	authSession,
	async (req, res) => {
		try {
			const org = await orgCtrl.getOneById(req.params.orgId);
			if (!org?.doks?.clusterId || org.doks.status !== "running") {
				return res.status(400).json({
					error: "Bad Request",
					details: "Cluster not ready",
					code: ERROR_CODES.notAllowed,
				});
			}

			const { name, size, count } = req.body;
			const pool = await addNodePool(org.doks.clusterId, { name, size, count });

			// Update org node pools
			const pools = [
				...(org.doks.nodePools || []),
				{
					poolId: pool.id,
					name: pool.name,
					size: pool.size,
					count: pool.count,
					autoScale: pool.auto_scale,
				},
			];
			await orgCtrl.updateOneById(req.params.orgId, { "doks.nodePools": pools });

			recordUsageEvent(req.params.orgId, {
				action: "node_pool_add",
				pool: pool.name,
				size: pool.size,
				count: pool.count,
			});

			res.status(201).json(pool);
		} catch (error) {
			helper.handleError(req, res, error);
		}
	}
);

/*
@route      /v1/cluster/doks/:orgId/node-pools/:poolId
@method     PUT
@desc       Scale a node pool
@access     private (org admin only)
*/
router.put(
	"/:orgId/node-pools/:poolId",
	checkContentType,
	authSession,
	async (req, res) => {
		try {
			const org = await orgCtrl.getOneById(req.params.orgId);
			if (!org?.doks?.clusterId || org.doks.status !== "running") {
				return res.status(400).json({
					error: "Bad Request",
					details: "Cluster not ready",
					code: ERROR_CODES.notAllowed,
				});
			}

			const { count, size } = req.body;
			const pool = await updateNodePool(org.doks.clusterId, req.params.poolId, {
				count,
				size,
			});

			// Update cached pool info
			const pools = (org.doks.nodePools || []).map((p) =>
				p.poolId === req.params.poolId
					? { ...p, count: pool.count, size: pool.size }
					: p
			);
			await orgCtrl.updateOneById(req.params.orgId, { "doks.nodePools": pools });

			res.json(pool);
		} catch (error) {
			helper.handleError(req, res, error);
		}
	}
);

/*
@route      /v1/cluster/doks/:orgId/node-pools/:poolId
@method     DELETE
@desc       Delete a node pool
@access     private (org admin only)
*/
router.delete(
	"/:orgId/node-pools/:poolId",
	authSession,
	async (req, res) => {
		try {
			const org = await orgCtrl.getOneById(req.params.orgId);
			if (!org?.doks?.clusterId || org.doks.status !== "running") {
				return res.status(400).json({
					error: "Bad Request",
					details: "Cluster not ready",
					code: ERROR_CODES.notAllowed,
				});
			}

			await deleteNodePool(org.doks.clusterId, req.params.poolId);

			const pools = (org.doks.nodePools || []).filter(
				(p) => p.poolId !== req.params.poolId
			);
			await orgCtrl.updateOneById(req.params.orgId, { "doks.nodePools": pools });

			res.status(204).end();
		} catch (error) {
			helper.handleError(req, res, error);
		}
	}
);

/*
@route      /v1/cluster/doks/:orgId/upgrade-ha
@method     POST
@desc       Upgrade cluster to HA control plane ($40/mo)
@access     private (org admin only)
*/
router.post("/:orgId/upgrade-ha", authSession, async (req, res) => {
	try {
		const org = await orgCtrl.getOneById(req.params.orgId);
		if (!org?.doks?.clusterId || org.doks.status !== "running") {
			return res.status(400).json({
				error: "Bad Request",
				details: "Cluster not ready",
				code: ERROR_CODES.notAllowed,
			});
		}

		if (org.doks.ha) {
			return res.status(409).json({
				error: "Conflict",
				details: "Cluster already has HA control plane",
				code: ERROR_CODES.notAllowed,
			});
		}

		const cluster = await upgradeToHA(org.doks.clusterId);
		await orgCtrl.updateOneById(req.params.orgId, { "doks.ha": true });

		recordUsageEvent(req.params.orgId, {
			action: "ha_upgrade",
			monthlyCost: 40,
		});

		res.json({ ha: true, cluster });
	} catch (error) {
		helper.handleError(req, res, error);
	}
});

/*
@route      /v1/cluster/doks/:orgId
@method     DELETE
@desc       Delete org's DOKS cluster (DANGEROUS)
@access     private (org admin only)
*/
router.delete("/:orgId", authSession, async (req, res) => {
	try {
		const org = await orgCtrl.getOneById(req.params.orgId);
		if (!org?.doks?.clusterId) {
			return res.status(404).json({
				error: "Not Found",
				details: "No DOKS cluster for this organization",
				code: ERROR_CODES.notFound,
			});
		}

		// Confirm deletion with explicit flag
		if (req.query.confirm !== "true") {
			return res.status(400).json({
				error: "Bad Request",
				details: "Pass ?confirm=true to confirm cluster deletion. This destroys all workloads.",
				code: ERROR_CODES.invalidRequestBody,
			});
		}

		await orgCtrl.updateOneById(req.params.orgId, { "doks.status": "deleting" });
		await deleteDOKSCluster(org.doks.clusterId);

		recordUsageEvent(req.params.orgId, {
			action: "cluster_delete",
			clusterId: org.doks.clusterId,
		});

		await orgCtrl.updateOneById(req.params.orgId, {
			doks: null,
		});

		res.status(204).end();
	} catch (error) {
		helper.handleError(req, res, error);
	}
});

export default router;
