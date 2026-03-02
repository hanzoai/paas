import { pgTable, text, timestamp, boolean, jsonb, pgEnum } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { organizations } from './organizations'
import { projects } from './projects'
import { environments } from './environments'
import { clusters } from './clusters'
import { users } from './users'
import type {
  NetworkingConfig,
  PodConfig,
  StorageConfig,
  DeploymentStrategyConfig,
  StatefulSetConfig,
  CronJobConfig,
  ProbesConfig,
  RepoConfig,
  RegistryConfig,
  StaticSiteConfig,
} from '@paas/shared'

export const containerTypeEnum = pgEnum('container_type', ['deployment', 'statefulset', 'cronjob', 'static-site'])
export const sourceTypeEnum = pgEnum('source_type', ['repo', 'registry'])

export const containers = pgTable('containers', {
  id:              text('id').primaryKey().$defaultFn(() => createId()),
  iid:             text('iid').notNull().unique(),
  slug:            text('slug').notNull().unique(),
  name:            text('name').notNull(),
  type:            containerTypeEnum('type').notNull(),

  // Hierarchy
  orgId:           text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  projectId:       text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  environmentId:   text('environment_id').notNull().references(() => environments.id, { onDelete: 'cascade' }),
  clusterId:       text('cluster_id').notNull().references(() => clusters.id),

  // Source
  sourceType:      sourceTypeEnum('source_type').notNull().default('repo'),
  repoConfig:      jsonb('repo_config').$type<RepoConfig | null>(),
  registryConfig:  jsonb('registry_config').$type<RegistryConfig | null>(),

  // Runtime configuration (JSONB — deeply nested, schema flexibility matters)
  networking:      jsonb('networking').$type<NetworkingConfig>(),
  podConfig:       jsonb('pod_config').$type<PodConfig>(),
  storageConfig:   jsonb('storage_config').$type<StorageConfig>(),
  deploymentConfig: jsonb('deployment_config').$type<DeploymentStrategyConfig>(),
  statefulSetConfig: jsonb('stateful_set_config').$type<StatefulSetConfig>(),
  cronJobConfig:   jsonb('cron_job_config').$type<CronJobConfig>(),
  staticSiteConfig: jsonb('static_site_config').$type<StaticSiteConfig | null>(),
  probes:          jsonb('probes').$type<ProbesConfig>(),
  variables:       jsonb('variables').$type<Array<{ name: string; value: string }>>(),

  // Template (for marketplace deploys)
  templateName:    text('template_name'),
  templateVersion: text('template_version'),

  // Status
  status:          jsonb('status'),                        // Live status from orchestrator
  pipelineStatus:  text('pipeline_status'),

  // Metadata
  isClusterEntity: boolean('is_cluster_entity').notNull().default(false),
  createdBy:       text('created_by').references(() => users.id),
  updatedBy:       text('updated_by').references(() => users.id),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
