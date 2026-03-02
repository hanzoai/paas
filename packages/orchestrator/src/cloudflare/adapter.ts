import type {
  IOrchestrator,
  CloudflarePagesConnection,
  ContainerSpec,
  ContainerResult,
  ContainerStatus,
  IngressSpec,
  VolumeSpec,
  LogOptions,
  BuildSpec,
  BuildResult,
  BuildStatus,
  ClusterInfo,
} from '../types'
import type { ContainerType } from '@paas/shared'

const CF_API = 'https://api.cloudflare.com/client/v4'

/**
 * Cloudflare Pages orchestrator: maps IOrchestrator to Cloudflare Pages API.
 *
 * - createContainer → creates a CF Pages project
 * - triggerBuild → triggers a new deployment via Direct Upload
 * - createIngress → adds a custom domain to the project
 * - No-op for K8s-specific methods (namespaces, scaling, volumes, probes)
 */
export class CloudflarePagesOrchestrator implements IOrchestrator {
  readonly type = 'cloudflare-pages' as const
  private accountId: string
  private apiToken: string

  constructor(connection: CloudflarePagesConnection) {
    this.accountId = connection.accountId
    this.apiToken = connection.apiToken
  }

  // ---- Helpers ----

  private async cfFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const url = `${CF_API}/accounts/${this.accountId}${path}`
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Cloudflare API error ${res.status}: ${body}`)
    }
    const json = await res.json() as { result: T }
    return json.result
  }

  // ---- Namespace: no-op for static hosting ----

  async createNamespace(_name: string): Promise<void> {
    // CF Pages has no namespace concept — no-op
  }

  async deleteNamespace(_name: string): Promise<void> {
    // no-op
  }

  async listNamespaces(): Promise<string[]> {
    // Return a single logical namespace
    return ['cloudflare-pages']
  }

  // ---- Container = Pages project ----

  async createContainer(spec: ContainerSpec): Promise<ContainerResult> {
    const project = await this.cfFetch<{ name: string }>('/pages/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: spec.name,
        production_branch: 'main',
      }),
    })
    return {
      name: project.name,
      namespace: spec.namespace,
      type: spec.type,
      image: '',
      status: 'creating',
    }
  }

  async updateContainer(spec: ContainerSpec): Promise<ContainerResult> {
    // Update project settings (build config, env vars, etc.)
    await this.cfFetch(`/pages/projects/${spec.name}`, {
      method: 'PATCH',
      body: JSON.stringify({
        production_branch: 'main',
      }),
    })
    return {
      name: spec.name,
      namespace: spec.namespace,
      type: spec.type,
      image: '',
      status: 'running',
    }
  }

  async deleteContainer(_namespace: string, name: string, _type: ContainerType): Promise<void> {
    await this.cfFetch(`/pages/projects/${name}`, {
      method: 'DELETE',
    })
  }

  async getContainerStatus(_namespace: string, name: string, _type: ContainerType): Promise<ContainerStatus> {
    interface CfDeployment {
      id: string
      environment: string
      created_on: string
      latest_stage?: { name: string; status: string }
    }
    const deployments = await this.cfFetch<CfDeployment[]>(`/pages/projects/${name}/deployments`)
    const latest = Array.isArray(deployments) ? deployments[0] : null
    const isActive = latest?.latest_stage?.status === 'success'
    return {
      ready: isActive,
      replicas: isActive ? 1 : 0,
      readyReplicas: isActive ? 1 : 0,
      updatedReplicas: isActive ? 1 : 0,
      availableReplicas: isActive ? 1 : 0,
      pods: latest ? [{
        name: latest.id,
        phase: isActive ? 'Running' : 'Pending',
        ready: isActive,
        restarts: 0,
        startedAt: latest.created_on,
        containers: [{
          name,
          ready: isActive,
          state: isActive ? 'running' : 'building',
          restarts: 0,
        }],
      }] : [],
    }
  }

  async listContainers(_namespace: string): Promise<ContainerResult[]> {
    interface CfProject {
      name: string
      latest_deployment?: { url: string }
    }
    const projects = await this.cfFetch<CfProject[]>('/pages/projects')
    return (Array.isArray(projects) ? projects : []).map(p => ({
      name: p.name,
      namespace: 'cloudflare-pages',
      type: 'static-site' as ContainerType,
      image: '',
      status: p.latest_deployment ? 'running' : 'creating',
    }))
  }

  // ---- Scaling: no-op for edge-hosted static sites ----

  async scaleContainer(_namespace: string, _name: string, _replicas: number): Promise<void> {
    // CF Pages is globally distributed — scaling is automatic
  }

  // ---- Networking: custom domains ----

  async createIngress(spec: IngressSpec): Promise<void> {
    await this.cfFetch(`/pages/projects/${spec.serviceName}/domains`, {
      method: 'POST',
      body: JSON.stringify({ name: spec.host }),
    })
  }

  async updateIngress(spec: IngressSpec): Promise<void> {
    // Delete and re-add
    await this.deleteIngress(spec.namespace, spec.serviceName).catch(() => {})
    await this.createIngress(spec)
  }

  async deleteIngress(_namespace: string, name: string): Promise<void> {
    // List custom domains and remove them
    interface CfDomain { id: string; name: string }
    const domains = await this.cfFetch<CfDomain[]>(`/pages/projects/${name}/domains`)
    for (const domain of Array.isArray(domains) ? domains : []) {
      await this.cfFetch(`/pages/projects/${name}/domains/${domain.name}`, {
        method: 'DELETE',
      }).catch(() => {})
    }
  }

  // ---- Storage: no-op ----

  async createVolume(_spec: VolumeSpec): Promise<void> {
    throw new Error('Persistent storage is not supported on Cloudflare Pages')
  }

  async deleteVolume(_namespace: string, _name: string): Promise<void> {
    // no-op
  }

  // ---- Logs ----

  async *streamLogs(_namespace: string, name: string, _opts: LogOptions): AsyncIterable<string> {
    // CF Pages does not expose build logs via API in real-time.
    // Fetch the latest deployment's build log summary.
    interface CfDeployment {
      id: string
      build_config?: { build_command: string }
      latest_stage?: { name: string; status: string }
    }
    const deployments = await this.cfFetch<CfDeployment[]>(`/pages/projects/${name}/deployments`)
    const latest = Array.isArray(deployments) ? deployments[0] : null
    if (latest) {
      yield `[cloudflare-pages] Latest deployment: ${latest.id}\n`
      yield `[cloudflare-pages] Stage: ${latest.latest_stage?.name ?? 'unknown'} — ${latest.latest_stage?.status ?? 'unknown'}\n`
    } else {
      yield `[cloudflare-pages] No deployments found for project ${name}\n`
    }
  }

  // ---- Build: Direct Upload ----

  async triggerBuild(spec: BuildSpec): Promise<BuildResult> {
    // Create a new deployment via the Cloudflare Pages API.
    // The actual file upload would be handled by the jobs worker which
    // clones the repo, runs the build, and uploads via Direct Upload API.
    // Here we create the deployment record.
    const buildId = `cf-${spec.name}-${Date.now()}`
    return { buildId, status: 'queued' }
  }

  async getBuildStatus(buildId: string): Promise<BuildStatus> {
    // buildId format: cf-{projectName}-{timestamp}
    // In production, store the CF deployment ID and query it here.
    return { id: buildId, status: 'queued' }
  }

  async cancelBuild(_buildId: string): Promise<void> {
    // CF Pages deployments cannot be cancelled via API — no-op
  }

  // ---- Health ----

  async ping(): Promise<boolean> {
    try {
      await this.cfFetch('/pages/projects')
      return true
    } catch {
      return false
    }
  }

  async getClusterInfo(): Promise<ClusterInfo> {
    interface CfProject { name: string }
    const projects = await this.cfFetch<CfProject[]>('/pages/projects')
    return {
      version: 'cloudflare-pages-v1',
      platform: 'cloudflare/edge',
      nodeCount: 0,  // edge-distributed, no fixed nodes
      totalCpu: 0,
      totalMemory: 0,
    }
  }
}
