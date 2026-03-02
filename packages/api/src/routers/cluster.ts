import { z } from 'zod'
import { router, orgProcedure, authedProcedure, getOrchestrator, isOrgRoleAtLeast } from '../trpc'
import type { OrgRole } from '../trpc'
import { clusters, clusterPermissions, orgMembers, organizations } from '@paas/db/schema'
import { eq, and } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'

export const clusterRouter = router({
  // List all clusters across all orgs the user belongs to (fleet view)
  listAll: authedProcedure.query(async ({ ctx }) => {
    const memberships = await ctx.db.query.orgMembers.findMany({
      where: eq(orgMembers.userId, ctx.user.id),
    })
    if (memberships.length === 0) return []

    const orgIds = memberships.map((m) => m.orgId)
    const allClusters = await ctx.db.query.clusters.findMany({
      where: (c, { inArray }) => inArray(c.orgId, orgIds),
    })

    // Attach org info
    const orgs = await ctx.db.query.organizations.findMany({
      where: (o, { inArray }) => inArray(o.id, orgIds),
    })
    const orgMap = new Map(orgs.map((o) => [o.id, o]))

    return allClusters.map((c) => ({
      ...c,
      orgName: orgMap.get(c.orgId ?? '')?.name ?? 'Unknown',
    }))
  }),

  // List all clusters for an org (multi-cluster fleet)
  list: orgProcedure
    .input(z.object({ orgId: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.db.query.clusters.findMany({
        where: eq(clusters.orgId, input.orgId),
      })
    }),

  // Get cluster details
  get: orgProcedure
    .input(z.object({ orgId: z.string(), clusterId: z.string() }))
    .query(async ({ ctx, input }) => {
      const cluster = await ctx.db.query.clusters.findFirst({
        where: and(eq(clusters.id, input.clusterId), eq(clusters.orgId, input.orgId)),
      })
      if (!cluster) throw new TRPCError({ code: 'NOT_FOUND' })
      return cluster
    }),

  // Register a new cluster (K8s, Docker Swarm, Docker Compose, Cloudflare Pages, or GitHub Pages)
  register: orgProcedure
    .input(z.object({
      orgId: z.string(),
      name: z.string().min(2).max(64),
      type: z.enum(['kubernetes', 'docker-swarm', 'docker-compose', 'cloudflare-pages', 'github-pages']),
      provider: z.enum(['digitalocean', 'aws', 'gcp', 'azure', 'hetzner', 'bare-metal', 'local', 'cloudflare', 'github']),
      endpoint: z.string().optional(),
      kubeconfig: z.string().optional(),
      tlsCert: z.string().optional(),
      tlsKey: z.string().optional(),
      tlsCa: z.string().optional(),
      cloudMeta: z.record(z.unknown()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const slug = `${input.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${Date.now().toString(36)}`

      const [cluster] = await ctx.db.insert(clusters).values({
        slug,
        name: input.name,
        type: input.type,
        provider: input.provider,
        status: 'provisioning',
        endpoint: input.endpoint,
        kubeconfig: input.kubeconfig,
        tlsCert: input.tlsCert,
        tlsKey: input.tlsKey,
        tlsCa: input.tlsCa,
        cloudMeta: input.cloudMeta,
        orgId: input.orgId,
        createdBy: ctx.user.id,
      }).returning()

      // Verify connectivity
      try {
        const orch = await getOrchestrator(ctx.db, cluster.id)
        const ok = await orch.ping()
        if (ok) {
          await ctx.db.update(clusters)
            .set({ status: 'running' })
            .where(eq(clusters.id, cluster.id))
          cluster.status = 'running'
        }
      } catch {
        await ctx.db.update(clusters)
          .set({ status: 'error' })
          .where(eq(clusters.id, cluster.id))
        cluster.status = 'error'
      }

      return cluster
    }),

  // Remove a cluster from the fleet
  remove: orgProcedure
    .input(z.object({ orgId: z.string(), clusterId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (!isOrgRoleAtLeast(ctx.org.role as OrgRole, 'Admin')) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only owners or admins can remove clusters' })
      }
      await ctx.db.delete(clusters)
        .where(and(eq(clusters.id, input.clusterId), eq(clusters.orgId, input.orgId)))
    }),

  // Health check / ping
  ping: orgProcedure
    .input(z.object({ orgId: z.string(), clusterId: z.string() }))
    .query(async ({ ctx, input }) => {
      const orch = await getOrchestrator(ctx.db, input.clusterId)
      return { healthy: await orch.ping() }
    }),

  // Get cluster info (nodes, resources, version)
  info: orgProcedure
    .input(z.object({ orgId: z.string(), clusterId: z.string() }))
    .query(async ({ ctx, input }) => {
      const orch = await getOrchestrator(ctx.db, input.clusterId)
      return orch.getClusterInfo()
    }),

  // --- Cluster-level permissions ---

  // Grant cluster access to an org member (Admin/Owner only)
  grantAccess: orgProcedure
    .input(z.object({
      orgId: z.string(),
      clusterId: z.string(),
      userId: z.string(),
      role: z.enum(['manage', 'deploy', 'view']),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!isOrgRoleAtLeast(ctx.org.role as OrgRole, 'Admin')) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only owners or admins can grant cluster access' })
      }

      // Verify target user is an org member
      const member = await ctx.db.query.orgMembers.findFirst({
        where: and(eq(orgMembers.orgId, input.orgId), eq(orgMembers.userId, input.userId)),
      })
      if (!member) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'User is not a member of this organization' })
      }

      // Verify cluster belongs to org
      const cluster = await ctx.db.query.clusters.findFirst({
        where: and(eq(clusters.id, input.clusterId), eq(clusters.orgId, input.orgId)),
      })
      if (!cluster) throw new TRPCError({ code: 'NOT_FOUND', message: 'Cluster not found in this org' })

      // Upsert: insert or update existing permission
      const existing = await ctx.db.query.clusterPermissions.findFirst({
        where: and(
          eq(clusterPermissions.clusterId, input.clusterId),
          eq(clusterPermissions.userId, input.userId),
        ),
      })

      if (existing) {
        await ctx.db.update(clusterPermissions)
          .set({ role: input.role, grantedBy: ctx.user.id, updatedAt: new Date() })
          .where(eq(clusterPermissions.id, existing.id))
        return { ...existing, role: input.role }
      }

      const [perm] = await ctx.db.insert(clusterPermissions).values({
        clusterId: input.clusterId,
        userId: input.userId,
        role: input.role,
        grantedBy: ctx.user.id,
      }).returning()

      return perm
    }),

  // Revoke cluster access from a user (Admin/Owner only)
  revokeAccess: orgProcedure
    .input(z.object({
      orgId: z.string(),
      clusterId: z.string(),
      userId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!isOrgRoleAtLeast(ctx.org.role as OrgRole, 'Admin')) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only owners or admins can revoke cluster access' })
      }

      await ctx.db.delete(clusterPermissions)
        .where(and(
          eq(clusterPermissions.clusterId, input.clusterId),
          eq(clusterPermissions.userId, input.userId),
        ))
    }),

  // List who has access to a cluster
  listPermissions: orgProcedure
    .input(z.object({ orgId: z.string(), clusterId: z.string() }))
    .query(async ({ ctx, input }) => {
      // Verify cluster belongs to org
      const cluster = await ctx.db.query.clusters.findFirst({
        where: and(eq(clusters.id, input.clusterId), eq(clusters.orgId, input.orgId)),
      })
      if (!cluster) throw new TRPCError({ code: 'NOT_FOUND', message: 'Cluster not found in this org' })

      return ctx.db.query.clusterPermissions.findMany({
        where: eq(clusterPermissions.clusterId, input.clusterId),
      })
    }),
})
