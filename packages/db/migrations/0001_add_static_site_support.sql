-- Add Cloudflare Pages and GitHub Pages support
-- Extends cluster_type, cluster_provider, container_type enums
-- Adds static_site_config JSONB column to containers

ALTER TYPE "public"."cluster_type" ADD VALUE IF NOT EXISTS 'cloudflare-pages';--> statement-breakpoint
ALTER TYPE "public"."cluster_type" ADD VALUE IF NOT EXISTS 'github-pages';--> statement-breakpoint
ALTER TYPE "public"."cluster_provider" ADD VALUE IF NOT EXISTS 'cloudflare';--> statement-breakpoint
ALTER TYPE "public"."cluster_provider" ADD VALUE IF NOT EXISTS 'github';--> statement-breakpoint
ALTER TYPE "public"."container_type" ADD VALUE IF NOT EXISTS 'static-site';--> statement-breakpoint
ALTER TABLE "containers" ADD COLUMN "static_site_config" jsonb;
