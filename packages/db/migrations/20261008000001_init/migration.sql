-- pg_trgm backs the trigram index on repository.full_path. The migrate entrypoint creates it in step 1
-- (DATA-030) as well; repeating it here keeps `zen migrate deploy` usable on its own. Idempotent.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "app";

-- CreateEnum
CREATE TYPE "app"."actor_kind" AS ENUM ('human', 'service');

-- CreateEnum
CREATE TYPE "app"."role" AS ENUM ('viewer', 'operator', 'admin');

-- CreateEnum
CREATE TYPE "app"."endpoint_status" AS ENUM ('active', 'retired');

-- CreateEnum
CREATE TYPE "app"."source_presence" AS ENUM ('present', 'missing');

-- CreateEnum
CREATE TYPE "app"."size_class" AS ENUM ('standard', 'large');

-- CreateEnum
CREATE TYPE "app"."migration_scope" AS ENUM ('repository', 'endpoint');

-- CreateEnum
CREATE TYPE "app"."migration_status" AS ENUM ('discovered', 'analyzed', 'running', 'migrated', 'failed', 'partial', 'verified', 'manually_completed', 'drifted', 'rolled_back', 'source_missing');

-- CreateEnum
CREATE TYPE "app"."readiness" AS ENUM ('ready', 'needs_attention', 'blocked');

-- CreateEnum
CREATE TYPE "app"."plan_item_kind" AS ENUM ('step', 'blocker', 'pre_task', 'post_task', 'warning');

-- CreateEnum
CREATE TYPE "app"."run_kind" AS ENUM ('migrate', 'run_anyway', 'resync', 'verify', 'rollback', 'source_read_only', 'undo_source_read_only');

-- CreateEnum
CREATE TYPE "app"."run_status" AS ENUM ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "app"."step_status" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "app"."task_status" AS ENUM ('open', 'done', 'dismissed');

-- CreateEnum
CREATE TYPE "app"."expected_difference_reason" AS ENUM ('framework_mutation', 'overlay', 'lossy_accepted', 'identity_excluded', 'manual_accepted', 'unreadable_defaulted');

-- CreateEnum
CREATE TYPE "app"."mapping_status" AS ENUM ('suggested', 'confirmed', 'excluded', 'pending_invite', 'unmapped');

-- CreateEnum
CREATE TYPE "app"."invitation_batch_status" AS ENUM ('draft', 'approved', 'sending', 'sent', 'partial');

-- CreateEnum
CREATE TYPE "app"."invitation_status" AS ENUM ('selected', 'deselected', 'sent', 'accepted', 'failed', 'expired');

-- CreateTable
CREATE TABLE "app"."actor" (
    "id" TEXT NOT NULL,
    "kind" "app"."actor_kind" NOT NULL,
    "display_name" TEXT NOT NULL,
    "email" TEXT,
    "role" "app"."role" NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "auth_user_id" TEXT,
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "actor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."api_key" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "api_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."endpoint" (
    "id" TEXT NOT NULL,
    "provider_type" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "status" "app"."endpoint_status" NOT NULL,
    "config_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "endpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."route" (
    "id" TEXT NOT NULL,
    "source_endpoint_id" TEXT NOT NULL,
    "target_endpoint_id" TEXT NOT NULL,
    "target_namespace_id" TEXT,
    "target_namespace_path" TEXT NOT NULL,
    "policies" JSONB NOT NULL,
    "defaults" JSONB NOT NULL,
    "config_hash" TEXT NOT NULL,
    "source_post_action" TEXT NOT NULL,
    "retired_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."namespace" (
    "id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "kind" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "key" TEXT,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "namespace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."repository" (
    "id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "namespace_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "full_path" TEXT NOT NULL,
    "is_private" BOOLEAN NOT NULL,
    "size_bytes" BIGINT,
    "size_class" "app"."size_class" NOT NULL DEFAULT 'standard',
    "presence" "app"."source_presence" NOT NULL DEFAULT 'present',
    "default_branch" TEXT,
    "lfs_bytes" BIGINT,
    "provider_updated_at" TIMESTAMPTZ(3),
    "last_inventoried_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."migration" (
    "id" TEXT NOT NULL,
    "scope" "app"."migration_scope" NOT NULL,
    "route_id" TEXT NOT NULL,
    "source_repository_id" TEXT,
    "target_repository_id" TEXT,
    "planned_target_name" TEXT,
    "status" "app"."migration_status" NOT NULL DEFAULT 'discovered',
    "status_before_run" "app"."migration_status",
    "status_before_drift" "app"."migration_status",
    "status_before_manual" "app"."migration_status",
    "status_before_missing" "app"."migration_status",
    "run_blockers" JSONB NOT NULL DEFAULT '[]',
    "readiness" "app"."readiness",
    "readiness_counts" JSONB,
    "blocker_codes" TEXT[],
    "latest_analysis_id" TEXT,
    "analysis_stale_at" TIMESTAMPTZ(3),
    "target_created_by_framework" BOOLEAN NOT NULL DEFAULT false,
    "source_read_only_applied" BOOLEAN NOT NULL DEFAULT false,
    "wave_id" TEXT,
    "verified_at" TIMESTAMPTZ(3),
    "manual_completion" JSONB,
    "last_parity_at" TIMESTAMPTZ(3),
    "last_drift_check_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "migration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."facet_snapshot" (
    "id" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "repository_id" TEXT,
    "facet_key" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "unreadable" TEXT[],
    "hash" TEXT NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL,
    "raw_response_ids" TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "facet_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."raw_response" (
    "id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "body" JSONB,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "raw_response_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."analysis" (
    "id" TEXT NOT NULL,
    "migration_id" TEXT NOT NULL,
    "source_snapshot_ids" TEXT[],
    "target_snapshot_ids" TEXT[],
    "readiness" "app"."readiness" NOT NULL,
    "translation" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "analysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."plan_item" (
    "id" TEXT NOT NULL,
    "analysis_id" TEXT NOT NULL,
    "facet_key" TEXT NOT NULL,
    "kind" "app"."plan_item_kind" NOT NULL,
    "code" TEXT NOT NULL,
    "fidelity" TEXT,
    "field_paths" TEXT[],
    "params" JSONB NOT NULL,
    "order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plan_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."run" (
    "id" TEXT NOT NULL,
    "migration_id" TEXT NOT NULL,
    "analysis_id" TEXT,
    "kind" "app"."run_kind" NOT NULL,
    "status" "app"."run_status" NOT NULL DEFAULT 'queued',
    "triggered_by_id" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMPTZ(3),
    "reaper_resumes" INTEGER NOT NULL DEFAULT 0,
    "has_mutations" BOOLEAN NOT NULL DEFAULT false,
    "error" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."run_step" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "step_key" TEXT NOT NULL,
    "facet_key" TEXT,
    "order" INTEGER NOT NULL,
    "status" "app"."step_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "error" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "run_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."run_log" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "step_id" TEXT,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,

    CONSTRAINT "run_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."mutation" (
    "id" TEXT NOT NULL,
    "migration_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "facet_key" TEXT NOT NULL,
    "resource_ref" JSONB NOT NULL,
    "paths" TEXT[],
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "undone_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mutation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."manual_task" (
    "id" TEXT NOT NULL,
    "migration_id" TEXT NOT NULL,
    "facet_key" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "verifiable" BOOLEAN NOT NULL,
    "status" "app"."task_status" NOT NULL DEFAULT 'open',
    "completed_by_id" TEXT,
    "completed_at" TIMESTAMPTZ(3),
    "note" TEXT,
    "source_plan_item_id" TEXT,
    "params_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manual_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."expected_difference" (
    "id" TEXT NOT NULL,
    "route_id" TEXT NOT NULL,
    "migration_id" TEXT,
    "facet_key" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "reason" "app"."expected_difference_reason" NOT NULL,
    "note" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "expected_difference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."parity_result" (
    "id" TEXT NOT NULL,
    "migration_id" TEXT NOT NULL,
    "facet_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "diffs" JSONB NOT NULL,
    "excluded" JSONB NOT NULL,
    "checked_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "parity_result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."identity" (
    "id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "login" TEXT,
    "display_name" TEXT,
    "email" TEXT,
    "email_source" TEXT,
    "kind" TEXT NOT NULL,
    "is_member" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."group" (
    "id" TEXT NOT NULL,
    "endpoint_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "member_ids" TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."identity_mapping" (
    "id" TEXT NOT NULL,
    "route_id" TEXT NOT NULL,
    "source_identity_id" TEXT NOT NULL,
    "target_identity_id" TEXT,
    "status" "app"."mapping_status" NOT NULL,
    "method" TEXT,
    "confidence" DOUBLE PRECISION,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "identity_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."group_mapping" (
    "id" TEXT NOT NULL,
    "route_id" TEXT NOT NULL,
    "source_group_id" TEXT NOT NULL,
    "target_group_id" TEXT,
    "planned_slug" TEXT NOT NULL,
    "status" "app"."mapping_status" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "group_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."invitation_batch" (
    "id" TEXT NOT NULL,
    "route_id" TEXT NOT NULL,
    "status" "app"."invitation_batch_status" NOT NULL DEFAULT 'draft',
    "seat_preview" JSONB NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invitation_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."invitation" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "source_identity_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "team_slugs" TEXT[],
    "status" "app"."invitation_status" NOT NULL DEFAULT 'selected',
    "provider_invitation_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."wave" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target_date" TIMESTAMPTZ(3),
    "description" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "wave_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."naming_rule" (
    "id" TEXT NOT NULL,
    "route_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scope_ref" TEXT NOT NULL,
    "pipeline" JSONB NOT NULL,
    "override" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "naming_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."webhook_allowlist_entry" (
    "id" TEXT NOT NULL,
    "route_id" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webhook_allowlist_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."overlay" (
    "id" TEXT NOT NULL,
    "route_id" TEXT NOT NULL,
    "facet_key" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "overlay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."audit_event" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "data" JSONB,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."quota_event" (
    "id" BIGSERIAL NOT NULL,
    "bucket_key" TEXT NOT NULL,
    "pool" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quota_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."quota_lease" (
    "id" BIGSERIAL NOT NULL,
    "bucket_key" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quota_lease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."quota_state" (
    "bucket_key" TEXT NOT NULL,
    "limit_per_window" INTEGER NOT NULL,
    "window_seconds" INTEGER NOT NULL,
    "remaining" INTEGER,
    "reset_at" TIMESTAMPTZ(3),
    "blocked_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quota_state_pkey" PRIMARY KEY ("bucket_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "actor_auth_user_id_key" ON "app"."actor"("auth_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_key_prefix_key" ON "app"."api_key"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "namespace_endpoint_id_provider_id_key" ON "app"."namespace"("endpoint_id", "provider_id");

-- CreateIndex
CREATE INDEX "repository_endpoint_id_namespace_id_idx" ON "app"."repository"("endpoint_id", "namespace_id");

-- CreateIndex
CREATE INDEX "repository_full_path_trgm_idx" ON "app"."repository" USING GIN ("full_path" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "repository_endpoint_id_provider_id_key" ON "app"."repository"("endpoint_id", "provider_id");

-- CreateIndex
CREATE INDEX "migration_route_id_status_readiness_idx" ON "app"."migration"("route_id", "status", "readiness");

-- CreateIndex
CREATE INDEX "migration_wave_id_idx" ON "app"."migration"("wave_id");

-- CreateIndex
CREATE INDEX "migration_blocker_codes_idx" ON "app"."migration" USING GIN ("blocker_codes");

-- CreateIndex
CREATE UNIQUE INDEX "migration_route_id_source_repository_id_key" ON "app"."migration"("route_id", "source_repository_id");

-- CreateIndex
CREATE INDEX "facet_snapshot_repository_id_facet_key_side_fetched_at_idx" ON "app"."facet_snapshot"("repository_id", "facet_key", "side", "fetched_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "manual_task_migration_id_code_facet_key_params_hash_key" ON "app"."manual_task"("migration_id", "code", "facet_key", "params_hash");

-- CreateIndex
CREATE UNIQUE INDEX "identity_endpoint_id_provider_id_key" ON "app"."identity"("endpoint_id", "provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_endpoint_id_provider_id_key" ON "app"."group"("endpoint_id", "provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "identity_mapping_route_id_source_identity_id_key" ON "app"."identity_mapping"("route_id", "source_identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_mapping_route_id_source_group_id_key" ON "app"."group_mapping"("route_id", "source_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "wave_name_key" ON "app"."wave"("name");

-- CreateIndex
CREATE UNIQUE INDEX "naming_rule_route_id_scope_scope_ref_key" ON "app"."naming_rule"("route_id", "scope", "scope_ref");

-- CreateIndex
CREATE INDEX "audit_event_at_idx" ON "app"."audit_event"("at" DESC);

-- CreateIndex
CREATE INDEX "audit_event_subject_type_subject_id_idx" ON "app"."audit_event"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "quota_event_bucket_key_at_idx" ON "app"."quota_event"("bucket_key", "at");

-- CreateIndex
CREATE INDEX "quota_lease_bucket_key_expires_at_idx" ON "app"."quota_lease"("bucket_key", "expires_at");

-- AddForeignKey
ALTER TABLE "app"."api_key" ADD CONSTRAINT "api_key_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "app"."actor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."route" ADD CONSTRAINT "route_source_endpoint_id_fkey" FOREIGN KEY ("source_endpoint_id") REFERENCES "app"."endpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."route" ADD CONSTRAINT "route_target_endpoint_id_fkey" FOREIGN KEY ("target_endpoint_id") REFERENCES "app"."endpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."route" ADD CONSTRAINT "route_target_namespace_id_fkey" FOREIGN KEY ("target_namespace_id") REFERENCES "app"."namespace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."namespace" ADD CONSTRAINT "namespace_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "app"."endpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."namespace" ADD CONSTRAINT "namespace_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "app"."namespace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."repository" ADD CONSTRAINT "repository_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "app"."endpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."repository" ADD CONSTRAINT "repository_namespace_id_fkey" FOREIGN KEY ("namespace_id") REFERENCES "app"."namespace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."migration" ADD CONSTRAINT "migration_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "app"."route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."migration" ADD CONSTRAINT "migration_source_repository_id_fkey" FOREIGN KEY ("source_repository_id") REFERENCES "app"."repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."migration" ADD CONSTRAINT "migration_target_repository_id_fkey" FOREIGN KEY ("target_repository_id") REFERENCES "app"."repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."migration" ADD CONSTRAINT "migration_latest_analysis_id_fkey" FOREIGN KEY ("latest_analysis_id") REFERENCES "app"."analysis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."migration" ADD CONSTRAINT "migration_wave_id_fkey" FOREIGN KEY ("wave_id") REFERENCES "app"."wave"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."facet_snapshot" ADD CONSTRAINT "facet_snapshot_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "app"."endpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."facet_snapshot" ADD CONSTRAINT "facet_snapshot_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "app"."repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."raw_response" ADD CONSTRAINT "raw_response_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "app"."endpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."analysis" ADD CONSTRAINT "analysis_migration_id_fkey" FOREIGN KEY ("migration_id") REFERENCES "app"."migration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."plan_item" ADD CONSTRAINT "plan_item_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "app"."analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."run" ADD CONSTRAINT "run_migration_id_fkey" FOREIGN KEY ("migration_id") REFERENCES "app"."migration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."run" ADD CONSTRAINT "run_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "app"."analysis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."run" ADD CONSTRAINT "run_triggered_by_id_fkey" FOREIGN KEY ("triggered_by_id") REFERENCES "app"."actor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."run_step" ADD CONSTRAINT "run_step_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "app"."run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."run_log" ADD CONSTRAINT "run_log_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "app"."run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."run_log" ADD CONSTRAINT "run_log_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "app"."run_step"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."mutation" ADD CONSTRAINT "mutation_migration_id_fkey" FOREIGN KEY ("migration_id") REFERENCES "app"."migration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."mutation" ADD CONSTRAINT "mutation_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "app"."run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."manual_task" ADD CONSTRAINT "manual_task_migration_id_fkey" FOREIGN KEY ("migration_id") REFERENCES "app"."migration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."manual_task" ADD CONSTRAINT "manual_task_completed_by_id_fkey" FOREIGN KEY ("completed_by_id") REFERENCES "app"."actor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."manual_task" ADD CONSTRAINT "manual_task_source_plan_item_id_fkey" FOREIGN KEY ("source_plan_item_id") REFERENCES "app"."plan_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."expected_difference" ADD CONSTRAINT "expected_difference_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "app"."route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."expected_difference" ADD CONSTRAINT "expected_difference_migration_id_fkey" FOREIGN KEY ("migration_id") REFERENCES "app"."migration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."expected_difference" ADD CONSTRAINT "expected_difference_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "app"."actor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."parity_result" ADD CONSTRAINT "parity_result_migration_id_fkey" FOREIGN KEY ("migration_id") REFERENCES "app"."migration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."identity" ADD CONSTRAINT "identity_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "app"."endpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."group" ADD CONSTRAINT "group_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "app"."endpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."identity_mapping" ADD CONSTRAINT "identity_mapping_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "app"."route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."identity_mapping" ADD CONSTRAINT "identity_mapping_source_identity_id_fkey" FOREIGN KEY ("source_identity_id") REFERENCES "app"."identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."identity_mapping" ADD CONSTRAINT "identity_mapping_target_identity_id_fkey" FOREIGN KEY ("target_identity_id") REFERENCES "app"."identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."identity_mapping" ADD CONSTRAINT "identity_mapping_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "app"."actor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."group_mapping" ADD CONSTRAINT "group_mapping_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "app"."route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."group_mapping" ADD CONSTRAINT "group_mapping_source_group_id_fkey" FOREIGN KEY ("source_group_id") REFERENCES "app"."group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."group_mapping" ADD CONSTRAINT "group_mapping_target_group_id_fkey" FOREIGN KEY ("target_group_id") REFERENCES "app"."group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."invitation_batch" ADD CONSTRAINT "invitation_batch_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "app"."route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."invitation_batch" ADD CONSTRAINT "invitation_batch_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "app"."actor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."invitation_batch" ADD CONSTRAINT "invitation_batch_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "app"."actor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."invitation" ADD CONSTRAINT "invitation_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "app"."invitation_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."invitation" ADD CONSTRAINT "invitation_source_identity_id_fkey" FOREIGN KEY ("source_identity_id") REFERENCES "app"."identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."naming_rule" ADD CONSTRAINT "naming_rule_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "app"."route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."webhook_allowlist_entry" ADD CONSTRAINT "webhook_allowlist_entry_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "app"."route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."overlay" ADD CONSTRAINT "overlay_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "app"."route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."audit_event" ADD CONSTRAINT "audit_event_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "app"."actor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
