# Hanzo PaaS v2 -- Architecture & Implementation Plan

## Executive Summary

Modernize the Hanzo PaaS (Express + MongoDB + React SPA) into a
unified Next.js application with tRPC, PostgreSQL, and a dual-mode orchestration layer
that treats Docker Swarm and Kubernetes as interchangeable deployment targets. The
rebuild happens in-place at `~/work/hanzo/paas/`, reusing the existing K8s-specific
handlers (Tekton, DOKS provisioner) while replacing the data layer, API layer, and
frontend wholesale.

---

## 1. Tech Stack Selection

| Layer | Current | New | Justification |
|-------|---------|-----|---------------|
| **Runtime** | Node.js 18 (ESM) | Node.js 22 LTS | Stable, native fetch, import.meta.resolve |
| **Framework** | Express 4 + Vite SPA | Next.js 15 (App Router) | SSR, API routes, unified build, RSC for dashboard perf |
| **API** | Express REST (25 route files) | tRPC v11 + OpenAPI export | End-to-end type safety, auto-generated REST docs |
| **Database** | MongoDB 5 + Mongoose | `hanzoai/sql` (PostgreSQL 18 fork) + Drizzle ORM | Relational integrity, JSONB for flex fields, better migration tooling. Use Hanzo's own `ghcr.io/hanzoai/sql:18` image. |
| **Cache/Queue** | Socket.io sync | BullMQ + `hanzoai/kv` (Valkey fork) | Reliable async jobs (builds, provisioning), dead-letter, retry. Use Hanzo's own `ghcr.io/hanzoai/kv:8` image. |
| **Realtime** | Socket.io | Server-Sent Events (native) | Simpler, no extra deps, works through CDNs/proxies |
| **Auth** | Custom session + JWT | hanzo.id OAuth2 (PKCE) via `next-auth` adapter | Standard, one auth path, session in DB |
| **UI** | Radix + custom Tailwind | `@hanzo/ui` primitives + blocks | Shared component library, consistent brand across all Hanzo products |
| **CSS** | Tailwind 3 + custom tokens | Tailwind 4.1 (same as @hanzo/ui) | CSS-first config, native nesting, matches @hanzo/ui |
| **Build/CI** | Docker multi-arch + kubectl | Docker multi-arch + Helm 3 | Helm for parameterized deploys, same image for all envs |
| **Monorepo** | 6 separate package.json dirs | pnpm workspaces + Turborepo | Single lockfile, shared deps, parallel builds |
| **Orchestration** | K8s only (@kubernetes/client-node) | Abstraction layer: K8s adapter + Docker adapter | Same API surface, dispatches to Docker or K8s based on cluster type |

### Why Not Keep MongoDB

**Hard requirement: NO MongoDB.** All data must live in `hanzoai/sql` (our PostgreSQL 18
fork at `ghcr.io/hanzoai/sql:18`). All Mongoose schemas migrate to Drizzle ORM. The
current Mongoose schemas are deeply relational -- containers reference environments which
reference projects which reference organizations. MongoDB has no foreign keys, no JOINs,
and the embedded-document pattern (e.g., org.doks) makes fleet queries expensive.
PostgreSQL with Drizzle gives us typed schemas, real relations, transactions with proper
isolation, and JSONB columns for the semi-structured fields (podConfig, probes, etc.)
where schema flexibility matters.

### Why hanzoai/kv Instead of Redis

Use `ghcr.io/hanzoai/kv:8` (our Valkey 8 fork) for all cache, session, and queue needs.
Drop-in Redis-compatible, fully open-source (no BSL license issues). BullMQ works
natively with Valkey.

### Why tRPC Over REST

The existing 25 route files each duplicate validation logic (express-validator chains
that mirror Mongoose schema constraints). tRPC with Zod schemas eliminates this
duplication: one Zod schema validates input AND generates TypeScript types for the
frontend. The OpenAPI plugin generates Swagger docs for external consumers. No custom
fetch wrappers needed on the client -- the tRPC client provides fully typed
procedures with autocomplete.

---

## 2. Monorepo Structure

```
~/work/hanzo/paas/
├── package.json                  # Root: pnpm workspace config
├── pnpm-workspace.yaml
├── turbo.json
├── .env.example
├── compose.yml                   # Local dev: hanzoai/sql + hanzoai/kv + app
│
├── apps/
│   └── web/                      # Next.js 15 application
│       ├── package.json          # deps: next, @hanzo/ui, @paas/db, @paas/api, @paas/orchestrator
│       ├── next.config.ts
│       ├── app/                  # App Router pages
│       │   ├── layout.tsx        # Root layout with @hanzo/ui ThemeProvider
│       │   ├── (auth)/           # Auth routes (login, callback, register)
│       │   ├── (dashboard)/      # Authenticated dashboard
│       │   │   ├── layout.tsx    # Sidebar + header layout
│       │   │   ├── page.tsx      # Fleet overview / home
│       │   │   ├── orgs/
│       │   │   │   ├── page.tsx                      # Org list
│       │   │   │   └── [orgId]/
│       │   │   │       ├── page.tsx                  # Org overview
│       │   │   │       ├── settings/page.tsx         # Org settings
│       │   │   │       ├── team/page.tsx             # Org team management
│       │   │   │       ├── clusters/page.tsx         # Cluster fleet for this org
│       │   │   │       └── projects/
│       │   │   │           ├── page.tsx              # Project list
│       │   │   │           └── [projectId]/
│       │   │   │               ├── page.tsx          # Project overview
│       │   │   │               └── envs/
│       │   │   │                   └── [envId]/
│       │   │   │                       ├── page.tsx          # Environment containers
│       │   │   │                       └── [containerId]/
│       │   │   │                           ├── page.tsx      # Container detail
│       │   │   │                           ├── logs/page.tsx # Live logs
│       │   │   │                           └── builds/page.tsx # Build history
│       │   │   ├── clusters/                         # Global fleet view
│       │   │   │   ├── page.tsx                      # All clusters
│       │   │   │   └── [clusterId]/page.tsx          # Cluster detail
│       │   │   ├── registries/page.tsx               # Container registries
│       │   │   └── settings/page.tsx                 # Platform settings
│       │   └── api/
│       │       ├── trpc/[trpc]/route.ts              # tRPC HTTP handler
│       │       ├── webhooks/
│       │       │   ├── github/route.ts               # Git push webhooks
│       │       │   ├── gitlab/route.ts
│       │       │   └── bitbucket/route.ts
│       │       └── health/route.ts
│       ├── components/           # App-specific composed components
│       ├── hooks/                # React hooks (useContainer, useCluster, etc.)
│       ├── lib/                  # Client-side utilities
│       │   ├── trpc.ts           # tRPC React client setup
│       │   └── auth.ts           # next-auth client helpers
│       └── Dockerfile
│
├── packages/
│   ├── db/                       # @paas/db -- Drizzle schema + migrations
│   │   ├── package.json
│   │   ├── drizzle.config.ts
│   │   ├── src/
│   │   │   ├── schema/           # Drizzle table definitions
│   │   │   │   ├── index.ts
│   │   │   │   ├── users.ts
│   │   │   │   ├── organizations.ts
│   │   │   │   ├── org-members.ts
│   │   │   │   ├── projects.ts
│   │   │   │   ├── project-members.ts
│   │   │   │   ├── environments.ts
│   │   │   │   ├── containers.ts
│   │   │   │   ├── clusters.ts
│   │   │   │   ├── registries.ts
│   │   │   │   ├── git-providers.ts
│   │   │   │   ├── deployments.ts      # Build/deploy history
│   │   │   │   ├── domains.ts
│   │   │   │   ├── audit-logs.ts
│   │   │   │   ├── invitations.ts
│   │   │   │   └── sessions.ts         # next-auth sessions
│   │   │   ├── client.ts        # Drizzle client factory
│   │   │   ├── migrate.ts       # Migration runner
│   │   │   └── seed.ts          # Dev seed data
│   │   └── migrations/          # SQL migration files (auto-generated)
│   │
│   ├── api/                      # @paas/api -- tRPC router definitions
│   │   ├── package.json
│   │   └── src/
│   │       ├── root.ts           # Root router (merges all sub-routers)
│   │       ├── context.ts        # tRPC context (db, session, orchestrator)
│   │       ├── trpc.ts           # tRPC init, middleware (auth, org, project)
│   │       ├── openapi.ts        # OpenAPI document generation
│   │       └── routers/
│   │           ├── auth.ts
│   │           ├── user.ts
│   │           ├── organization.ts
│   │           ├── org-team.ts
│   │           ├── org-invites.ts
│   │           ├── project.ts
│   │           ├── project-team.ts
│   │           ├── project-invites.ts
│   │           ├── environment.ts
│   │           ├── container.ts
│   │           ├── cluster.ts        # Fleet management
│   │           ├── provisioner.ts    # DOKS / cloud cluster lifecycle
│   │           ├── registry.ts
│   │           ├── build.ts          # Build triggers, status, logs
│   │           ├── git.ts            # Git provider management
│   │           ├── domain.ts
│   │           ├── log.ts            # Container log streaming
│   │           └── system.ts         # Health, version, cluster info
│   │
│   ├── orchestrator/             # @paas/orchestrator -- Dual-mode abstraction
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts          # Factory: createOrchestrator(clusterType)
│   │       ├── types.ts          # Shared interfaces (IOrchestrator, etc.)
│   │       ├── k8s/
│   │       │   ├── adapter.ts    # K8sOrchestrator implements IOrchestrator
│   │       │   ├── client.ts     # @kubernetes/client-node wrapper
│   │       │   ├── tekton.ts     # Tekton pipeline management (from current handlers/tekton.js)
│   │       │   ├── manifests/    # YAML templates (from current handlers/manifests/)
│   │       │   ├── provisioner.ts # DOKS lifecycle (from current handlers/provisioner.js)
│   │       │   └── resources/    # Typed K8s resource builders
│   │       │       ├── deployment.ts
│   │       │       ├── statefulset.ts
│   │       │       ├── cronjob.ts
│   │       │       ├── service.ts
│   │       │       ├── ingress.ts
│   │       │       ├── namespace.ts
│   │       │       ├── pvc.ts
│   │       │       └── hpa.ts
│   │       └── docker/
│   │           ├── adapter.ts    # DockerOrchestrator implements IOrchestrator
│   │           ├── client.ts     # Dockerode wrapper
│   │           ├── compose.ts    # Docker Compose generation
│   │           ├── swarm.ts      # Docker Swarm service management
│   │           ├── build.ts      # Local Docker build (replaces Kaniko for Docker mode)
│   │           └── traefik.ts    # Traefik label generation for routing
│   │
│   ├── jobs/                     # @paas/jobs -- BullMQ workers
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts          # Worker entrypoint
│   │       ├── queues.ts         # Queue definitions
│   │       └── workers/
│   │           ├── build.ts      # Container image build
│   │           ├── deploy.ts     # Deploy/update container
│   │           ├── provision.ts  # Cluster provisioning
│   │           ├── destroy.ts    # Teardown resources
│   │           └── monitor.ts    # Health check polling
│   │
│   └── shared/                   # @paas/shared -- Common types and utils
│       ├── package.json
│       └── src/
│           ├── types.ts          # Shared TypeScript types
│           ├── constants.ts      # Enums (containerTypes, roles, etc.)
│           ├── errors.ts         # Error codes and classes
│           └── utils.ts          # slugify, generateId, etc.
│
├── k8s/                          # K8s deployment manifests (Helm chart)
│   ├── Chart.yaml
│   ├── values.yaml
│   ├── values-production.yaml
│   └── templates/
│       ├── deployment.yaml       # Single deployment (web + worker)
│       ├── service.yaml
│       ├── ingress.yaml
│       ├── configmap.yaml
│       └── secrets.yaml          # ExternalSecret refs to KMS
│
├── scripts/
│   ├── migrate-mongo-to-pg.ts    # One-time migration script
│   ├── dev.sh                    # Start local dev environment
│   └── seed.ts                   # Dev data seeding
│
└── _legacy/                      # Current code, preserved during migration
    ├── platform/
    ├── platform-ui/
    ├── monitor/
    ├── sync/
    └── webhook/
```

### pnpm-workspace.yaml

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

### turbo.json

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "db:generate": {},
    "db:migrate": {},
    "lint": {},
    "typecheck": {
      "dependsOn": ["^build"]
    }
  }
}
```

---

## 3. Data Model -- Drizzle Schemas

All schemas live in `packages/db/src/schema/`. Below are the complete table
definitions.

### packages/db/src/schema/users.ts

```typescript
import { pgTable, text, timestamp, boolean, pgEnum } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'

export const userStatusEnum = pgEnum('user_status', ['Active', 'Deleted'])

export const users = pgTable('users', {
  id:              text('id').primaryKey().$defaultFn(() => createId()),
  iid:             text('iid').notNull().unique(),           // e.g. usr-abc123
  name:            text('name'),
  email:           text('email'),
  pictureUrl:      text('picture_url'),
  color:           text('color'),
  provider:        text('provider').notNull(),               // hanzo | github | gitlab | bitbucket
  providerUserId:  text('provider_user_id').notNull(),
  status:          userStatusEnum('status').notNull().default('Active'),
  isClusterOwner:  boolean('is_cluster_owner').notNull().default(false),
  canCreateOrg:    boolean('can_create_org').notNull().default(false),
  lastLoginAt:     timestamp('last_login_at', { withTimezone: true }),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
```

### packages/db/src/schema/organizations.ts

```typescript
import { pgTable, text, timestamp, boolean } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { users } from './users'

export const organizations = pgTable('organizations', {
  id:              text('id').primaryKey().$defaultFn(() => createId()),
  iid:             text('iid').notNull().unique(),
  name:            text('name').notNull(),
  pictureUrl:      text('picture_url'),
  color:           text('color'),
  ownerUserId:     text('owner_user_id').notNull().references(() => users.id),
  isClusterEntity: boolean('is_cluster_entity').notNull().default(false),
  createdBy:       text('created_by').references(() => users.id),
  updatedBy:       text('updated_by').references(() => users.id),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
```

### packages/db/src/schema/org-members.ts

```typescript
import { pgTable, text, timestamp, pgEnum, primaryKey } from 'drizzle-orm/pg-core'
import { organizations } from './organizations'
import { users } from './users'

export const orgRoleEnum = pgEnum('org_role', ['Admin', 'Member'])

export const orgMembers = pgTable('org_members', {
  id:        text('id').primaryKey(),
  orgId:     text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId:    text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role:      orgRoleEnum('role').notNull().default('Member'),
  joinedAt:  timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
})
```

### packages/db/src/schema/projects.ts

```typescript
import { pgTable, text, timestamp, boolean } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { organizations } from './organizations'
import { users } from './users'

export const projects = pgTable('projects', {
  id:              text('id').primaryKey().$defaultFn(() => createId()),
  iid:             text('iid').notNull().unique(),
  orgId:           text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  ownerUserId:     text('owner_user_id').notNull().references(() => users.id),
  name:            text('name').notNull(),
  pictureUrl:      text('picture_url'),
  color:           text('color'),
  isClusterEntity: boolean('is_cluster_entity').notNull().default(false),
  createdBy:       text('created_by').references(() => users.id),
  updatedBy:       text('updated_by').references(() => users.id),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
```

### packages/db/src/schema/project-members.ts

```typescript
import { pgTable, text, timestamp, pgEnum } from 'drizzle-orm/pg-core'
import { projects } from './projects'
import { users } from './users'

export const projectRoleEnum = pgEnum('project_role', ['Admin', 'Developer', 'Viewer'])

export const projectMembers = pgTable('project_members', {
  id:        text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId:    text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role:      projectRoleEnum('role').notNull().default('Developer'),
  joinedAt:  timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
})
```

### packages/db/src/schema/environments.ts

```typescript
import { pgTable, text, timestamp, boolean } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { organizations } from './organizations'
import { projects } from './projects'
import { users } from './users'

export const environments = pgTable('environments', {
  id:              text('id').primaryKey().$defaultFn(() => createId()),
  iid:             text('iid').notNull().unique(),         // also used as K8s namespace name
  orgId:           text('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  projectId:       text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name:            text('name').notNull(),
  private:         boolean('private').notNull().default(false),
  readOnly:        boolean('read_only').notNull().default(true),
  isClusterEntity: boolean('is_cluster_entity').notNull().default(false),
  createdBy:       text('created_by').references(() => users.id),
  updatedBy:       text('updated_by').references(() => users.id),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
```

### packages/db/src/schema/clusters.ts

```typescript
import { pgTable, text, timestamp, boolean, jsonb, pgEnum } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { users } from './users'

// Multi-cluster fleet: mix K8s + Docker Swarm + Docker Compose clusters freely
// Each org can have N clusters of any type, managed from one dashboard
export const clusterTypeEnum = pgEnum('cluster_type', ['kubernetes', 'docker-swarm', 'docker-compose'])
export const clusterProviderEnum = pgEnum('cluster_provider', ['digitalocean', 'aws', 'gcp', 'azure', 'hetzner', 'bare-metal', 'local'])
export const certStatusEnum = pgEnum('cert_status', ['Issuing', 'Issued', 'Not Ready', 'Error'])

export const clusters = pgTable('clusters', {
  id:                text('id').primaryKey().$defaultFn(() => createId()),
  slug:              text('slug').notNull().unique(),
  name:              text('name').notNull(),
  type:              clusterTypeEnum('type').notNull(),
  provider:          clusterProviderEnum('provider').notNull(),

  // Connection info
  endpoint:          text('endpoint'),                     // API server URL or Docker host
  accessToken:       text('access_token'),                 // Encrypted cluster token
  kubeconfig:        text('kubeconfig'),                   // Encrypted kubeconfig (K8s only)
  tlsCert:           text('tls_cert'),                     // Encrypted TLS cert (Docker only)
  tlsKey:            text('tls_key'),                      // Encrypted TLS key (Docker only)
  tlsCa:             text('tls_ca'),                       // Encrypted CA cert (Docker only)

  // Cloud provider specifics (DOKS, EKS, etc.)
  cloudId:           text('cloud_id'),                     // e.g., DOKS cluster UUID
  cloudRegion:       text('cloud_region'),
  cloudMeta:         jsonb('cloud_meta'),                  // Provider-specific metadata

  // Networking
  domains:           text('domains').array(),
  ips:               text('ips').array(),
  reverseProxyUrl:   text('reverse_proxy_url'),
  certificateStatus: certStatusEnum('certificate_status'),

  // State
  status:            text('status').notNull().default('provisioning'), // provisioning | running | error | destroying
  release:           text('release'),
  releaseHistory:    jsonb('release_history').$type<Array<{ release: string; timestamp: string }>>(),
  masterToken:       text('master_token'),

  // Ownership
  orgId:             text('org_id'),                       // NULL for the platform cluster itself
  createdBy:         text('created_by').references(() => users.id),
  updatedBy:         text('updated_by').references(() => users.id),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
```

### packages/db/src/schema/containers.ts

```typescript
import { pgTable, text, timestamp, boolean, integer, jsonb, pgEnum } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { organizations } from './organizations'
import { projects } from './projects'
import { environments } from './environments'
import { users } from './users'

export const containerTypeEnum = pgEnum('container_type', ['deployment', 'statefulset', 'cronjob'])
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

  // Source (repo or registry)
  sourceType:      sourceTypeEnum('source_type').notNull().default('repo'),
  repoConfig:      jsonb('repo_config').$type<RepoConfig | null>(),
  registryConfig:  jsonb('registry_config').$type<RegistryConfig | null>(),

  // Runtime configuration (JSONB for flexibility -- these are deeply nested)
  networking:      jsonb('networking').$type<NetworkingConfig>(),
  podConfig:       jsonb('pod_config').$type<PodConfig>(),
  storageConfig:   jsonb('storage_config').$type<StorageConfig>(),
  deploymentConfig: jsonb('deployment_config').$type<DeploymentStrategyConfig>(),
  statefulSetConfig: jsonb('stateful_set_config').$type<StatefulSetConfig>(),
  cronJobConfig:   jsonb('cron_job_config').$type<CronJobConfig>(),
  probes:          jsonb('probes').$type<ProbesConfig>(),
  variables:       jsonb('variables').$type<Array<{ name: string; value: string }>>(),

  // Template (for marketplace deploys)
  templateName:    text('template_name'),
  templateVersion: text('template_version'),
  templateManifest: text('template_manifest'),

  // Status
  status:          jsonb('status'),                        // Live status from orchestrator
  pipelineStatus:  text('pipeline_status'),
  latestImages:    jsonb('latest_images'),

  // Metadata
  isClusterEntity: boolean('is_cluster_entity').notNull().default(false),
  createdBy:       text('created_by').references(() => users.id),
  updatedBy:       text('updated_by').references(() => users.id),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// TypeScript interfaces for the JSONB columns
// (exported from @paas/shared for reuse)
```

### packages/db/src/schema/registries.ts

```typescript
import { pgTable, text, timestamp, boolean, jsonb, pgEnum } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { users } from './users'

export const registryTypeEnum = pgEnum('registry_type', [
  'ECR', 'ACR', 'GCR', 'GAR', 'Quay', 'GHCR', 'Docker', 'Custom', 'Public'
])

export const registries = pgTable('registries', {
  id:              text('id').primaryKey().$defaultFn(() => createId()),
  iid:             text('iid').notNull().unique(),
  type:            registryTypeEnum('type').notNull(),
  name:            text('name').notNull(),
  credentials:     jsonb('credentials'),    // Encrypted, type varies by registry type
  isClusterEntity: boolean('is_cluster_entity').notNull().default(false),
  createdBy:       text('created_by').references(() => users.id),
  updatedBy:       text('updated_by').references(() => users.id),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
```

### packages/db/src/schema/git-providers.ts

```typescript
import { pgTable, text, timestamp, pgEnum } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { users } from './users'

export const gitProviderEnum = pgEnum('git_provider_type', ['github', 'gitlab', 'bitbucket'])

export const gitProviders = pgTable('git_providers', {
  id:              text('id').primaryKey().$defaultFn(() => createId()),
  iid:             text('iid').notNull().unique(),
  userId:          text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider:        gitProviderEnum('provider').notNull(),
  providerUserId:  text('provider_user_id').notNull(),
  accessToken:     text('access_token').notNull(),          // Encrypted
  refreshToken:    text('refresh_token'),                   // Encrypted
  expiresAt:       timestamp('expires_at', { withTimezone: true }),
  username:        text('username'),
  email:           text('email'),
  avatar:          text('avatar'),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
```

### packages/db/src/schema/deployments.ts (Build/Deploy History)

```typescript
import { pgTable, text, timestamp, integer, jsonb, pgEnum } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { containers } from './containers'
import { users } from './users'

export const deployStatusEnum = pgEnum('deploy_status', [
  'queued', 'building', 'pushing', 'deploying', 'running', 'failed', 'cancelled'
])
export const triggerTypeEnum = pgEnum('trigger_type', [
  'manual', 'git-push', 'webhook', 'rollback', 'schedule'
])

export const deployments = pgTable('deployments', {
  id:            text('id').primaryKey().$defaultFn(() => createId()),
  containerId:   text('container_id').notNull().references(() => containers.id, { onDelete: 'cascade' }),
  status:        deployStatusEnum('status').notNull().default('queued'),
  trigger:       triggerTypeEnum('trigger').notNull().default('manual'),

  // Git info
  commitSha:     text('commit_sha'),
  commitMessage: text('commit_message'),
  branch:        text('branch'),

  // Build info
  imageTag:      text('image_tag'),
  buildLogs:     text('build_logs'),             // Stored as text, streamed during build
  buildDuration: integer('build_duration'),       // Seconds

  // Deploy info
  deployLogs:    text('deploy_logs'),
  deployMeta:    jsonb('deploy_meta'),            // Orchestrator-specific metadata

  triggeredBy:   text('triggered_by').references(() => users.id),
  startedAt:     timestamp('started_at', { withTimezone: true }),
  finishedAt:    timestamp('finished_at', { withTimezone: true }),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

### packages/db/src/schema/domains.ts

```typescript
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { clusters } from './clusters'

export const domains = pgTable('domains', {
  id:          text('id').primaryKey().$defaultFn(() => createId()),
  domain:      text('domain').notNull().unique(),
  clusterId:   text('cluster_id').notNull().references(() => clusters.id, { onDelete: 'cascade' }),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

### packages/db/src/schema/audit-logs.ts

```typescript
import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { users } from './users'

export const auditLogs = pgTable('audit_logs', {
  id:          text('id').primaryKey().$defaultFn(() => createId()),
  userId:      text('user_id').references(() => users.id),
  action:      text('action').notNull(),                // e.g. 'container.create', 'cluster.provision'
  resource:    text('resource').notNull(),               // e.g. 'container', 'cluster', 'user'
  resourceId:  text('resource_id'),
  description: text('description'),
  metadata:    jsonb('metadata'),                        // Extra context
  ip:          text('ip'),
  userAgent:   text('user_agent'),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

### packages/db/src/schema/invitations.ts

```typescript
import { pgTable, text, timestamp, pgEnum } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { organizations } from './organizations'
import { projects } from './projects'
import { users } from './users'

export const inviteStatusEnum = pgEnum('invite_status', ['Pending', 'Accepted', 'Rejected'])
export const inviteTargetEnum = pgEnum('invite_target', ['organization', 'project'])

export const invitations = pgTable('invitations', {
  id:           text('id').primaryKey().$defaultFn(() => createId()),
  token:        text('token').notNull().unique(),
  email:        text('email').notNull(),
  targetType:   inviteTargetEnum('target_type').notNull(),
  orgId:        text('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  projectId:    text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  role:         text('role').notNull(),                    // Org or project role
  status:       inviteStatusEnum('status').notNull().default('Pending'),
  invitedBy:    text('invited_by').notNull().references(() => users.id),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt:    timestamp('expires_at', { withTimezone: true }),
})
```

---

## 4. Orchestration Abstraction Layer

The core design principle: **Docker and K8s are abstracted as interchangeable backends.**
A single `IOrchestrator` interface is implemented by both the K8s adapter and Docker adapter.
The tRPC routers never talk to K8s or Docker directly -- they call the orchestrator, which
dispatches based on the cluster's type.

**Multi-cluster fleet management**: An org can have N clusters of ANY type -- mix Docker Swarm
clusters for dev, K8s clusters for staging/production, Docker Compose for local dev. All managed
from one dashboard. The platform is the fleet control plane:

- Local devs run the platform stack in Docker (compose.yml) with zero K8s dependency
- Home labs can register a K8s cluster OR Docker Swarm node
- Production deploys to managed K8s (DOKS, EKS, GKE) via Helm charts/operator
- All cluster types get the same features: deploy, logs, env vars, domains, builds, scaling

### packages/orchestrator/src/types.ts

```typescript
// ---- Core orchestration interface ----

export type ClusterType = 'kubernetes' | 'docker-swarm' | 'docker-compose'

export interface OrchestratorConfig {
  clusterType: ClusterType
  // K8s: kubeconfig string
  // Docker: host, tlsCert, tlsKey, tlsCa
  connection: K8sConnection | DockerConnection
}

export interface K8sConnection {
  kind: 'kubernetes'
  kubeconfig: string
}

export interface DockerConnection {
  kind: 'docker'
  host: string        // e.g., unix:///var/run/docker.sock or tcp://192.168.1.100:2376
  tlsCert?: string
  tlsKey?: string
  tlsCa?: string
}

export interface IOrchestrator {
  // Namespace / network isolation
  createNamespace(name: string): Promise<void>
  deleteNamespace(name: string): Promise<void>
  listNamespaces(): Promise<string[]>

  // Container lifecycle (deployment/statefulset/cronjob in K8s, service/container in Docker)
  createContainer(spec: ContainerSpec): Promise<ContainerResult>
  updateContainer(spec: ContainerSpec): Promise<ContainerResult>
  deleteContainer(namespace: string, name: string, type: ContainerType): Promise<void>
  getContainerStatus(namespace: string, name: string, type: ContainerType): Promise<ContainerStatus>

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

export interface ContainerSpec {
  namespace: string
  name: string
  type: ContainerType
  image: string
  variables: Array<{ name: string; value: string }>
  networking: NetworkingConfig
  podConfig: PodConfig
  storageConfig: StorageConfig
  // Type-specific configs
  deploymentConfig?: DeploymentStrategyConfig
  statefulSetConfig?: StatefulSetConfig
  cronJobConfig?: CronJobConfig
  probes?: ProbesConfig
}

// ... (NetworkingConfig, PodConfig, etc. match the JSONB types from the DB schema)
```

### packages/orchestrator/src/index.ts

```typescript
import { K8sOrchestrator } from './k8s/adapter'
import { DockerOrchestrator } from './docker/adapter'
import type { IOrchestrator, OrchestratorConfig } from './types'

export function createOrchestrator(config: OrchestratorConfig): IOrchestrator {
  switch (config.clusterType) {
    case 'kubernetes':
      return new K8sOrchestrator(config.connection as K8sConnection)
    case 'docker-swarm':
    case 'docker-compose':
      return new DockerOrchestrator(config.connection as DockerConnection, config.clusterType)
    default:
      throw new Error(`Unknown cluster type: ${config.clusterType}`)
  }
}

export type { IOrchestrator } from './types'
```

### K8s Adapter (summary)

The K8s adapter wraps `@kubernetes/client-node` and reimplements the logic from the
current `handlers/deployment.js`, `handlers/statefulset.js`, `handlers/cronjob.js`,
`handlers/service.js`, `handlers/ingress.js`, `handlers/hpa.js`, `handlers/pvc.js`,
and `handlers/ns.js` behind the `IOrchestrator` interface.

Key differences from current code:
- No global KubeConfig -- each adapter instance holds its own KubeConfig (supports multi-cluster)
- Build logic delegates to Tekton for K8s clusters (existing `tekton.ts` moves here)
- All K8s YAML templates move from `handlers/manifests/` to `orchestrator/src/k8s/manifests/`

### Docker Adapter (summary)

The Docker adapter wraps `dockerode` and maps the same ContainerSpec to Docker
primitives:

| IOrchestrator method | K8s implementation | Docker implementation |
|---------------------|--------------------|-----------------------|
| createNamespace | K8s Namespace | Docker network (overlay for Swarm) |
| createContainer (deployment) | Deployment + Service | Swarm Service / Compose service |
| createContainer (statefulset) | StatefulSet + PVC + Service | Named volume + service |
| createContainer (cronjob) | CronJob | Ofelia sidecar / host cron |
| createIngress | Ingress (nginx) | Traefik labels |
| createVolume | PVC | Docker named volume |
| triggerBuild | Tekton Pipeline (Kaniko) | `docker build` + `docker push` |
| streamLogs | K8s log stream | `docker logs --follow` |
| scaleContainer | Patch replicas | `docker service scale` |

---

## 5. Auth Flow -- hanzo.id OAuth2

### Architecture

Authentication uses a single path everywhere: hanzo.id as the OAuth2 provider (Casdoor).
The current platform has a partially-custom session system. The new system uses `next-auth`
(Auth.js v5) with a custom Casdoor provider.

### Flow

```
1. User visits platform.hanzo.ai
2. Next.js middleware checks session cookie
3. No session -> redirect to /auth/login
4. /auth/login page -> "Sign in with Hanzo" button
5. Click -> next-auth initiates OAuth2 PKCE flow to hanzo.id
6. hanzo.id/login/oauth/authorize (Casdoor)
7. User authenticates (email, GitHub, Google, wallet -- all handled by Casdoor)
8. Callback to /api/auth/callback/hanzo
9. next-auth exchanges code for tokens, fetches userinfo
10. Session created in PostgreSQL (sessions table)
11. User redirected to /orgs (dashboard)
```

### next-auth Configuration

```typescript
// apps/web/lib/auth.ts
import NextAuth from 'next-auth'
import { DrizzleAdapter } from '@auth/drizzle-adapter'
import { db } from '@paas/db'

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db),
  providers: [
    {
      id: 'hanzo',
      name: 'Hanzo',
      type: 'oidc',
      issuer: process.env.HANZO_IAM_ISSUER,           // https://hanzo.id
      clientId: process.env.HANZO_IAM_CLIENT_ID,       // hanzo-platform-client-id
      clientSecret: process.env.HANZO_IAM_CLIENT_SECRET,
      authorization: {
        url: `${process.env.HANZO_IAM_ISSUER}/login/oauth/authorize`,
        params: { scope: 'openid profile email' },
      },
      token: `${process.env.HANZO_IAM_ISSUER}/api/login/oauth/access_token`,
      userinfo: `${process.env.HANZO_IAM_ISSUER}/api/userinfo`,
    },
  ],
  session: { strategy: 'database' },
  callbacks: {
    async session({ session, user }) {
      // Attach PaaS-specific user fields
      session.user.id = user.id
      session.user.isClusterOwner = user.isClusterOwner
      session.user.canCreateOrg = user.canCreateOrg
      return session
    },
  },
})
```

### tRPC Auth Middleware

```typescript
// packages/api/src/trpc.ts
import { initTRPC, TRPCError } from '@trpc/server'
import { auth } from '@/lib/auth'

const t = initTRPC.context<Context>().create()

export const publicProcedure = t.procedure
export const authedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }
  return next({ ctx: { ...ctx, user: ctx.session.user } })
})

// Org-scoped middleware: verifies user is member of the org
export const orgProcedure = authedProcedure.use(async ({ ctx, input, next }) => {
  const orgId = (input as any).orgId
  const membership = await ctx.db.query.orgMembers.findFirst({
    where: (m, { and, eq }) => and(eq(m.orgId, orgId), eq(m.userId, ctx.user.id)),
  })
  if (!membership) throw new TRPCError({ code: 'FORBIDDEN' })
  return next({ ctx: { ...ctx, org: { id: orgId, role: membership.role } } })
})
```

---

## 6. API Layer -- tRPC Routers

### Router Structure

```typescript
// packages/api/src/root.ts
import { router } from './trpc'
import { authRouter } from './routers/auth'
import { userRouter } from './routers/user'
import { organizationRouter } from './routers/organization'
import { orgTeamRouter } from './routers/org-team'
import { orgInvitesRouter } from './routers/org-invites'
import { projectRouter } from './routers/project'
import { projectTeamRouter } from './routers/project-team'
import { environmentRouter } from './routers/environment'
import { containerRouter } from './routers/container'
import { clusterRouter } from './routers/cluster'
import { provisionerRouter } from './routers/provisioner'
import { registryRouter } from './routers/registry'
import { buildRouter } from './routers/build'
import { gitRouter } from './routers/git'
import { domainRouter } from './routers/domain'
import { logRouter } from './routers/log'
import { systemRouter } from './routers/system'

export const appRouter = router({
  auth: authRouter,
  user: userRouter,
  organization: organizationRouter,
  orgTeam: orgTeamRouter,
  orgInvites: orgInvitesRouter,
  project: projectRouter,
  projectTeam: projectTeamRouter,
  environment: environmentRouter,
  container: containerRouter,
  cluster: clusterRouter,
  provisioner: provisionerRouter,
  registry: registryRouter,
  build: buildRouter,
  git: gitRouter,
  domain: domainRouter,
  log: logRouter,
  system: systemRouter,
})

export type AppRouter = typeof appRouter
```

### Example Router: Container

```typescript
// packages/api/src/routers/container.ts
import { z } from 'zod'
import { router, orgProcedure } from '../trpc'
import { containers, containerTypeEnum } from '@paas/db/schema'
import { eq, and } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'

const containerInput = z.object({
  orgId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  name: z.string().min(2).max(64),
  type: z.enum(['deployment', 'statefulset', 'cronjob']),
  sourceType: z.enum(['repo', 'registry']),
  repoConfig: z.object({
    provider: z.enum(['github', 'gitlab', 'bitbucket']).optional(),
    url: z.string().url().optional(),
    branch: z.string().optional(),
    path: z.string().default('/'),
    dockerfile: z.string().default('Dockerfile'),
    gitProviderId: z.string().optional(),
    testEnabled: z.boolean().default(true),
    testImage: z.string().optional(),
    testCommand: z.string().optional(),
  }).optional(),
  registryConfig: z.object({
    registryId: z.string(),
    imageName: z.string(),
    imageTag: z.string(),
  }).optional(),
  networking: z.object({ /* ... */ }).optional(),
  podConfig: z.object({ /* ... */ }).optional(),
  variables: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  // ... remaining configs
})

export const containerRouter = router({
  list: orgProcedure
    .input(z.object({ orgId: z.string(), projectId: z.string(), environmentId: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.db.query.containers.findMany({
        where: (c, { eq, and }) => and(
          eq(c.orgId, input.orgId),
          eq(c.projectId, input.projectId),
          eq(c.environmentId, input.environmentId),
        ),
        orderBy: (c, { desc }) => [desc(c.createdAt)],
      })
    }),

  getById: orgProcedure
    .input(z.object({ orgId: z.string(), containerId: z.string() }))
    .query(async ({ ctx, input }) => {
      const container = await ctx.db.query.containers.findFirst({
        where: eq(containers.id, input.containerId),
      })
      if (!container) throw new TRPCError({ code: 'NOT_FOUND' })
      return container
    }),

  create: orgProcedure
    .input(containerInput)
    .mutation(async ({ ctx, input }) => {
      // 1. Validate environment exists
      // 2. Insert container record
      // 3. Get orchestrator for the cluster
      // 4. Create container in orchestrator
      // 5. If repo source, create Tekton pipeline (K8s) or enqueue build (Docker)
      // 6. Return container
      const orchestrator = await ctx.getOrchestrator(input.orgId)
      // ... implementation
    }),

  update: orgProcedure
    .input(containerInput.partial().extend({ orgId: z.string(), containerId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // 1. Get existing container
      // 2. Compute diff (similar to current getValueChanges)
      // 3. Update DB record
      // 4. Update orchestrator resources based on what changed
    }),

  delete: orgProcedure
    .input(z.object({ orgId: z.string(), containerId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // 1. Get container
      // 2. Delete from orchestrator
      // 3. Delete from DB
    }),

  redeploy: orgProcedure
    .input(z.object({ orgId: z.string(), containerId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Enqueue a new build+deploy job
    }),
})
```

### OpenAPI Generation

```typescript
// packages/api/src/openapi.ts
import { generateOpenApiDocument } from 'trpc-openapi'
import { appRouter } from './root'

export const openApiDoc = generateOpenApiDocument(appRouter, {
  title: 'Hanzo PaaS API',
  version: '2.0.0',
  baseUrl: 'https://platform.hanzo.ai/api',
})
```

Exposed at `/api/openapi.json` for external tooling and MCP integration.

---

## 7. Build System

### Unified Build Pipeline

Builds are enqueued as BullMQ jobs. The worker inspects the cluster type and delegates
to the appropriate builder.

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────────┐
│  tRPC Route  │────>│  BullMQ Job  │────>│  Build Worker        │
│  (container  │     │  Queue       │     │                      │
│   .create)   │     │  "builds"    │     │  if K8s:             │
└──────────────┘     └──────────────┘     │    Tekton Pipeline   │
                                          │    (Kaniko builder)  │
                                          │                      │
                                          │  if Docker:          │
                                          │    docker build      │
                                          │    docker push       │
                                          └──────────────────────┘
```

### K8s Mode: Tekton + Kaniko (preserved from current)

The existing Tekton pipeline YAML templates and the `createTektonPipeline` function
move to `packages/orchestrator/src/k8s/tekton.ts`. The logic is unchanged -- Tekton
EventListeners, TriggerBindings, TriggerTemplates, and PipelineRuns using Kaniko for
in-cluster image builds.

### Docker Mode: Local Docker Build

```typescript
// packages/orchestrator/src/docker/build.ts
import Docker from 'dockerode'

export async function dockerBuild(opts: {
  docker: Docker
  repoPath: string        // Cloned repo path
  dockerfile: string
  imageName: string
  imageTag: string
  registryUrl?: string    // If pushing to external registry
}): Promise<{ imageId: string; logs: string }> {
  // 1. docker build -t imageName:imageTag -f dockerfile repoPath
  // 2. If registryUrl, docker push
  // 3. Stream logs back via SSE
}
```

### Git Webhook Flow (Shared)

Git webhooks (GitHub, GitLab, Bitbucket) are received at `/api/webhooks/{provider}/route.ts`.
The webhook handler:
1. Validates the webhook signature
2. Looks up the container by repo URL and branch
3. Enqueues a build job with trigger type `git-push`

This replaces the current Go webhook service (`webhook/main.go`) and the Tekton
EventListener approach for automatic builds. The Tekton pipeline is still used for
the actual build execution in K8s mode, but the webhook reception is unified.

---

## 8. Frontend Architecture

### Layout Structure

```
app/
├── layout.tsx                          # <html>, <body>, ThemeProvider, fonts
├── (auth)/
│   ├── layout.tsx                      # Centered card layout
│   ├── login/page.tsx                  # "Sign in with Hanzo" via next-auth
│   └── callback/page.tsx              # OAuth callback handling
├── (dashboard)/
│   ├── layout.tsx                      # AppShell: sidebar + header + main
│   ├── page.tsx                        # Fleet overview (all org clusters at a glance)
│   ├── orgs/...                        # (see monorepo structure above)
│   ├── clusters/...
│   ├── registries/...
│   └── settings/...
```

### Component Mapping (current -> new)

| Current Component | New Implementation |
|---|---|
| Custom Radix Dialog | `@hanzo/ui` `<Dialog>` primitive |
| Custom Radix Select | `@hanzo/ui` `<Select>` primitive |
| Custom Radix Toast | `@hanzo/ui` `<Toast>` primitive |
| Custom Accordion | `@hanzo/ui` `<Accordion>` primitive |
| Custom Button (CVA) | `@hanzo/ui` `<Button>` primitive |
| Custom Table (tanstack) | `@hanzo/ui` `<DataTable>` (built on tanstack) |
| Custom Badge | `@hanzo/ui` `<Badge>` primitive |
| Custom Card | `@hanzo/ui` `<Card>` primitive |
| Custom Sidebar | `@hanzo/ui` `<Sidebar>` block |
| Custom Form fields | `@hanzo/ui` `<Form>` + `<Field>` primitives |
| Zustand stores | tRPC React Query hooks (replaces manual state management) |
| Axios services | tRPC client (typed, no manual fetch) |
| Socket.io realtime | Server-Sent Events via tRPC subscription |

### Key Pages

**Fleet Overview** (`/(dashboard)/page.tsx`):
- Grid/list of all org clusters with status indicators
- Resource usage summary (CPU, memory, pods)
- Recent deployments timeline
- Quick actions: provision cluster, create project

**Container Detail** (`/(dashboard)/orgs/[orgId]/projects/[projectId]/envs/[envId]/[containerId]/page.tsx`):
- Tabs: Overview, Logs, Builds, Settings, Environment Variables
- Live status from orchestrator (polling via tRPC query with refetchInterval)
- Build history with expandable log viewer
- One-click redeploy
- Resource configuration forms using @hanzo/ui form primitives

**Cluster Management** (`/(dashboard)/orgs/[orgId]/clusters/page.tsx`):
- DOKS provisioning form (region, node size, HA toggle)
- Node pool management
- Kubeconfig download
- Cluster destroy with confirmation dialog

### Dark Mode

`@hanzo/ui` ships with dark mode support via CSS custom properties and Tailwind 4.1.
The PaaS uses dark-by-default (matching current platform-ui design language) with
light mode toggle.

---

## 9. Migration Strategy -- MongoDB to PostgreSQL

### Approach: Parallel Write, Gradual Cutover

This is NOT a big-bang migration. The existing platform continues running while the new
system is built alongside it.

### Migration Script

```typescript
// scripts/migrate-mongo-to-pg.ts
//
// One-time script to migrate data from MongoDB to PostgreSQL.
// Run against live MongoDB (read-only) and new PostgreSQL.

import { MongoClient } from 'mongodb'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from '@paas/db/schema'

async function migrate() {
  const mongo = await MongoClient.connect(process.env.MONGO_URI!)
  const mdb = mongo.db('test')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = drizzle(pool, { schema })

  // 1. Migrate users
  const mongoUsers = await mdb.collection('users').find({}).toArray()
  for (const u of mongoUsers) {
    await db.insert(schema.users).values({
      id: u._id.toString(),
      iid: u.iid,
      name: u.name,
      email: u.email,
      pictureUrl: u.pictureUrl,
      color: u.color,
      provider: u.provider,
      providerUserId: u.providerUserId,
      status: u.status,
      isClusterOwner: u.isClusterOwner || false,
      canCreateOrg: u.canCreateOrg || false,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    }).onConflictDoNothing()
  }

  // 2. Migrate organizations
  const mongoOrgs = await mdb.collection('organizations').find({}).toArray()
  for (const o of mongoOrgs) {
    await db.insert(schema.organizations).values({
      id: o._id.toString(),
      iid: o.iid,
      name: o.name,
      pictureUrl: o.pictureUrl,
      color: o.color,
      ownerUserId: o.ownerUserId.toString(),
      isClusterEntity: o.isClusterEntity || false,
      createdBy: o.createdBy?.toString(),
      updatedBy: o.updatedBy?.toString(),
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    }).onConflictDoNothing()
  }

  // 3. Migrate org members
  // 4. Migrate projects
  // 5. Migrate project members (from embedded team array -> separate table)
  // 6. Migrate environments
  // 7. Migrate containers (flatten nested objects into JSONB columns)
  // 8. Migrate clusters (from ClusterModel)
  // 9. Migrate registries (encrypt credentials for new format)
  // 10. Migrate git providers
  // 11. Migrate audit logs

  // Special handling:
  // - MongoDB ObjectIds -> string IDs (preserving original ID as the PG primary key)
  // - project.team embedded array -> projectMembers join table
  // - container nested objects (podConfig, networking, etc.) -> JSONB columns
  // - Encrypted fields re-encrypted with new key if needed

  console.log('Migration complete')
  process.exit(0)
}

migrate().catch(console.error)
```

### Migration Order (dependency-safe)

1. users (no foreign keys)
2. organizations (references users)
3. org_members (references organizations + users)
4. projects (references organizations + users)
5. project_members (references projects + users, extracted from project.team)
6. environments (references organizations + projects)
7. clusters (references users, optionally organizations)
8. containers (references organizations + projects + environments + users)
9. registries (references users)
10. git_providers (references users)
11. domains (references clusters)
12. audit_logs (references users)
13. invitations (references organizations + projects + users)

### Validation

After migration, run a validation script that:
- Counts records in both databases (should match)
- Spot-checks 10 random records per table for field-level equality
- Verifies all foreign key relationships resolve

---

## 10. Phase-by-Phase Implementation Plan

### Phase 0: Scaffolding (1 week)
**Priority: BLOCKING -- nothing else starts until this is done**

- [ ] Initialize pnpm workspace with turbo.json
- [ ] Move current code to `_legacy/` directory
- [ ] Create `packages/shared/` with constants, types, error codes ported from `platform/config/constants.js`
- [ ] Create `packages/db/` with Drizzle config and all schema files
- [ ] Create `compose.yml` for local dev (hanzoai/sql:18, hanzoai/kv:8)
- [ ] Run `drizzle-kit generate` to produce initial SQL migrations
- [ ] Run migrations against local PostgreSQL, verify schema
- [ ] Create `packages/db/src/seed.ts` with realistic dev data

**Deliverable**: `pnpm install && pnpm db:migrate && pnpm db:seed` works.

### Phase 1: API Core (2 weeks)
**Priority: HIGH -- backend must be solid before frontend**

- [ ] Create `packages/api/` with tRPC init, context, auth middleware
- [ ] Implement auth router (session management via next-auth)
- [ ] Implement user router (profile CRUD)
- [ ] Implement organization router (CRUD, transfer ownership)
- [ ] Implement org-team router (member management)
- [ ] Implement project router (CRUD, nested under org)
- [ ] Implement environment router (CRUD, nested under project)
- [ ] Implement container router (CRUD, the big one -- full Zod schemas for all config types)
- [ ] Implement cluster router (fleet overview, cluster detail)
- [ ] Implement registry router (CRUD, credential encryption)
- [ ] Implement git router (provider management, token encryption)
- [ ] Implement system router (health, version, cluster info)
- [ ] OpenAPI document generation at `/api/openapi.json`
- [ ] Write integration tests for all routers against test PostgreSQL

**Deliverable**: All tRPC procedures callable via curl / Postman. Tests pass.

### Phase 2: Orchestration Layer (2 weeks)
**Priority: HIGH -- this is the core differentiation**

- [ ] Create `packages/orchestrator/` with IOrchestrator interface
- [ ] Port K8s handlers to K8s adapter:
  - [ ] `deployment.ts` -> `k8s/resources/deployment.ts`
  - [ ] `statefulset.ts` -> `k8s/resources/statefulset.ts`
  - [ ] `cronjob.ts` -> `k8s/resources/cronjob.ts`
  - [ ] `service.ts` -> `k8s/resources/service.ts`
  - [ ] `ingress.ts` -> `k8s/resources/ingress.ts`
  - [ ] `ns.ts` -> `k8s/resources/namespace.ts`
  - [ ] `pvc.ts` -> `k8s/resources/pvc.ts`
  - [ ] `hpa.ts` -> `k8s/resources/hpa.ts`
  - [ ] `tekton.ts` -> `k8s/tekton.ts` (pipeline creation, webhook management)
  - [ ] `provisioner.js` -> `k8s/provisioner.ts` (DOKS lifecycle)
- [ ] Copy `handlers/manifests/` YAML templates to `k8s/manifests/`
- [ ] Implement Docker adapter:
  - [ ] Dockerode client wrapper
  - [ ] Container lifecycle (create/update/delete service)
  - [ ] Docker Compose generation from ContainerSpec
  - [ ] Swarm service management
  - [ ] Traefik label generation
  - [ ] Local Docker build
  - [ ] Log streaming
- [ ] Write tests for both adapters (K8s tests use mocked client, Docker tests use local Docker)

**Deliverable**: `createOrchestrator({ clusterType: 'kubernetes', ... })` and
`createOrchestrator({ clusterType: 'docker-swarm', ... })` both pass integration tests.

### Phase 3: Job Queue (1 week)
**Priority: HIGH -- async operations need reliable processing**

- [ ] Create `packages/jobs/` with BullMQ setup
- [ ] Implement build worker (dispatches to Tekton or Docker build)
- [ ] Implement deploy worker (applies container changes via orchestrator)
- [ ] Implement provision worker (DOKS cluster creation, async polling)
- [ ] Implement destroy worker (safe teardown with confirmation)
- [ ] Implement monitor worker (periodic health check polling)
- [ ] Dashboard integration: BullMQ dashboard at `/admin/queues` (bull-board)

**Deliverable**: Async builds and deploys work end-to-end via job queue.

### Phase 4: Frontend Shell (2 weeks)
**Priority: HIGH -- need visual proof of life**

- [ ] Create `apps/web/` Next.js 15 application
- [ ] Configure `@hanzo/ui` integration (ThemeProvider, Tailwind 4.1 config)
- [ ] Implement root layout with dark mode
- [ ] Implement auth pages (login, callback) with next-auth
- [ ] Implement dashboard layout (sidebar using `@hanzo/ui` Sidebar block, header)
- [ ] Implement fleet overview page (cluster grid)
- [ ] Implement organization list + detail pages
- [ ] Implement project list + detail pages
- [ ] Implement environment + container list pages
- [ ] tRPC React client setup with React Query

**Deliverable**: Login, see orgs, navigate to projects/environments. Read-only views work.

### Phase 5: Container Management UI (2 weeks)
**Priority: HIGH -- core user workflow**

- [ ] Container creation form (type selection, source config, networking, resources)
- [ ] Container detail page with tabs (Overview, Logs, Builds, Settings, Env Vars)
- [ ] Live log viewer (SSE streaming via tRPC subscription)
- [ ] Build history with expandable log viewer
- [ ] Environment variable editor (key-value pairs, masked values)
- [ ] Container settings forms (networking, pod config, probes, storage, scaling)
- [ ] Redeploy / rollback actions
- [ ] Container delete with confirmation

**Deliverable**: Full container lifecycle manageable through UI.

### Phase 6: Cluster Management UI (1 week)
**Priority: MEDIUM -- existing DOKS provisioning continues working**

- [ ] DOKS provisioning form (region, node size, count, HA toggle)
- [ ] Cluster status page with node pool details
- [ ] Node pool add/resize/delete
- [ ] Kubeconfig download
- [ ] Cluster destroy with double-confirmation
- [ ] Docker cluster registration (add Docker host endpoint)
- [ ] Billing/pricing display

**Deliverable**: Full cluster lifecycle manageable through UI.

### Phase 7: Data Migration (1 week)
**Priority: MEDIUM -- needed for production cutover**

- [ ] Implement `scripts/migrate-mongo-to-pg.ts`
- [ ] Test migration against staging MongoDB dump
- [ ] Verify record counts and field-level accuracy
- [ ] Document cutover procedure:
  1. Scale down old platform
  2. Run migration script
  3. Verify data
  4. Scale up new platform
  5. Update DNS / ingress to point to new service
  6. Monitor for 24h
  7. Decommission MongoDB

**Deliverable**: Migration script tested and validated.

### Phase 8: Webhook Service (1 week)
**Priority: MEDIUM -- needed for auto-deploy on push**

- [ ] Git webhook endpoints in Next.js API routes
- [ ] Webhook signature validation (GitHub HMAC, GitLab token, Bitbucket)
- [ ] Webhook -> build job enqueue
- [ ] Webhook management (create/update/delete) in git provider adapter
- [ ] Retire Go webhook service (`webhook/main.go`)

**Deliverable**: Push to connected repo triggers automatic build+deploy.

### Phase 9: Polish & Production (1 week)
**Priority: MEDIUM**

- [ ] Helm chart for K8s deployment (`k8s/` directory)
- [ ] Dockerfile for the unified Next.js app
- [ ] GitHub Actions CI/CD (build, test, push to GHCR, deploy to K8s)
- [ ] KMS integration (KMSSecret CRDs for all secrets)
- [ ] Rate limiting middleware
- [ ] Error tracking integration
- [ ] Monitoring: health endpoints, Prometheus metrics
- [ ] Audit log viewer in UI
- [ ] Team/invite management pages
- [ ] Registry management pages
- [ ] Git provider management pages
- [ ] Notification preferences
- [ ] User profile settings

**Deliverable**: Production-ready deployment.

### Phase 10: Docker Mode E2E (1 week)
**Priority: MEDIUM -- validates the dual-mode story**

- [ ] End-to-end test: create Docker Swarm cluster, deploy container, access via Traefik
- [ ] Docker Compose export (download compose.yml for a project)
- [ ] Local development mode (single-machine Docker Compose, no Swarm)
- [ ] Documentation: "Deploy to Docker" vs "Deploy to K8s" user guide

**Deliverable**: Docker mode works end-to-end, feature parity with K8s mode.

---

## Appendix A: Environment Variables

```bash
# Database
DATABASE_URL=postgresql://paas:password@localhost:5432/paas

# Redis (BullMQ + caching)
KV_URL=redis://localhost:6379

# Auth (hanzo.id)
HANZO_IAM_ISSUER=https://hanzo.id
HANZO_IAM_CLIENT_ID=hanzo-platform-client-id
HANZO_IAM_CLIENT_SECRET=<from KMS>
NEXTAUTH_SECRET=<generated>
NEXTAUTH_URL=https://platform.hanzo.ai

# DigitalOcean (DOKS provisioning)
DO_API_TOKEN=<from KMS>
DO_DEFAULT_REGION=sfo3
DO_K8S_VERSION=1.34.1-do.3

# Encryption
ENCRYPTION_KEY=<from KMS>  # For encrypting git tokens, registry credentials

# KMS
KMS_ENDPOINT=https://kms.hanzo.ai
KMS_CLIENT_ID=<from KMS>
KMS_CLIENT_SECRET=<from KMS>
```

## Appendix B: compose.yml (Local Dev)

```yaml
services:
  sql:
    image: ghcr.io/hanzoai/sql:18    # Hanzo PostgreSQL 18 fork
    environment:
      POSTGRES_DB: paas
      POSTGRES_USER: paas
      POSTGRES_PASSWORD: password
    ports:
      - "5432:5432"
    volumes:
      - sqldata:/var/lib/postgresql/data

  kv:
    image: ghcr.io/hanzoai/kv:8      # Hanzo Valkey 8 fork
    command: [valkey-server, --appendonly, "yes", --maxmemory, 256mb, --maxmemory-policy, allkeys-lru]
    ports:
      - "6379:6379"

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
      target: development
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgresql://paas:password@sql:5432/paas
      KV_URL: redis://kv:6379
      HANZO_IAM_ISSUER: https://hanzo.id
      HANZO_IAM_CLIENT_ID: hanzo-platform-client-id
    depends_on:
      - sql
      - kv
    volumes:
      - .:/app
      - /app/node_modules

volumes:
  sqldata:
```

## Appendix C: Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Data loss during MongoDB migration | Critical | Low | Dry-run migration against staging dump; keep MongoDB running during cutover; snapshot before migration |
| Docker mode feature gaps vs K8s | Medium | Medium | IOrchestrator interface enforces parity; integration tests for both adapters; explicit "not supported in Docker mode" UI indicators for K8s-only features (Tekton, HPA) |
| @hanzo/ui component gaps | Low | Medium | Audit needed components against @hanzo/ui registry; extend or wrap missing components; @hanzo/ui team can add missing primitives |
| Performance regression | Medium | Low | PostgreSQL is faster than MongoDB for relational queries; Next.js SSR reduces client-side waterfalls; BullMQ is more efficient than Socket.io polling |
| Team learning curve (tRPC, Drizzle) | Low | Medium | Both have excellent docs; similar to existing patterns (Zod = express-validator, Drizzle = Mongoose but typed); invest 2 days in team onboarding |
| Casdoor/next-auth integration issues | Medium | Low | Casdoor supports standard OIDC; next-auth has custom provider support; fallback to current auth if needed |

## Appendix D: Success Metrics

1. **Build time**: Docker image build < 3 minutes (current: ~5 min with Kaniko)
2. **Page load**: Dashboard initial load < 1.5s (SSR + streaming)
3. **API latency**: p95 < 200ms for CRUD operations
4. **Deploy time**: Container update propagation < 30s (K8s), < 15s (Docker)
5. **Migration**: Zero data loss, < 5 minutes downtime
6. **Test coverage**: > 80% for packages/api and packages/orchestrator
7. **Type safety**: Zero `any` types in tRPC procedures and client calls
