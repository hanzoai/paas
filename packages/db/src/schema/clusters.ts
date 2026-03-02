import { pgTable, text, timestamp, jsonb, pgEnum } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { users } from './users'
import { organizations } from './organizations'

// Multi-cluster fleet: mix K8s + Docker Swarm + Docker Compose clusters freely
// Each org can have N clusters of any type, managed from one dashboard
export const clusterTypeEnum = pgEnum('cluster_type', ['kubernetes', 'docker-swarm', 'docker-compose', 'cloudflare-pages', 'github-pages'])
export const clusterProviderEnum = pgEnum('cluster_provider', ['digitalocean', 'aws', 'gcp', 'azure', 'hetzner', 'bare-metal', 'local', 'cloudflare', 'github'])
export const clusterStatusEnum = pgEnum('cluster_status', ['provisioning', 'running', 'error', 'destroying', 'offline'])

export const clusters = pgTable('clusters', {
  id:                text('id').primaryKey().$defaultFn(() => createId()),
  slug:              text('slug').notNull().unique(),
  name:              text('name').notNull(),
  type:              clusterTypeEnum('type').notNull(),
  provider:          clusterProviderEnum('provider').notNull(),
  status:            clusterStatusEnum('status').notNull().default('provisioning'),

  // Connection info (encrypted at rest)
  endpoint:          text('endpoint'),                     // K8s API server URL or Docker host
  kubeconfig:        text('kubeconfig'),                   // Encrypted kubeconfig (K8s only)
  tlsCert:           text('tls_cert'),                     // Encrypted TLS cert (Docker TLS only)
  tlsKey:            text('tls_key'),                      // Encrypted TLS key (Docker TLS only)
  tlsCa:             text('tls_ca'),                       // Encrypted CA cert (Docker TLS only)

  // Cloud provider specifics (DOKS, EKS, GKE, etc.)
  cloudId:           text('cloud_id'),                     // e.g., DOKS cluster UUID
  cloudRegion:       text('cloud_region'),
  cloudMeta:         jsonb('cloud_meta'),                  // Provider-specific metadata (node pools, pricing, etc.)

  // Networking
  domains:           text('domains').array(),
  ips:               text('ips').array(),
  reverseProxyUrl:   text('reverse_proxy_url'),

  // Ownership (nullable for the platform control-plane cluster itself)
  orgId:             text('org_id').references(() => organizations.id),
  createdBy:         text('created_by').references(() => users.id),
  updatedBy:         text('updated_by').references(() => users.id),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
