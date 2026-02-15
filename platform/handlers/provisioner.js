import axios from "axios";

const DO_API = "https://api.digitalocean.com/v2";
const DO_TOKEN = process.env.DO_API_TOKEN;
const DEFAULT_REGION = process.env.DO_DEFAULT_REGION || "sfo3";
const DEFAULT_K8S_VERSION = process.env.DO_K8S_VERSION || "1.34.1-do.3";
const DEFAULT_NODE_SIZE = process.env.DO_DEFAULT_NODE_SIZE || "s-2vcpu-4gb";
const DEFAULT_NODE_COUNT = 2;

function doHeaders() {
	if (!DO_TOKEN) throw new Error("DO_API_TOKEN not configured");
	return {
		Authorization: `Bearer ${DO_TOKEN}`,
		"Content-Type": "application/json",
	};
}

/**
 * Create a new DOKS cluster for an organization.
 */
export async function createDOKSCluster({
	orgId,
	orgName,
	region = DEFAULT_REGION,
	nodeSize = DEFAULT_NODE_SIZE,
	nodeCount = DEFAULT_NODE_COUNT,
	haControlPlane = false,
}) {
	const slug = `hanzo-${orgName.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 40)}`;

	const body = {
		name: slug,
		region,
		version: DEFAULT_K8S_VERSION,
		ha: haControlPlane,
		node_pools: [
			{
				size: nodeSize,
				name: `${slug}-pool`,
				count: nodeCount,
				auto_scale: true,
				min_nodes: 1,
				max_nodes: Math.max(nodeCount * 3, 6),
			},
		],
		auto_upgrade: true,
		surge_upgrade: true,
		maintenance_policy: {
			start_time: "04:00",
			day: "sunday",
		},
		tags: [`org:${orgId}`, "hanzo-managed", "paas"],
	};

	const res = await axios.post(`${DO_API}/kubernetes/clusters`, body, {
		headers: doHeaders(),
	});

	return res.data.kubernetes_cluster;
}

/**
 * Get DOKS cluster status.
 */
export async function getDOKSCluster(clusterId) {
	const res = await axios.get(`${DO_API}/kubernetes/clusters/${clusterId}`, {
		headers: doHeaders(),
	});
	return res.data.kubernetes_cluster;
}

/**
 * Get kubeconfig for a cluster.
 */
export async function getDOKSKubeconfig(clusterId) {
	const res = await axios.get(
		`${DO_API}/kubernetes/clusters/${clusterId}/kubeconfig`,
		{
			headers: doHeaders(),
			responseType: "text",
		}
	);
	return res.data;
}

/**
 * Delete a DOKS cluster (dangerous - removes all workloads).
 */
export async function deleteDOKSCluster(clusterId) {
	await axios.delete(
		`${DO_API}/kubernetes/clusters/${clusterId}?destroy_associated_resources=true`,
		{ headers: doHeaders() }
	);
}

/**
 * Add a node pool to an existing cluster.
 */
export async function addNodePool(clusterId, { name, size, count }) {
	const res = await axios.post(
		`${DO_API}/kubernetes/clusters/${clusterId}/node_pools`,
		{
			size: size || DEFAULT_NODE_SIZE,
			name,
			count: count || DEFAULT_NODE_COUNT,
			auto_scale: true,
			min_nodes: 1,
			max_nodes: Math.max((count || DEFAULT_NODE_COUNT) * 3, 6),
			tags: ["hanzo-managed"],
		},
		{ headers: doHeaders() }
	);
	return res.data.node_pool;
}

/**
 * Resize/update a node pool.
 */
export async function updateNodePool(clusterId, poolId, { count, size }) {
	const body = {};
	if (count !== undefined) body.count = count;
	if (size !== undefined) body.size = size;
	body.auto_scale = true;
	body.min_nodes = 1;
	body.max_nodes = Math.max((count || 3) * 3, 6);

	const res = await axios.put(
		`${DO_API}/kubernetes/clusters/${clusterId}/node_pools/${poolId}`,
		body,
		{ headers: doHeaders() }
	);
	return res.data.node_pool;
}

/**
 * Delete a node pool.
 */
export async function deleteNodePool(clusterId, poolId) {
	await axios.delete(
		`${DO_API}/kubernetes/clusters/${clusterId}/node_pools/${poolId}`,
		{ headers: doHeaders() }
	);
}

/**
 * Upgrade cluster to HA control plane ($40/mo).
 */
export async function upgradeToHA(clusterId) {
	// DO API: PATCH cluster with ha: true
	const res = await axios.put(
		`${DO_API}/kubernetes/clusters/${clusterId}`,
		{ ha: true },
		{ headers: doHeaders() }
	);
	return res.data.kubernetes_cluster;
}

/**
 * List available node sizes with pricing info.
 */
export async function listNodeSizes() {
	const res = await axios.get(`${DO_API}/kubernetes/options`, {
		headers: doHeaders(),
	});
	return res.data.options;
}

/**
 * List available regions.
 */
export async function listRegions() {
	const res = await axios.get(`${DO_API}/regions`, {
		headers: doHeaders(),
	});
	return res.data.regions.filter((r) => r.available && r.features.includes("kubernetes"));
}

/**
 * Get droplet pricing for billing calculations.
 */
export async function getDropletPricing(sizeSlug) {
	const res = await axios.get(`${DO_API}/sizes`, {
		headers: doHeaders(),
	});
	const size = res.data.sizes.find((s) => s.slug === sizeSlug);
	if (!size) return null;
	return {
		slug: size.slug,
		priceMonthly: size.price_monthly,
		priceHourly: size.price_hourly,
		vcpus: size.vcpus,
		memory: size.memory,
		disk: size.disk,
		description: size.description,
	};
}
