import { Worker, type Job } from '@hanzo/mq'
import { eq } from 'drizzle-orm'
import { db } from '@paas/db/client'
import { containers, clusters, deployments } from '@paas/db/schema'
import { createOrchestrator, type K8sConnection, type DockerConnection, type CloudflarePagesConnection, type GitHubPagesConnection } from '@paas/orchestrator'
import type { ContainerSpec } from '@paas/shared'
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

export interface DeployJobData {
  containerId: string
  /** If set, this is a redeploy tied to an existing deployment record. */
  deploymentId?: string
  /** 'create' for first deploy, 'update' for subsequent. */
  action: 'create' | 'update'
}

// ---- Worker processor ----

async function processDeploy(job: Job<DeployJobData>): Promise<void> {
  const { containerId, deploymentId, action } = job.data

  // 1. Load container + cluster
  const container = await db.query.containers.findFirst({
    where: eq(containers.id, containerId),
  })
  if (!container) throw new Error(`Container not found: ${containerId}`)

  const cluster = await db.query.clusters.findFirst({
    where: eq(clusters.id, container.clusterId),
  })
  if (!cluster) throw new Error(`Cluster not found: ${container.clusterId}`)

  // 2. Mark pipeline status
  await db
    .update(containers)
    .set({ pipelineStatus: 'deploying', updatedAt: new Date() })
    .where(eq(containers.id, containerId))

  if (deploymentId) {
    await db
      .update(deployments)
      .set({ status: 'deploying' })
      .where(eq(deployments.id, deploymentId))
  }

  // 3. Build orchestrator
  const orchestrator = orchestratorFromCluster(cluster)

  // 4. Build ContainerSpec from DB record
  const registryConfig = container.registryConfig as { imageName?: string; imageTag?: string } | null
  const image = registryConfig
    ? `${registryConfig.imageName ?? container.slug}:${registryConfig.imageTag ?? 'latest'}`
    : `${container.slug}:latest`

  const spec: ContainerSpec = {
    namespace: container.iid, // environment iid is the K8s namespace
    name: container.slug,
    type: container.type,
    image,
    variables: (container.variables as Array<{ name: string; value: string }>) ?? [],
    networking: (container.networking ?? { containerPort: 8080 }) as ContainerSpec['networking'],
    podConfig: (container.podConfig ?? { cpuRequest: 100, cpuLimit: 1000, memoryRequest: 128, memoryLimit: 1024, restartPolicy: 'Always' }) as ContainerSpec['podConfig'],
    storageConfig: container.storageConfig as ContainerSpec['storageConfig'],
    deploymentConfig: container.deploymentConfig as ContainerSpec['deploymentConfig'],
    statefulSetConfig: container.statefulSetConfig as ContainerSpec['statefulSetConfig'],
    cronJobConfig: container.cronJobConfig as ContainerSpec['cronJobConfig'],
    staticSiteConfig: container.staticSiteConfig as ContainerSpec['staticSiteConfig'],
    probes: container.probes as ContainerSpec['probes'],
  }

  try {
    // 5. Create or update
    const result = action === 'create'
      ? await orchestrator.createContainer(spec)
      : await orchestrator.updateContainer(spec)

    // 6. Update DB with live status
    await db
      .update(containers)
      .set({
        pipelineStatus: 'running',
        status: { ready: true, image: result.image, status: result.status },
        updatedAt: new Date(),
      })
      .where(eq(containers.id, containerId))

    if (deploymentId) {
      await db
        .update(deployments)
        .set({ status: 'running', finishedAt: new Date() })
        .where(eq(deployments.id, deploymentId))
    }

    console.log(`[deploy] ${action} container ${container.slug}: ${result.status}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    await db
      .update(containers)
      .set({ pipelineStatus: 'failed', updatedAt: new Date() })
      .where(eq(containers.id, containerId))

    if (deploymentId) {
      await db
        .update(deployments)
        .set({
          status: 'failed',
          deployLogs: `Deploy failed: ${message}`,
          finishedAt: new Date(),
        })
        .where(eq(deployments.id, deploymentId))
    }

    throw err
  }
}

// ---- Worker factory ----

export function createDeployWorker(): Worker<DeployJobData> {
  const worker = new Worker<DeployJobData>('deploy', processDeploy, {
    connection,
    concurrency: 10,
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  })

  worker.on('failed', (job, err) => {
    console.error(`[deploy] Job ${job?.id} failed: ${err.message}`)
  })

  worker.on('completed', (job) => {
    console.log(`[deploy] Job ${job.id} completed`)
  })

  return worker
}
