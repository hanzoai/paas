import { Octokit } from '@octokit/core'
import type {
  IOrchestrator,
  GitHubPagesConnection,
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

/**
 * GitHub Pages orchestrator: maps IOrchestrator to GitHub REST API.
 *
 * - createContainer → enables GitHub Pages on a repository
 * - triggerBuild → triggers a Pages deployment via workflow dispatch
 * - createIngress → sets a custom domain (CNAME)
 * - No-op for K8s-specific methods (namespaces, scaling, volumes, probes)
 */
export class GitHubPagesOrchestrator implements IOrchestrator {
  readonly type = 'github-pages' as const
  private octokit: Octokit
  private owner: string

  constructor(connection: GitHubPagesConnection) {
    this.octokit = new Octokit({ auth: connection.token })
    this.owner = connection.owner
  }

  // ---- Namespace: no-op for GitHub Pages ----

  async createNamespace(_name: string): Promise<void> {
    // GitHub Pages has no namespace concept — no-op
  }

  async deleteNamespace(_name: string): Promise<void> {
    // no-op
  }

  async listNamespaces(): Promise<string[]> {
    return ['github-pages']
  }

  // ---- Container = GitHub Pages site ----

  async createContainer(spec: ContainerSpec): Promise<ContainerResult> {
    const repo = spec.name

    // Enable GitHub Pages on the repo using the "gh-pages" branch
    // First, ensure the repo exists (caller is responsible for repo creation)
    try {
      await this.octokit.request('POST /repos/{owner}/{repo}/pages', {
        owner: this.owner,
        repo,
        build_type: 'workflow',
        source: {
          branch: 'gh-pages',
          path: '/',
        },
      })
    } catch (err: unknown) {
      // 409 means Pages is already enabled
      if (err instanceof Error && 'status' in err && (err as any).status === 409) {
        // already enabled — that's fine
      } else {
        throw err
      }
    }

    return {
      name: repo,
      namespace: spec.namespace,
      type: spec.type,
      image: '',
      status: 'creating',
    }
  }

  async updateContainer(spec: ContainerSpec): Promise<ContainerResult> {
    const repo = spec.name
    // Update Pages configuration
    await this.octokit.request('PUT /repos/{owner}/{repo}/pages', {
      owner: this.owner,
      repo,
      build_type: 'workflow',
      source: {
        branch: 'gh-pages',
        path: '/',
      },
    })
    return {
      name: repo,
      namespace: spec.namespace,
      type: spec.type,
      image: '',
      status: 'running',
    }
  }

  async deleteContainer(_namespace: string, name: string, _type: ContainerType): Promise<void> {
    await this.octokit.request('DELETE /repos/{owner}/{repo}/pages', {
      owner: this.owner,
      repo: name,
    }).catch(() => {})
  }

  async getContainerStatus(_namespace: string, name: string, _type: ContainerType): Promise<ContainerStatus> {
    interface GhPagesInfo {
      status: string | null
      url: string
    }
    try {
      const res = await this.octokit.request('GET /repos/{owner}/{repo}/pages', {
        owner: this.owner,
        repo: name,
      })
      const pages = res.data as GhPagesInfo
      const isBuilt = pages.status === 'built'
      return {
        ready: isBuilt,
        replicas: isBuilt ? 1 : 0,
        readyReplicas: isBuilt ? 1 : 0,
        updatedReplicas: isBuilt ? 1 : 0,
        availableReplicas: isBuilt ? 1 : 0,
        pods: [{
          name: `${name}-pages`,
          phase: isBuilt ? 'Running' : 'Pending',
          ready: isBuilt,
          restarts: 0,
          containers: [{
            name,
            ready: isBuilt,
            state: isBuilt ? 'running' : 'building',
            restarts: 0,
          }],
        }],
      }
    } catch {
      return {
        ready: false,
        replicas: 0,
        readyReplicas: 0,
        updatedReplicas: 0,
        availableReplicas: 0,
        pods: [],
      }
    }
  }

  async listContainers(_namespace: string): Promise<ContainerResult[]> {
    // List repos belonging to the owner that have Pages enabled
    const res = await this.octokit.request('GET /users/{username}/repos', {
      username: this.owner,
      per_page: 100,
    })
    const repos = res.data as Array<{ name: string; has_pages: boolean }>
    return repos
      .filter(r => r.has_pages)
      .map(r => ({
        name: r.name,
        namespace: 'github-pages',
        type: 'static-site' as ContainerType,
        image: '',
        status: 'running',
      }))
  }

  // ---- Scaling: no-op ----

  async scaleContainer(_namespace: string, _name: string, _replicas: number): Promise<void> {
    // GitHub Pages is a static host — no scaling concept
  }

  // ---- Networking: custom domain ----

  async createIngress(spec: IngressSpec): Promise<void> {
    await this.octokit.request('PUT /repos/{owner}/{repo}/pages', {
      owner: this.owner,
      repo: spec.serviceName,
      cname: spec.host,
      build_type: 'workflow',
      source: {
        branch: 'gh-pages',
        path: '/',
      },
    })
  }

  async updateIngress(spec: IngressSpec): Promise<void> {
    await this.createIngress(spec)
  }

  async deleteIngress(_namespace: string, name: string): Promise<void> {
    // Remove custom domain by setting cname to empty
    await this.octokit.request('PUT /repos/{owner}/{repo}/pages', {
      owner: this.owner,
      repo: name,
      cname: '',
      build_type: 'workflow',
      source: {
        branch: 'gh-pages',
        path: '/',
      },
    }).catch(() => {})
  }

  // ---- Storage: not supported ----

  async createVolume(_spec: VolumeSpec): Promise<void> {
    throw new Error('Persistent storage is not supported on GitHub Pages')
  }

  async deleteVolume(_namespace: string, _name: string): Promise<void> {
    // no-op
  }

  // ---- Logs ----

  async *streamLogs(_namespace: string, name: string, _opts: LogOptions): AsyncIterable<string> {
    // Fetch latest Pages build via the deployments API
    interface GhDeployment {
      id: number
      status: string
      created_at: string
    }
    try {
      const res = await this.octokit.request('GET /repos/{owner}/{repo}/pages/deployments', {
        owner: this.owner,
        repo: name,
        per_page: 5,
      })
      const deployments = res.data as GhDeployment[]
      if (Array.isArray(deployments) && deployments.length > 0) {
        for (const d of deployments) {
          yield `[github-pages] Deployment ${d.id}: ${d.status} (${d.created_at})\n`
        }
      } else {
        yield `[github-pages] No deployments found for ${this.owner}/${name}\n`
      }
    } catch {
      yield `[github-pages] Could not fetch deployment logs for ${this.owner}/${name}\n`
    }
  }

  // ---- Build ----

  async triggerBuild(spec: BuildSpec): Promise<BuildResult> {
    // Trigger a Pages deployment by dispatching a workflow or creating a deployment.
    // The actual build (clone repo, install, build, push to gh-pages branch)
    // is handled by the jobs worker. Here we just record the intent.
    const buildId = `gh-${spec.name}-${Date.now()}`
    return { buildId, status: 'queued' }
  }

  async getBuildStatus(buildId: string): Promise<BuildStatus> {
    return { id: buildId, status: 'queued' }
  }

  async cancelBuild(_buildId: string): Promise<void> {
    // GitHub Pages builds cannot be cancelled — no-op
  }

  // ---- Health ----

  async ping(): Promise<boolean> {
    try {
      await this.octokit.request('GET /user')
      return true
    } catch {
      return false
    }
  }

  async getClusterInfo(): Promise<ClusterInfo> {
    return {
      version: 'github-pages-v1',
      platform: 'github/cdn',
      nodeCount: 0,
      totalCpu: 0,
      totalMemory: 0,
    }
  }
}
