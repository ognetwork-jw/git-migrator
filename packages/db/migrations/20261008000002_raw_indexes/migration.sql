-- Raw-SQL indexes (DATA-011) that ZModel cannot express: partial indexes.
-- The other DATA-011 indexes (including the pg_trgm index on repository.full_path) are declared with
-- @@index in schema.zmodel and created by the init migration. Forward-only (DATA-031): nothing here
-- drops or renames an object.
--
-- Prisma ignores partial indexes when it diffs, so `zen migrate dev` neither knows nor drops them.
-- A test (migrations.test.ts) asserts that they exist and enforce their invariant.

-- DOM-010: at most one queued or running Run per Migration.
CREATE UNIQUE INDEX "run_one_active_per_migration_key"
  ON "app"."run" ("migration_id")
  WHERE "status" IN ('queued', 'running');

-- DOM-014: one endpoint-scope Migration per Route.
CREATE UNIQUE INDEX "migration_one_endpoint_scope_per_route_key"
  ON "app"."migration" ("route_id")
  WHERE "scope" = 'endpoint';

-- Active (not revoked) Expected Differences, looked up per Route, Migration and Facet.
CREATE INDEX "expected_difference_active_idx"
  ON "app"."expected_difference" ("route_id", "migration_id", "facet_key")
  WHERE "revoked_at" IS NULL;
