import axios from "axios";
import orgCtrl from "../controllers/organization.js";
import { getDropletPricing, getDOKSCluster } from "./provisioner.js";

const HA_MONTHLY_COST = 40; // $40/mo for HA control plane
const MARKUP_PERCENT = parseFloat(process.env.HANZO_PLATFORM_MARKUP_PERCENT || "0");

// Cache pricing lookups for 1 hour
const priceCache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

async function getCachedPricing(sizeSlug) {
	const cached = priceCache.get(sizeSlug);
	if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
	const data = await getDropletPricing(sizeSlug);
	if (data) priceCache.set(sizeSlug, { data, ts: Date.now() });
	return data;
}

/**
 * Calculate monthly cost for an org's DOKS cluster from its current state.
 */
export async function calculateOrgCost(org) {
	if (!org?.doks?.clusterId || org.doks.status === "error") {
		return { monthlyTotal: 0, items: [], currency: "USD" };
	}

	const items = [];

	// Node pool costs
	for (const pool of org.doks.nodePools || []) {
		const pricing = await getCachedPricing(pool.size);
		if (pricing) {
			const poolCost = pricing.priceMonthly * pool.count;
			items.push({
				type: "nodes",
				pool: pool.name,
				size: pool.size,
				count: pool.count,
				unitPrice: pricing.priceMonthly,
				monthlyTotal: poolCost,
				vcpus: pricing.vcpus * pool.count,
				memoryMb: pricing.memory * pool.count,
				diskGb: pricing.disk * pool.count,
			});
		}
	}

	// HA control plane cost
	if (org.doks.ha) {
		items.push({
			type: "ha_control_plane",
			monthlyTotal: HA_MONTHLY_COST,
		});
	}

	const subtotal = items.reduce((sum, i) => sum + i.monthlyTotal, 0);
	const markup = subtotal * (MARKUP_PERCENT / 100);
	const monthlyTotal = subtotal + markup;

	return {
		orgId: org._id.toString(),
		orgName: org.name,
		clusterId: org.doks.clusterId,
		clusterName: org.doks.clusterName,
		region: org.doks.region,
		status: org.doks.status,
		items,
		subtotal,
		markupPercent: MARKUP_PERCENT,
		markup,
		monthlyTotal,
		currency: "USD",
		calculatedAt: new Date().toISOString(),
	};
}

/**
 * Get billing for a single org.
 */
export async function getOrgBilling(orgId) {
	const org = await orgCtrl.getOneById(orgId);
	if (!org) return null;
	return calculateOrgCost(org);
}

/**
 * Get fleet-wide billing summary.
 */
export async function getFleetBilling() {
	const orgs = await orgCtrl.getManyByQuery({
		"doks.clusterId": { $exists: true, $ne: null },
	});

	const results = await Promise.all(orgs.map((org) => calculateOrgCost(org)));

	const totalMonthly = results.reduce((sum, r) => sum + r.monthlyTotal, 0);
	const totalNodes = results.reduce(
		(sum, r) => sum + r.items.filter((i) => i.type === "nodes").reduce((s, i) => s + i.count, 0),
		0
	);
	const totalVcpus = results.reduce(
		(sum, r) => sum + r.items.filter((i) => i.type === "nodes").reduce((s, i) => s + (i.vcpus || 0), 0),
		0
	);
	const totalMemoryMb = results.reduce(
		(sum, r) => sum + r.items.filter((i) => i.type === "nodes").reduce((s, i) => s + (i.memoryMb || 0), 0),
		0
	);

	return {
		organizations: results,
		summary: {
			totalOrgs: results.length,
			totalMonthly,
			totalNodes,
			totalVcpus,
			totalMemoryGb: Math.round(totalMemoryMb / 1024),
			currency: "USD",
			calculatedAt: new Date().toISOString(),
		},
	};
}

/**
 * Record usage event for tracking (fire-and-forget to commerce analytics).
 */
export async function recordUsageEvent(orgId, eventData) {
	const endpoint = process.env.HANZO_USAGE_ENDPOINT;
	if (!endpoint) return; // no usage endpoint configured, skip silently

	try {
		await axios.post(endpoint, {
			organization_id: orgId,
			event: "infrastructure_usage",
			timestamp: new Date().toISOString(),
			properties: eventData,
		}, { timeout: 5000 });
	} catch (err) {
		// Don't fail operations for usage tracking errors
		console.warn(`Usage tracking failed for org ${orgId}:`, err.message);
	}
}
