import { Worker, type Job } from '@hanzo/mq'
import { eq, isNotNull } from 'drizzle-orm'
import { db } from '@paas/db/client'
import { containers, clusters } from '@paas/db/schema'
import {
  createOrchestrator,
  type K8sConnection,
  type DockerConnection,
  type CloudflarePagesConnection,
  type GitHubPagesConnection,
  type IOrchestrator,
} from '@paas/orchestrator'
import { connection, monitorQueue } from '../queues'

// ---- Job payload ----

export interface MonitorJobData {
  /** If set, poll only this container. If omitted, poll all active containers. */
  containerId?: string
}

// ---- Orchestrator cache (avoid re-creating per poll) ----

const orchestratorCache = new Map<string, IOrchestrator>()

function getOrCreateOrchestrator(cluster: {
  id: string
  type: 'kubernetes' | 'docker-swarm' | 'docker-compose' | 'cloudflare-pages' | 'github-pages'
  kubeconfig: string | null
  endpoint: string | null
  tlsCert: string | null
  tlsKey: string | null
  tlsCa: string | null
  cloudMeta: unknown
}): IOrchestrator {
  const cached = orchestratorCache.get(cluster.id)
  if (cached) return cached

  let orch: IOrchestrator

  switch (cluster.type) {
    case 'kubernetes':
      orch = createOrchestrator({
        clusterType: 'kubernetes',
        connection: { kind: 'kubernetes', kubeconfig: cluster.kubeconfig ?? '' } satisfies K8sConnection,
      })
      break
    case 'docker-swarm':
    case 'docker-compose':
      orch = createOrchestrator({
        clusterType: cluster.type,
        connection: { kind: 'docker', host: cluster.endpoint ?? '', tlsCert: cluster.tlsCert ?? undefined, tlsKey: cluster.tlsKey ?? undefined, tlsCa: cluster.tlsCa ?? undefined } satisfies DockerConnection,
      })
      break
    case 'cloudflare-pages': {
      const meta = cluster.cloudMeta as { accountId?: string; apiToken?: string } | null
      orch = createOrchestrator({
        clusterType: 'cloudflare-pages',
        connection: { kind: 'cloudflare-pages', accountId: meta?.accountId ?? '', apiToken: meta?.apiToken ?? '' } satisfies CloudflarePagesConnection,
      })
      break
    }
    case 'github-pages': {
      const meta = cluster.cloudMeta as { token?: string; owner?: string } | null
      orch = createOrchestrator({
        clusterType: 'github-pages',
        connection: { kind: 'github-pages', token: meta?.token ?? '', owner: meta?.owner ?? '' } satisfies GitHubPagesConnection,
      })
      break
    }
    default:
      throw new Error(`Unsupported cluster type: ${cluster.type}`)
  }

  orchestratorCache.set(cluster.id, orch)
  return orch
}

// ---- Worker processor ----

async function processMonitor(job: Job<MonitorJobData>): Promise<void> {
  const { containerId } = job.data

  // Load containers to poll
  const targetContainers = containerId
    ? await db.query.containers.findMany({
        where: eq(containers.id, containerId),
      })
    : await db.query.containers.findMany({
        where: isNotNull(containers.pipelineStatus),
      })

  if (targetContainers.length === 0) return

  // Group by cluster to batch orchestrator calls
  const byCluster = new Map<string, typeof targetContainers>()
  for (const c of targetContainers) {
    const list = byCluster.get(c.clusterId) ?? []
    list.push(c)
    byCluster.set(c.clusterId, list)
  }

  for (const [clusterId, clusterContainers] of byCluster) {
    const cluster = await db.query.clusters.findFirst({
      where: eq(clusters.id, clusterId),
    })
    if (!cluster) {
      console.warn(`[monitor] Cluster not found: ${clusterId}, skipping ${clusterContainers.length} containers`)
      continue
    }

    let orchestrator: IOrchestrator
    try {
      orchestrator = getOrCreateOrchestrator(cluster)
    } catch (err) {
      console.error(`[monitor] Failed to create orchestrator for cluster ${clusterId}: ${err}`)
      continue
    }

    for (const container of clusterContainers) {
      try {
        const status = await orchestrator.getContainerStatus(
          container.iid, // namespace (environment iid)
          container.slug,
          container.type,
        )

        await db
          .update(containers)
          .set({
            status: status as any,
            updatedAt: new Date(),
          })
          .where(eq(containers.id, container.id))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`[monitor] Failed to poll ${container.slug}: ${message}`)

        // Write error status so UI can display it
        await db
          .update(containers)
          .set({
            status: { error: message, polledAt: new Date().toISOString() },
            updatedAt: new Date(),
          })
          .where(eq(containers.id, container.id))
      }
    }
  }
}

// ---- Worker factory ----

export function createMonitorWorker(): Worker<MonitorJobData> {
  const worker = new Worker<MonitorJobData>('monitor', processMonitor, {
    connection,
    concurrency: 1, // single-threaded monitor to avoid stampeding
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 50 },
  })

  worker.on('failed', (job, err) => {
    console.error(`[monitor] Job ${job?.id} failed: ${err.message}`)
  })

  return worker
}

/**
 * Register the repeatable monitor job (every 30s).
 * Call once at startup. Idempotent -- BullMQ deduplicates by repeat key.
 */
export async function registerMonitorSchedule(): Promise<void> {
  await monitorQueue.upsertJobScheduler(
    'monitor-all',
    { every: 30_000 },
    { data: {} },
  )
  console.log('[monitor] Repeatable schedule registered: every 30s')
}
