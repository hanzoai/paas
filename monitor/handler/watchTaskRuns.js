import axios from "axios";
import k8s from "@kubernetes/client-node";
import helper from "../util/helper.js";

// Create a Kubernetes core API client
const kubeconfig = new k8s.KubeConfig();
kubeconfig.loadFromDefault();
const k8sCustomApi = kubeconfig.makeApiClient(k8s.CustomObjectsApi);

var watchRequest = null; // To store the watch request

/**
 * Posts a commit status to GitHub for the given SHA.
 * This is a backup mechanism -- the pipeline's report-status step handles this primarily,
 * but the monitor catches edge cases like pod eviction or OOM kills.
 * @param {string} pat - GitHub personal access token.
 * @param {string} repoUrl - The full HTML URL of the repo (e.g. https://github.com/owner/repo).
 * @param {string} sha - The commit SHA.
 * @param {string} state - The commit status state (pending, success, failure, error).
 * @param {string} description - Human-readable description of the status.
 */
async function postGithubCommitStatus(pat, repoUrl, sha, state, description) {
	if (!pat || !repoUrl || !sha) return;
	const ownerRepo = repoUrl
		.replace(/https?:\/\/github\.com\//, "")
		.replace(/\.git$/, "")
		.replace(/\/$/, "");
	if (!ownerRepo || !ownerRepo.includes("/")) return;
	try {
		await axios.post(
			`https://api.github.com/repos/${ownerRepo}/statuses/${sha}`,
			{
				state,
				context: "hanzo-paas/ci",
				description,
				target_url: "https://platform.hanzo.ai",
			},
			{
				headers: {
					Authorization: `token ${pat}`,
					Accept: "application/vnd.github.v3+json",
				},
			}
		);
		console.info(
			`Backup commit status posted to GitHub: ${state} for ${sha}`
		);
	} catch (err) {
		console.error(
			`Failed to post backup commit status to GitHub for ${sha}. ${
				err.response?.data?.message ?? err.message
			}`
		);
	}
}

/**
 * Posts a commit status to GitLab for the given SHA.
 * Backup mechanism for edge cases not handled by the pipeline step.
 * @param {string} pat - GitLab personal access token.
 * @param {string} projectId - The GitLab project ID (numeric or URL-encoded path).
 * @param {string} sha - The commit SHA.
 * @param {string} state - The commit status state (pending, success, failed, canceled).
 * @param {string} description - Human-readable description of the status.
 */
async function postGitlabCommitStatus(pat, projectId, sha, state, description) {
	if (!pat || !projectId || !sha) return;
	const encodedProjectId = String(projectId).replace(/\//g, "%2F");
	try {
		await axios.post(
			`https://gitlab.com/api/v4/projects/${encodedProjectId}/statuses/${sha}`,
			{
				state,
				context: "hanzo-paas/ci",
				name: "hanzo-paas/ci",
				description,
				target_url: "https://platform.hanzo.ai",
			},
			{
				headers: {
					"PRIVATE-TOKEN": pat,
					"Content-Type": "application/json",
				},
			}
		);
		console.info(
			`Backup commit status posted to GitLab: ${state} for ${sha}`
		);
	} catch (err) {
		console.error(
			`Failed to post backup commit status to GitLab for ${sha}. ${
				err.response?.data?.message ?? err.message
			}`
		);
	}
}

/**
 * Posts a build status to Bitbucket for the given SHA.
 * Backup mechanism for edge cases not handled by the pipeline step.
 * @param {string} pat - Bitbucket personal access token.
 * @param {string} repoFullName - The full repo name (workspace/repo_slug).
 * @param {string} sha - The commit SHA.
 * @param {string} state - The build status state (INPROGRESS, SUCCESSFUL, FAILED, STOPPED).
 * @param {string} description - Human-readable description of the status.
 */
async function postBitbucketCommitStatus(
	pat,
	repoFullName,
	sha,
	state,
	description
) {
	if (!pat || !repoFullName || !sha) return;
	try {
		await axios.post(
			`https://api.bitbucket.org/2.0/repositories/${repoFullName}/commit/${sha}/statuses/build`,
			{
				state,
				key: "hanzo-paas-ci",
				name: "hanzo-paas/ci",
				description,
				url: "https://platform.hanzo.ai",
			},
			{
				headers: {
					Authorization: `Bearer ${pat}`,
					"Content-Type": "application/json",
				},
			}
		);
		console.info(
			`Backup commit status posted to Bitbucket: ${state} for ${sha}`
		);
	} catch (err) {
		console.error(
			`Failed to post backup commit status to Bitbucket for ${sha}. ${
				err.response?.data?.message ?? err.message
			}`
		);
	}
}

/**
 * Extracts git provider parameters from a TaskRun's TriggerBinding params.
 * The params are stored in the TaskRun spec as an array of {name, value} objects.
 * @param {object} taskRunObj - The full TaskRun Kubernetes object.
 * @returns {object|null} An object with provider, pat, repoUrl, revision, repoName, and projectId; or null if not extractable.
 */
function extractGitParams(taskRunObj) {
	if (!taskRunObj?.spec?.params) return null;

	const params = taskRunObj.spec.params;
	const paramMap = {};
	for (const p of params) {
		paramMap[p.name] = p.value;
	}

	// Determine the provider type based on which PAT param exists
	let provider = null;
	let pat = null;
	if (paramMap.githubpat) {
		provider = "github";
		pat = paramMap.githubpat;
	} else if (paramMap.gitlabpat) {
		provider = "gitlab";
		pat = paramMap.gitlabpat;
	} else if (paramMap.bitbucketpat) {
		provider = "bitbucket";
		pat = paramMap.bitbucketpat;
	}

	if (!provider) return null;

	return {
		provider,
		pat,
		repoUrl: paramMap.gitrepourl || "",
		revision: paramMap.gitrevision || "",
		repoName: paramMap.gitreponame || "",
		projectId: paramMap.gitlabprojectid || "",
	};
}

/**
 * Posts a backup commit status based on the TaskRun completion event.
 * Called when the monitor detects a Succeeded or Failed event on a TaskRun.
 * @param {object} taskRunObj - The full TaskRun Kubernetes object.
 * @param {string} reason - The event reason (e.g. "Succeeded", "Failed").
 */
async function reportBackupCommitStatus(taskRunObj, reason) {
	const gitParams = extractGitParams(taskRunObj);
	if (!gitParams || !gitParams.revision || gitParams.revision === "N/A")
		return;

	const isSuccess =
		reason === "Succeeded" || reason === "TaskRunCancelled";
	const description = isSuccess
		? "Pipeline completed successfully"
		: `Pipeline ${reason.toLowerCase()}`;

	switch (gitParams.provider) {
		case "github":
			await postGithubCommitStatus(
				gitParams.pat,
				gitParams.repoUrl,
				gitParams.revision,
				isSuccess ? "success" : "failure",
				description
			);
			break;
		case "gitlab":
			await postGitlabCommitStatus(
				gitParams.pat,
				gitParams.projectId || gitParams.repoName,
				gitParams.revision,
				isSuccess ? "success" : "failed",
				description
			);
			break;
		case "bitbucket":
			await postBitbucketCommitStatus(
				gitParams.pat,
				gitParams.repoName,
				gitParams.revision,
				isSuccess ? "SUCCESSFUL" : "FAILED",
				description
			);
			break;
		default:
			break;
	}
}

/**
 * Watches build events and updates the build status of containers.
 */
export async function watchBuildEvents() {
	if (watchRequest) return;

	const watch = new k8s.Watch(kubeconfig);
	const namespace = "tekton-builds";

	/**
	 * Start watching build events.
	 */
	async function startWatching() {
		try {
			console.info("Started watching build events...");
			let now = new Date().getTime();
			watchRequest = watch.watch(
				`/api/v1/namespaces/${namespace}/events`,
				{
					fieldSelector: "involvedObject.kind=TaskRun", // Filter events for a specific resource type
				},
				(type, event) => {
					let eventTime = null;
					if (event.lastTimestamp)
						eventTime = new Date(event.lastTimestamp).getTime();
					else if (event.firstTimestamp)
						eventTime = new Date(event.firstTimestamp).getTime();

					if (eventTime && eventTime < now) return;

					if (
						event.reason === "Failed" ||
						event.reason === "Succeeded" ||
						event.reason === "Error" ||
						event.reason === "Started" ||
						event.reason === "Running" ||
						event.reason === "TaskRunCancelled" ||
						event.reason === "TaskRunTimeout" ||
						event.reason === "TaskRunImagePullFailed"
					) {
						// Get task run name from the involved object
						let taskRunName = event.involvedObject.name;
						// Get the taskrun object
						getTaskRun(taskRunName).then((taskRunObj) => {
							if (!taskRunObj) return;

							const eventListenerName =
								taskRunObj.metadata.labels[
									"triggers.tekton.dev/eventlistener"
								];
							if (!eventListenerName) return;

							// Extract container slug from the event listener name e.g., github-listener-lkv0ier4
							let containerSlug =
								eventListenerName.split("-")[2];
							if (containerSlug) {
								console.info(
									`Updating the build status of container ${containerSlug}. ${event.reason?.replace(
										"TaskRun",
										""
									)}`
								);
								//Make api call to the platform to update the build status of the container
								axios
									.post(
										helper.getPlatformUrl() +
											"/v1/telemetry/pipeline/status",
										{
											containerSlug,
											status: event.reason?.replace(
												"TaskRun",
												""
											),
										},
										{
											headers: {
												Authorization:
													process.env.MASTER_TOKEN,
												"Content-Type":
													"application/json",
											},
										}
									)
									.catch((err) => {
										console.error(
											`Cannot send build pipeline run status data of container ${containerSlug} to platform. ${
												err.response?.body?.message ??
												err.message
											}`
										);
									});
							}

							// Post backup commit status for terminal events
							if (
								event.reason === "Succeeded" ||
								event.reason === "Failed" ||
								event.reason === "Error" ||
								event.reason === "TaskRunCancelled" ||
								event.reason === "TaskRunTimeout" ||
								event.reason === "TaskRunImagePullFailed"
							) {
								reportBackupCommitStatus(
									taskRunObj,
									event.reason
								).catch((err) => {
									console.error(
										`Error posting backup commit status for ${taskRunName}. ${err.message}`
									);
								});
							}
						});
					}
				},
				(err) => {
					console.error(
						`Error while watching for build events. ${
							err?.response?.body?.message ?? err?.message
						}`
					);
					// Retry the watch after a delay
					setTimeout(startWatching, 2000);
				}
			);
		} catch (err) {
			console.error(
				`Error while watching for build events. ${
					err.response?.body?.message ?? err.message
				}`
			);
			// Retry the watch after a delay if still watching
			setTimeout(startWatching, 1000);
		}
	}

	startWatching();
}

/**
 * Stops watching build events.
 */
export function stopWatchingBuildEvents() {
	try {
		if (watchRequest) {
			watchRequest.abort();
			watchRequest = null;
			console.info("Stopped watching build events.");
		}
	} catch (err) {
		console.error(
			`Error while stopping the watch for build events. ${
				err.response?.body?.message ?? err.message
			}`
		);
		watchRequest = null;
	}
}

/**
 * Retrieves information about a TaskRun
 * @param {string} taskRunName - The name of the TaskRun.
 * @returns {Promise<Object|null>} - A Promise that resolves to the TaskRun object if found, or null if not found.
 */
async function getTaskRun(taskRunName) {
	try {
		const response = await k8sCustomApi.getNamespacedCustomObject(
			"tekton.dev", // The API group for Tekton
			"v1beta1", // The API version for Tekton
			"tekton-builds", // The namespace of the TaskRun
			"taskruns", // The plural name of the resource
			taskRunName // The name of the TaskRun
		);

		return response.body;
	} catch (err) {
		console.error(
			`Cannot get TaskRun ${taskRunName} in namespace tekton-builds. ${
				err.response?.body?.message ?? err.message
			}`
		);
		return null;
	}
}
