import type {
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
  ContainerType,
} from '@paas/shared'

export type { ContainerSpec, ContainerResult, ContainerStatus }
export type { IngressSpec, VolumeSpec, LogOptions }
export type { BuildSpec, BuildResult, BuildStatus, ClusterInfo }

// ---- Connection types ----

export interface K8sConnection {
  kind: 'kubernetes'
  kubeconfig: string
}

export interface DockerConnection {
  kind: 'docker'
  host: string        // unix:///var/run/docker.sock or tcp://192.168.1.100:2376
  tlsCert?: string
  tlsKey?: string
  tlsCa?: string
}

export interface CloudflarePagesConnection {
  kind: 'cloudflare-pages'
  accountId: string       // Cloudflare account ID
  apiToken: string        // Cloudflare API token (scoped to Pages)
}

export interface GitHubPagesConnection {
  kind: 'github-pages'
  token: string           // GitHub personal access token or app token
  owner: string           // GitHub user or org
}

export type OrchestratorConnection = K8sConnection | DockerConnection | CloudflarePagesConnection | GitHubPagesConnection

export interface OrchestratorConfig {
  clusterType: 'kubernetes' | 'docker-swarm' | 'docker-compose' | 'cloudflare-pages' | 'github-pages'
  connection: OrchestratorConnection
}

// ---- The core abstraction: one interface, multiple backends ----

export interface IOrchestrator {
  readonly type: 'kubernetes' | 'docker-swarm' | 'docker-compose' | 'cloudflare-pages' | 'github-pages'

  // Namespace / network isolation
  createNamespace(name: string): Promise<void>
  deleteNamespace(name: string): Promise<void>
  listNamespaces(): Promise<string[]>

  // Container lifecycle
  createContainer(spec: ContainerSpec): Promise<ContainerResult>
  updateContainer(spec: ContainerSpec): Promise<ContainerResult>
  deleteContainer(namespace: string, name: string, type: ContainerType): Promise<void>
  getContainerStatus(namespace: string, name: string, type: ContainerType): Promise<ContainerStatus>
  listContainers(namespace: string): Promise<ContainerResult[]>

  // Scaling
  scaleContainer(namespace: string, name: string, replicas: number): Promise<void>

  // Networking
  createIngress(spec: IngressSpec): Promise<void>
  updateIngress(spec: IngressSpec): Promise<void>
  deleteIngress(namespace: string, name: string): Promise<void>

  // Storage
  createVolume(spec: VolumeSpec): Promise<void>
  deleteVolume(namespace: string, name: string): Promise<void>

  // Logs
  streamLogs(namespace: string, name: string, opts: LogOptions): AsyncIterable<string>

  // Build
  triggerBuild(spec: BuildSpec): Promise<BuildResult>
  getBuildStatus(buildId: string): Promise<BuildStatus>
  cancelBuild(buildId: string): Promise<void>

  // Health
  ping(): Promise<boolean>
  getClusterInfo(): Promise<ClusterInfo>
}
