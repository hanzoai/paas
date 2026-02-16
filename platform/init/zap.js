var server = null;

/**
 * Initializes ZAP server alongside Express.
 * Exposes PaaS controller operations as MCP-compatible tools via ZAP protocol.
 * Gracefully skips if @zap-proto/zap is not installed.
 */
export async function initializeZapServer() {
	let ZapServer;
	try {
		({ ZapServer } = await import("@zap-proto/zap/server"));
	} catch {
		console.info("ZAP server disabled (@zap-proto/zap not installed)");
		return;
	}

	const clsCtrl = (await import("../controllers/cluster.js")).default;
	const cntrCtrl = (await import("../controllers/container.js")).default;
	const orgCtrl = (await import("../controllers/organization.js")).default;
	const prjCtrl = (await import("../controllers/project.js")).default;
	const envCtrl = (await import("../controllers/environment.js")).default;
	const regCtrl = (await import("../controllers/registry.js")).default;
	const userCtrl = (await import("../controllers/user.js")).default;
	const { templates } = await import("../handlers/templates/index.js");

	const port = parseInt(process.env.ZAP_PORT || "9998", 10);

	server = new ZapServer({
		port,
		name: "paas-platform",
	});

	// ── Cluster tools ───────────────────────────────────────────────────

	server.tool(
		"cluster:info",
		"Get cluster configuration and status",
		{ type: "object", properties: {} },
		async () => {
			const cluster = await clsCtrl.getOneByQuery({
				clusterAccesssToken: process.env.CLUSTER_ACCESS_TOKEN,
			});
			return { content: [{ type: "text", text: JSON.stringify(cluster) }] };
		}
	);

	server.tool(
		"cluster:setup_status",
		"Check whether cluster initial setup is complete",
		{ type: "object", properties: {} },
		async () => {
			const user = await userCtrl.getOneByQuery({ isClusterOwner: true });
			return {
				content: [{ type: "text", text: JSON.stringify({ status: !!user }) }],
			};
		}
	);

	server.tool(
		"cluster:containers",
		"List all cluster-level containers",
		{ type: "object", properties: {} },
		async () => {
			const containers = await cntrCtrl.getManyByQuery({
				isClusterEntity: true,
			});
			return {
				content: [{ type: "text", text: JSON.stringify(containers) }],
			};
		}
	);

	server.tool(
		"cluster:templates",
		"List available container templates",
		{ type: "object", properties: {} },
		async () => {
			const latest = templates.map((entry) => ({
				...entry,
				templates: entry.templates.filter((t) => t.isLatest),
			}));
			return { content: [{ type: "text", text: JSON.stringify(latest) }] };
		}
	);

	// ── Organization tools ──────────────────────────────────────────────

	server.tool(
		"org:list",
		"List all organizations",
		{ type: "object", properties: {} },
		async () => {
			const orgs = await orgCtrl.getManyByQuery({});
			return { content: [{ type: "text", text: JSON.stringify(orgs) }] };
		}
	);

	server.tool(
		"org:get",
		"Get organization by ID",
		{
			type: "object",
			properties: {
				orgId: { type: "string", description: "Organization ID" },
			},
			required: ["orgId"],
		},
		async (params) => {
			const org = await orgCtrl.getOneById(params.orgId);
			return { content: [{ type: "text", text: JSON.stringify(org) }] };
		}
	);

	// ── Project tools ───────────────────────────────────────────────────

	server.tool(
		"project:list",
		"List projects in an organization",
		{
			type: "object",
			properties: {
				orgId: { type: "string", description: "Organization ID" },
			},
			required: ["orgId"],
		},
		async (params) => {
			const projects = await prjCtrl.getManyByQuery({
				orgId: params.orgId,
			});
			return { content: [{ type: "text", text: JSON.stringify(projects) }] };
		}
	);

	server.tool(
		"project:get",
		"Get project by ID",
		{
			type: "object",
			properties: {
				projectId: { type: "string", description: "Project ID" },
			},
			required: ["projectId"],
		},
		async (params) => {
			const project = await prjCtrl.getOneById(params.projectId);
			return { content: [{ type: "text", text: JSON.stringify(project) }] };
		}
	);

	// ── Environment tools ───────────────────────────────────────────────

	server.tool(
		"env:list",
		"List environments in a project",
		{
			type: "object",
			properties: {
				projectId: { type: "string", description: "Project ID" },
			},
			required: ["projectId"],
		},
		async (params) => {
			const envs = await envCtrl.getManyByQuery({
				projectId: params.projectId,
			});
			return { content: [{ type: "text", text: JSON.stringify(envs) }] };
		}
	);

	// ── Container tools ─────────────────────────────────────────────────

	server.tool(
		"container:list",
		"List containers in an environment",
		{
			type: "object",
			properties: {
				envId: { type: "string", description: "Environment ID" },
			},
			required: ["envId"],
		},
		async (params) => {
			const containers = await cntrCtrl.getManyByQuery({
				environmentId: params.envId,
			});
			return {
				content: [{ type: "text", text: JSON.stringify(containers) }],
			};
		}
	);

	server.tool(
		"container:get",
		"Get container by ID",
		{
			type: "object",
			properties: {
				containerId: { type: "string", description: "Container ID" },
			},
			required: ["containerId"],
		},
		async (params) => {
			const container = await cntrCtrl.getOneById(params.containerId);
			return {
				content: [{ type: "text", text: JSON.stringify(container) }],
			};
		}
	);

	// ── Registry tools ──────────────────────────────────────────────────

	server.tool(
		"registry:list",
		"List container registries",
		{ type: "object", properties: {} },
		async () => {
			const registries = await regCtrl.getManyByQuery({});
			return {
				content: [{ type: "text", text: JSON.stringify(registries) }],
			};
		}
	);

	// ── Health ───────────────────────────────────────────────────────────

	server.tool(
		"health",
		"Check PaaS platform health",
		{ type: "object", properties: {} },
		async () => {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							status: "ok",
							service: "paas-platform",
							pid: process.pid,
						}),
					},
				],
			};
		}
	);

	try {
		await server.start();
		console.info(`ZAP server started @ ws://0.0.0.0:${port}`);
	} catch (err) {
		console.error("Failed to start ZAP server:", err.message);
	}
}

export function disconnectZapServer() {
	if (server) {
		server.stop();
		server = null;
	}
}
