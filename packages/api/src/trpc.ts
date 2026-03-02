import { initTRPC, TRPCError } from '@trpc/server'
import { db } from '@paas/db'
import { orgMembers, projectMembers } from '@paas/db/schema'
import { createOrchestrator, type CloudflarePagesConnection, type GitHubPagesConnection } from '@paas/orchestrator'
import { clusters } from '@paas/db/schema'
import { eq, and } from 'drizzle-orm'
import { isOrgRoleAtLeast } from '@paas/shared/constants'
import type { OrgRole } from '@paas/shared/constants'
import type { Database } from '@paas/db'
import type { IOrchestrator } from '@paas/orchestrator'

export { isOrgRoleAtLeast }
export type { OrgRole }

export interface Context {
  db: Database
  session: { user: { id: string; email: string; isClusterOwner: boolean; canCreateOrg: boolean } } | null
}

const t = initTRPC.context<Context>().create()

export const router = t.router
export const publicProcedure = t.procedure

// Authenticated — requires valid session
export const authedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }
  return next({ ctx: { ...ctx, user: ctx.session.user } })
})

// Org-scoped — verifies user is member of the org
export const orgProcedure = authedProcedure.use(async (opts) => {
  const rawInput = await (opts as any).getRawInput()
  // getRawInput() returns the tRPC wire format: { json: { ... } } or the plain object
  const input = (rawInput as any)?.json ?? rawInput
  const orgId = (input as Record<string, unknown>)?.orgId as string | undefined
  if (!orgId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'orgId is required' })

  const membership = await opts.ctx.db.query.orgMembers.findFirst({
    where: and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, opts.ctx.user.id)),
  })
  if (!membership) throw new TRPCError({ code: 'FORBIDDEN' })
  return opts.next({ ctx: { ...opts.ctx, org: { id: orgId, role: membership.role } } })
})

// Project-scoped — verifies user has access to the project
export const projectProcedure = orgProcedure.use(async (opts) => {
  const rawInput = await (opts as any).getRawInput()
  const input = (rawInput as any)?.json ?? rawInput
  const projectId = (input as Record<string, unknown>)?.projectId as string | undefined
  if (!projectId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' })

  const membership = await opts.ctx.db.query.projectMembers.findFirst({
    where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, (opts.ctx as any).user.id)),
  })
  // Org Owners and Admins have implicit access to all projects
  if (!membership && !isOrgRoleAtLeast((opts.ctx as any).org.role as OrgRole, 'Admin')) {
    throw new TRPCError({ code: 'FORBIDDEN' })
  }
  return opts.next({ ctx: { ...opts.ctx, project: { id: projectId, role: membership?.role ?? 'Admin' } } })
})

// Helper: get orchestrator for a cluster
export async function getOrchestrator(db: Database, clusterId: string): Promise<IOrchestrator> {
  const cluster = await db.query.clusters.findFirst({
    where: eq(clusters.id, clusterId),
  })
  if (!cluster) throw new TRPCError({ code: 'NOT_FOUND', message: 'Cluster not found' })

  switch (cluster.type) {
    case 'kubernetes': {
      if (!cluster.kubeconfig) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Cluster has no kubeconfig' })
      return createOrchestrator({
        clusterType: 'kubernetes',
        connection: { kind: 'kubernetes', kubeconfig: cluster.kubeconfig },
      })
    }
    case 'cloudflare-pages': {
      const meta = cluster.cloudMeta as { accountId?: string; apiToken?: string } | null
      if (!meta?.accountId || !meta?.apiToken) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Cluster missing Cloudflare credentials in cloudMeta' })
      }
      return createOrchestrator({
        clusterType: 'cloudflare-pages',
        connection: { kind: 'cloudflare-pages', accountId: meta.accountId, apiToken: meta.apiToken } satisfies CloudflarePagesConnection,
      })
    }
    case 'github-pages': {
      const meta = cluster.cloudMeta as { token?: string; owner?: string } | null
      if (!meta?.token || !meta?.owner) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Cluster missing GitHub credentials in cloudMeta' })
      }
      return createOrchestrator({
        clusterType: 'github-pages',
        connection: { kind: 'github-pages', token: meta.token, owner: meta.owner } satisfies GitHubPagesConnection,
      })
    }
    default:
      return createOrchestrator({
        clusterType: cluster.type,
        connection: {
          kind: 'docker',
          host: cluster.endpoint ?? 'unix:///var/run/docker.sock',
          tlsCert: cluster.tlsCert ?? undefined,
          tlsKey: cluster.tlsKey ?? undefined,
          tlsCa: cluster.tlsCa ?? undefined,
        },
      })
  }
}
