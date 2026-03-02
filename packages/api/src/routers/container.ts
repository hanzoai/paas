import { z } from 'zod'
import { router, projectProcedure, getOrchestrator, isOrgRoleAtLeast } from '../trpc'
import type { OrgRole } from '../trpc'
import { containers, environments, clusters, clusterPermissions, organizations, environmentApprovals } from '@paas/db/schema'
import { eq, and } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import { createId } from '@paralleldrive/cuid2'

export const containerRouter = router({
  // List containers in an environment
  list: projectProcedure
    .input(z.object({
      orgId: z.string(),
      projectId: z.string(),
      environmentId: z.string(),
    }))
    .query(async ({ ctx, input }) => {
      return ctx.db.query.containers.findMany({
        where: and(
          eq(containers.environmentId, input.environmentId),
          eq(containers.projectId, input.projectId),
        ),
      })
    }),

  // Get container details
  get: projectProcedure
    .input(z.object({
      orgId: z.string(),
      projectId: z.string(),
      containerId: z.string(),
    }))
    .query(async ({ ctx, input }) => {
      const container = await ctx.db.query.containers.findFirst({
        where: eq(containers.id, input.containerId),
      })
      if (!container) throw new TRPCError({ code: 'NOT_FOUND' })
      return container
    }),

  // Create a new container (works on both K8s and Docker)
  create: projectProcedure
    .input(z.object({
      orgId: z.string(),
      projectId: z.string(),
      environmentId: z.string(),
      clusterId: z.string(),
      name: z.string().min(2).max(64),
      type: z.enum(['deployment', 'statefulset', 'cronjob', 'static-site']),
      sourceType: z.enum(['repo', 'registry']).default('repo'),
      repoConfig: z.object({
        provider: z.string().optional(),
        url: z.string().optional(),
        branch: z.string().optional(),
        path: z.string().default('/'),
        dockerfile: z.string().default('Dockerfile'),
        gitProviderId: z.string().optional(),
      }).optional(),
      registryConfig: z.object({
        registryId: z.string().optional(),
        imageName: z.string(),
        imageTag: z.string(),
      }).optional(),
      networking: z.object({
        containerPort: z.number(),
        ingress: z.object({ enabled: z.boolean(), type: z.enum(['path', 'subdomain']).optional() }).optional(),
        customDomain: z.string().optional(),
      }).optional(),
      podConfig: z.object({
        cpuRequest: z.number().default(100),
        cpuLimit: z.number().default(500),
        memoryRequest: z.number().default(128),
        memoryLimit: z.number().default(512),
        restartPolicy: z.enum(['Always', 'OnFailure', 'Never']).default('Always'),
      }).optional(),
      variables: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
      deploymentConfig: z.object({
        replicas: z.number().default(1),
        strategy: z.enum(['RollingUpdate', 'Recreate']).default('RollingUpdate'),
      }).optional(),
      staticSiteConfig: z.object({
        buildCommand: z.string(),
        outputDir: z.string(),
        installCommand: z.string().optional(),
        nodeVersion: z.string().optional(),
        framework: z.string().optional(),
        envVars: z.record(z.string()).optional(),
      }).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // --- Cluster permission check ---
      // Org Owners and Admins have implicit full access; everyone else needs
      // an explicit 'deploy' or 'manage' permission on the target cluster.
      if (!isOrgRoleAtLeast(ctx.org.role as OrgRole, 'Admin')) {
        const perm = await ctx.db.query.clusterPermissions.findFirst({
          where: and(
            eq(clusterPermissions.clusterId, input.clusterId),
            eq(clusterPermissions.userId, ctx.user.id),
          ),
        })
        if (!perm || perm.role === 'view') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have deploy permission on this cluster',
          })
        }
      }

      // --- Environment protection check ---
      const env = await ctx.db.query.environments.findFirst({
        where: eq(environments.id, input.environmentId),
      })
      if (!env) throw new TRPCError({ code: 'NOT_FOUND', message: 'Environment not found' })

      if (env.protectionLevel !== 'none' || env.approvalRequired) {
        const isAllowlisted = env.allowedUserIds?.includes(ctx.user.id) ?? false
        const isOwner = ctx.org.role === 'Owner'
        const isAdmin = isOrgRoleAtLeast(ctx.org.role as OrgRole, 'Admin')

        // Enforce protection level (allowlisted users bypass)
        if (env.protectionLevel !== 'none' && !isAllowlisted) {
          if (env.protectionLevel === 'locked' && !isOwner) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'This environment is locked — only the Owner can deploy',
            })
          }
          if (env.protectionLevel === 'restricted' && !isAdmin && !isOwner) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'This environment is restricted — only Admin or Owner can deploy',
            })
          }
        }

        // If approval required and user is not Admin/Owner, create approval instead of deploying
        if (env.approvalRequired && !isAdmin && !isOwner) {
          const [approval] = await ctx.db.insert(environmentApprovals).values({
            environmentId: input.environmentId,
            requestedBy: ctx.user.id,
          }).returning()

          return { pendingApproval: true, approvalId: approval.id } as any
        }
      }

      const slug = `${input.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${createId().slice(0, 8)}`

      // Insert DB record
      const [container] = await ctx.db.insert(containers).values({
        iid: `ctr-${createId().slice(0, 12)}`,
        slug,
        name: input.name,
        type: input.type,
        orgId: input.orgId,
        projectId: input.projectId,
        environmentId: input.environmentId,
        clusterId: input.clusterId,
        sourceType: input.sourceType,
        repoConfig: input.repoConfig ?? null,
        registryConfig: input.registryConfig ?? null,
        networking: input.networking ?? { containerPort: 80 },
        podConfig: input.podConfig ?? { cpuRequest: 100, cpuLimit: 500, memoryRequest: 128, memoryLimit: 512, restartPolicy: 'Always' as const },
        deploymentConfig: input.deploymentConfig ?? { replicas: 1, strategy: 'RollingUpdate' as const },
        staticSiteConfig: input.staticSiteConfig ?? null,
        variables: input.variables,
        createdBy: ctx.user.id,
      }).returning()

      // Deploy via orchestrator (backend-agnostic — works on K8s or Docker)
      if (input.registryConfig) {
        const orch = await getOrchestrator(ctx.db, input.clusterId)

        // Ensure namespace exists (idempotent — ignore if already created)
        await orch.createNamespace(env.iid).catch(() => {})

        await orch.createContainer({
          namespace: env.iid,
          name: slug,
          type: input.type,
          image: `${input.registryConfig.imageName}:${input.registryConfig.imageTag}`,
          variables: input.variables,
          networking: container.networking as any,
          podConfig: container.podConfig as any,
          deploymentConfig: container.deploymentConfig as any,
        })
      }

      return container
    }),

  // Delete container
  delete: projectProcedure
    .input(z.object({
      orgId: z.string(),
      projectId: z.string(),
      containerId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const container = await ctx.db.query.containers.findFirst({
        where: eq(containers.id, input.containerId),
      })
      if (!container) throw new TRPCError({ code: 'NOT_FOUND' })

      const env = await ctx.db.query.environments.findFirst({
        where: eq(environments.id, container.environmentId),
      })

      // Remove from orchestrator
      if (env) {
        try {
          const orch = await getOrchestrator(ctx.db, container.clusterId)
          await orch.deleteContainer(env.iid, container.slug, container.type)
        } catch {
          // Container may not exist in orchestrator — still delete DB record
        }
      }

      await ctx.db.delete(containers).where(eq(containers.id, input.containerId))
    }),

  // Get live status from orchestrator
  status: projectProcedure
    .input(z.object({
      orgId: z.string(),
      projectId: z.string(),
      containerId: z.string(),
    }))
    .query(async ({ ctx, input }) => {
      const container = await ctx.db.query.containers.findFirst({
        where: eq(containers.id, input.containerId),
      })
      if (!container) throw new TRPCError({ code: 'NOT_FOUND' })

      const env = await ctx.db.query.environments.findFirst({
        where: eq(environments.id, container.environmentId),
      })
      if (!env) throw new TRPCError({ code: 'NOT_FOUND' })

      const orch = await getOrchestrator(ctx.db, container.clusterId)
      return orch.getContainerStatus(env.iid, container.slug, container.type)
    }),

  // Scale container replicas
  scale: projectProcedure
    .input(z.object({
      orgId: z.string(),
      projectId: z.string(),
      containerId: z.string(),
      replicas: z.number().min(0).max(100),
    }))
    .mutation(async ({ ctx, input }) => {
      const container = await ctx.db.query.containers.findFirst({
        where: eq(containers.id, input.containerId),
      })
      if (!container) throw new TRPCError({ code: 'NOT_FOUND' })

      const env = await ctx.db.query.environments.findFirst({
        where: eq(environments.id, container.environmentId),
      })
      if (!env) throw new TRPCError({ code: 'NOT_FOUND' })

      const orch = await getOrchestrator(ctx.db, container.clusterId)
      await orch.scaleContainer(env.iid, container.slug, input.replicas)

      // Update DB
      await ctx.db.update(containers)
        .set({
          deploymentConfig: { ...(container.deploymentConfig as any), replicas: input.replicas },
        })
        .where(eq(containers.id, input.containerId))
    }),
})
