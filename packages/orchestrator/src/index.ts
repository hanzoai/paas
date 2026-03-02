import { K8sOrchestrator } from './k8s/adapter'
import { DockerOrchestrator } from './docker/adapter'
import { CloudflarePagesOrchestrator } from './cloudflare/adapter'
import { GitHubPagesOrchestrator } from './github-pages/adapter'
import type {
  IOrchestrator,
  OrchestratorConfig,
  K8sConnection,
  DockerConnection,
  CloudflarePagesConnection,
  GitHubPagesConnection,
} from './types'

export function createOrchestrator(config: OrchestratorConfig): IOrchestrator {
  switch (config.clusterType) {
    case 'kubernetes':
      return new K8sOrchestrator(config.connection as K8sConnection)
    case 'docker-swarm':
    case 'docker-compose':
      return new DockerOrchestrator(config.connection as DockerConnection, config.clusterType)
    case 'cloudflare-pages':
      return new CloudflarePagesOrchestrator(config.connection as CloudflarePagesConnection)
    case 'github-pages':
      return new GitHubPagesOrchestrator(config.connection as GitHubPagesConnection)
    default:
      throw new Error(`Unknown cluster type: ${config.clusterType}`)
  }
}

export type {
  IOrchestrator,
  OrchestratorConfig,
  K8sConnection,
  DockerConnection,
  CloudflarePagesConnection,
  GitHubPagesConnection,
} from './types'
