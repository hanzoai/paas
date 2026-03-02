export const CLUSTER_TYPES = ['kubernetes', 'docker-swarm', 'docker-compose', 'cloudflare-pages', 'github-pages'] as const
export type ClusterType = (typeof CLUSTER_TYPES)[number]

export const CLUSTER_PROVIDERS = ['digitalocean', 'aws', 'gcp', 'azure', 'hetzner', 'bare-metal', 'local', 'cloudflare', 'github'] as const
export type ClusterProvider = (typeof CLUSTER_PROVIDERS)[number]

export const CONTAINER_TYPES = ['deployment', 'statefulset', 'cronjob', 'static-site'] as const
export type ContainerType = (typeof CONTAINER_TYPES)[number]

export const SOURCE_TYPES = ['repo', 'registry'] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

export const DEPLOY_STATUSES = ['queued', 'building', 'pushing', 'deploying', 'running', 'failed', 'cancelled'] as const
export type DeployStatus = (typeof DEPLOY_STATUSES)[number]

export const TRIGGER_TYPES = ['manual', 'git-push', 'webhook', 'rollback', 'schedule'] as const
export type TriggerType = (typeof TRIGGER_TYPES)[number]

export const GIT_PROVIDERS = ['github', 'gitlab', 'bitbucket'] as const
export type GitProviderType = (typeof GIT_PROVIDERS)[number]

export const REGISTRY_TYPES = ['ECR', 'ACR', 'GCR', 'GAR', 'Quay', 'GHCR', 'Docker', 'Custom', 'Public'] as const
export type RegistryType = (typeof REGISTRY_TYPES)[number]

export const ORG_ROLES = ['Owner', 'Admin', 'Developer', 'Billing', 'Viewer'] as const
export type OrgRole = (typeof ORG_ROLES)[number]

// Ordered hierarchy: lower index = higher privilege
const ORG_ROLE_RANK: Record<OrgRole, number> = { Owner: 0, Admin: 1, Developer: 2, Billing: 3, Viewer: 4 }

/** Returns true if `role` is at least as privileged as `minRole`. */
export function isOrgRoleAtLeast(role: OrgRole, minRole: OrgRole): boolean {
  return ORG_ROLE_RANK[role] <= ORG_ROLE_RANK[minRole]
}

export const PROJECT_ROLES = ['Owner', 'Admin', 'Developer', 'Viewer'] as const
export type ProjectRole = (typeof PROJECT_ROLES)[number]

export const CLUSTER_STATUSES = ['provisioning', 'running', 'error', 'destroying', 'offline'] as const
export type ClusterStatus = (typeof CLUSTER_STATUSES)[number]
