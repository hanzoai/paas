import type { ContainerType } from './constants'

// ---- Container configuration types (stored as JSONB in PostgreSQL) ----

export interface NetworkingConfig {
  containerPort: number
  ingress?: {
    enabled: boolean
    type?: 'path' | 'subdomain'
  }
  customDomain?: string
  tcpProxy?: {
    enabled: boolean
    publicPort?: number
  }
}

export interface PodConfig {
  cpuRequest: number     // millicores (e.g. 100 = 0.1 CPU)
  cpuLimit: number
  memoryRequest: number  // MiB
  memoryLimit: number
  restartPolicy: 'Always' | 'OnFailure' | 'Never'
}

export interface StorageConfig {
  enabled: boolean
  size?: number          // GiB
  mountPath?: string
  storageClass?: string
}

export interface DeploymentStrategyConfig {
  replicas: number
  strategy: 'RollingUpdate' | 'Recreate'
  maxSurge?: number
  maxUnavailable?: number
  minReadySeconds?: number
}

export interface StatefulSetConfig {
  replicas: number
  podManagementPolicy: 'OrderedReady' | 'Parallel'
  persistentVolumeClaimRetentionPolicy?: {
    whenDeleted: 'Retain' | 'Delete'
    whenScaled: 'Retain' | 'Delete'
  }
}

export interface CronJobConfig {
  schedule: string       // cron expression
  concurrencyPolicy: 'Allow' | 'Forbid' | 'Replace'
  suspend: boolean
  successfulJobsHistoryLimit: number
  failedJobsHistoryLimit: number
}

export interface StaticSiteConfig {
  buildCommand: string           // e.g., "npm run build"
  outputDir: string              // e.g., "dist" or "build"
  installCommand?: string        // e.g., "npm install"
  nodeVersion?: string           // e.g., "20"
  framework?: string             // e.g., "nextjs", "vite", "astro"
  envVars?: Record<string, string>
}

export interface ProbeConfig {
  enabled: boolean
  type: 'httpGet' | 'tcpSocket' | 'exec'
  httpPath?: string
  port?: number
  command?: string[]
  initialDelaySeconds: number
  periodSeconds: number
  timeoutSeconds: number
  failureThreshold: number
  successThreshold: number
}

export interface ProbesConfig {
  startup?: ProbeConfig
  liveness?: ProbeConfig
  readiness?: ProbeConfig
}

export interface RepoConfig {
  provider?: string        // github | gitlab | bitbucket
  url?: string
  branch?: string
  path?: string            // subpath in repo
  dockerfile?: string      // default: Dockerfile
  gitProviderId?: string
  webHookId?: string
  watchPaths?: string[]    // only rebuild if changes in these paths
  testEnabled?: boolean
  testImage?: string
  testCommand?: string
}

export interface RegistryConfig {
  registryId?: string
  imageName: string
  imageTag: string
}

// ---- Orchestrator types ----

export interface ContainerSpec {
  namespace: string
  name: string
  type: ContainerType
  image: string
  variables: Array<{ name: string; value: string }>
  networking: NetworkingConfig
  podConfig: PodConfig
  storageConfig?: StorageConfig
  deploymentConfig?: DeploymentStrategyConfig
  statefulSetConfig?: StatefulSetConfig
  cronJobConfig?: CronJobConfig
  staticSiteConfig?: StaticSiteConfig
  probes?: ProbesConfig
}

export interface ContainerResult {
  name: string
  namespace: string
  type: ContainerType
  image: string
  status: string
}

export interface ContainerStatus {
  ready: boolean
  replicas: number
  readyReplicas: number
  updatedReplicas: number
  availableReplicas: number
  pods: PodStatus[]
}

export interface PodStatus {
  name: string
  phase: string     // Running, Pending, Succeeded, Failed, Unknown
  ready: boolean
  restarts: number
  startedAt?: string
  containers: PodContainerStatus[]
}

export interface PodContainerStatus {
  name: string
  ready: boolean
  state: string
  restarts: number
}

export interface IngressSpec {
  namespace: string
  name: string
  host: string
  path?: string
  serviceName: string
  servicePort: number
  tls?: boolean
  annotations?: Record<string, string>
}

export interface VolumeSpec {
  namespace: string
  name: string
  size: string         // e.g., "10Gi"
  storageClass?: string
  accessModes?: string[]
}

export interface LogOptions {
  follow?: boolean
  tail?: number
  since?: string
  timestamps?: boolean
  container?: string
}

export interface BuildSpec {
  containerId: string
  namespace: string
  name: string
  repo: RepoConfig
  registry: string
  imageName: string
  commitSha?: string
}

export interface BuildResult {
  buildId: string
  status: string
  imageTag?: string
}

export interface BuildStatus {
  id: string
  status: string       // queued, building, pushing, succeeded, failed, cancelled
  logs?: string
  imageTag?: string
  startedAt?: string
  finishedAt?: string
  duration?: number
}

export interface ClusterInfo {
  version: string
  platform: string     // e.g., "linux/amd64"
  nodeCount: number
  totalCpu: number     // millicores
  totalMemory: number  // MiB
}
