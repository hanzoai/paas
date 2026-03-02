import { Worker, type Job } from '@hanzo/mq'
import { eq } from 'drizzle-orm'
import { db } from '@paas/db/client'
import { deployments, containers, clusters } from '@paas/db/schema'
import { createOrchestrator, type K8sConnection, type DockerConnection, type CloudflarePagesConnection, type GitHubPagesConnection } from '@paas/orchestrator'
import type { BuildSpec, DeployStatus } from '@paas/shared'
import { connection } from '../queues'

function orchestratorFromCluster(cluster: typeof clusters.$inferSelect) {
  switch (cluster.type) {
    case 'kubernetes':
      return createOrchestrator({
        clusterType: 'kubernetes',
        connection: { kind: 'kubernetes', kubeconfig: cluster.kubeconfig ?? '' } satisfies K8sConnection,
      })
    case 'cloudflare-pages': {
      const meta = cluster.cloudMeta as { accountId?: string; apiToken?: string } | null
      return createOrchestrator({
        clusterType: 'cloudflare-pages',
        connection: { kind: 'cloudflare-pages', accountId: meta?.accountId ?? '', apiToken: meta?.apiToken ?? '' } satisfies CloudflarePagesConnection,
      })
    }
    case 'github-pages': {
      const meta = cluster.cloudMeta as { token?: string; owner?: string } | null
      return createOrchestrator({
        clusterType: 'github-pages',
        connection: { kind: 'github-pages', token: meta?.token ?? '', owner: meta?.owner ?? '' } satisfies GitHubPagesConnection,
      })
    }
    default:
      return createOrchestrator({
        clusterType: cluster.type,
        connection: { kind: 'docker', host: cluster.endpoint ?? '', tlsCert: cluster.tlsCert ?? undefined, tlsKey: cluster.tlsKey ?? undefined, tlsCa: cluster.tlsCa ?? undefined } satisfies DockerConnection,
      })
  }
}

// ---- Job payload ----

export interface BuildJobData {
  deploymentId: string
  containerId: string
}

// ---- Helpers ----

async function setDeployStatus(deploymentId: string, status: DeployStatus, extra?: Record<string, unknown>) {
  await db
    .update(deployments)
    .set({ status, ...extra })
    .where(eq(deployments.id, deploymentId))
}

async function appendBuildLogs(deploymentId: string, chunk: string) {
  // Append to existing logs via raw SQL concat to avoid read-modify-write races
  const existing = await db.query.deployments.findFirst({
    where: eq(deployments.id, deploymentId),
    columns: { buildLogs: true },
  })
  const logs = (existing?.buildLogs ?? '') + chunk
  await db
    .update(deployments)
    .set({ buildLogs: logs })
    .where(eq(deployments.id, deploymentId))
}

// ---- Worker processor ----

async function processBuild(job: Job<BuildJobData>): Promise<void> {
  const { deploymentId, containerId } = job.data

  // 1. Load container + cluster from DB
  const container = await db.query.containers.findFirst({
    where: eq(containers.id, containerId),
  })
  if (!container) throw new Error(`Container not found: ${containerId}`)

  const cluster = await db.query.clusters.findFirst({
    where: eq(clusters.id, container.clusterId),
  })
  if (!cluster) throw new Error(`Cluster not found: ${container.clusterId}`)

  // 2. Mark deployment as building
  await setDeployStatus(deploymentId, 'building', { startedAt: new Date() })

  // 3. Construct orchestrator from cluster record
  const orchestrator = orchestratorFromCluster(cluster)

  // 4. Build
  const repoConfig = container.repoConfig as BuildSpec['repo'] | null
  if (!repoConfig) throw new Error(`Container ${containerId} has no repo config for build`)

  const deployment = await db.query.deployments.findFirst({
    where: eq(deployments.id, deploymentId),
    columns: { commitSha: true, branch: true },
  })

  const buildSpec: BuildSpec = {
    containerId,
    namespace: container.iid, // environment iid doubles as K8s namespace
    name: container.slug,
    repo: repoConfig,
    registry: '', // resolved by orchestrator from registryConfig
    imageName: container.slug,
    commitSha: deployment?.commitSha ?? undefined,
  }

  try {
    const buildResult = await orchestrator.triggerBuild(buildSpec)
    await appendBuildLogs(deploymentId, `Build triggered: ${buildResult.buildId}\n`)

    // 5. Poll build status until terminal
    await setDeployStatus(deploymentId, 'pushing')

    let terminal = false
    while (!terminal) {
      await sleep(3000)
      const status = await orchestrator.getBuildStatus(buildResult.buildId)
      if (status.logs) {
        await appendBuildLogs(deploymentId, status.logs)
      }

      switch (status.status) {
        case 'succeeded':
          terminal = true
          await setDeployStatus(deploymentId, 'deploying', {
            imageTag: status.imageTag ?? buildResult.imageTag,
          })
          break
        case 'failed':
        case 'cancelled':
          terminal = true
          await setDeployStatus(deploymentId, 'failed', {
            finishedAt: new Date(),
            buildDuration: status.duration ?? null,
          })
          return // no deploy step
        default:
          // still in progress (queued, building, pushing)
          break
      }
    }

    // 6. Deploy: update the container with the new image
    const imageTag = (await db.query.deployments.findFirst({
      where: eq(deployments.id, deploymentId),
      columns: { imageTag: true },
    }))?.imageTag

    const fullImage = `${container.slug}:${imageTag ?? 'latest'}`
    const containerVars = (container.variables as Array<{ name: string; value: string }>) ?? []

    await orchestrator.updateContainer({
      namespace: buildSpec.namespace,
      name: container.slug,
      type: container.type,
      image: fullImage,
      variables: containerVars,
      networking: container.networking as any,
      podConfig: container.podConfig as any,
    })

    await setDeployStatus(deploymentId, 'running', { finishedAt: new Date() })
    await appendBuildLogs(deploymentId, `Deploy complete: ${fullImage}\n`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await appendBuildLogs(deploymentId, `ERROR: ${message}\n`)
    await setDeployStatus(deploymentId, 'failed', { finishedAt: new Date() })
    throw err
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---- Worker factory ----

export function createBuildWorker(): Worker<BuildJobData> {
  const worker = new Worker<BuildJobData>('build', processBuild, {
    connection,
    concurrency: 5,
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  })

  worker.on('failed', (job, err) => {
    console.error(`[build] Job ${job?.id} failed: ${err.message}`)
  })

  worker.on('completed', (job) => {
    console.log(`[build] Job ${job.id} completed`)
  })

  return worker
}
