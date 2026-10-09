-- Run executor (T-070, ADR-0340 to ADR-0343).

-- Cooperative cancel (LIF-040): the API sets it; the executor checks it between Steps and polls it
-- while a Step runs, then aborts the Step's signal.
ALTER TABLE "app"."run" ADD COLUMN "cancel_requested_at" TIMESTAMPTZ(3);

-- How often the Run was delayed at this Step (rate limit, scratch space): JOB-015 fails the Run
-- after 6 delays.
ALTER TABLE "app"."run_step" ADD COLUMN "delays" INTEGER NOT NULL DEFAULT 0;

-- Attempts that ended in a retryable failure or a worker crash: the retry budget of a Step. Delays
-- do not use it (ADR-0341).
ALTER TABLE "app"."run_step" ADD COLUMN "failures" INTEGER NOT NULL DEFAULT 0;

-- The severity the Step was planned with, so a Step that leaves the plan on a resume keeps its
-- meaning for the Run's outcome (ADR-0341).
ALTER TABLE "app"."run_step" ADD COLUMN "severity" TEXT;

-- Integrity backstop: no two Steps of a Run share a position. Rows are matched by identity
-- (run_step_run_id_identity_key below), not by position.
CREATE UNIQUE INDEX "run_step_run_id_order_key" ON "app"."run_step"("run_id", "order");

-- A framework_mutation Expected Difference is unique while active, so a resumed Step that records
-- the same Mutation path again adds nothing (INSERT ... ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX "expected_difference_framework_mutation_unique"
  ON "app"."expected_difference" ("migration_id", "facet_key", "path")
  WHERE "revoked_at" IS NULL AND "reason" = 'framework_mutation' AND "migration_id" IS NOT NULL;

-- Recording order of the Mutation ledger: a rollback undoes newest first, and created_at has only
-- millisecond resolution (ADR-0342).
ALTER TABLE "app"."mutation" ADD COLUMN "seq" BIGSERIAL NOT NULL;
CREATE UNIQUE INDEX "mutation_seq_key" ON "app"."mutation"("seq");

-- A Step is identified by its key and Facet, so a plan that changes between a Run's start and a
-- resume adds Step rows instead of shifting the old ones (ADR-0340).
CREATE UNIQUE INDEX "run_step_run_id_identity_key"
  ON "app"."run_step" ("run_id", "step_key", COALESCE("facet_key", ''));

-- `intended` is written before the provider call and `recorded` or `not_applied` after it; an
-- intent that was never confirmed may have been applied, so undo treats it as applied (ADR-0342).
ALTER TABLE "app"."mutation" ADD COLUMN "state" TEXT NOT NULL DEFAULT 'recorded';

-- Which Step wrote a record (open intents are found again on a resume), whether the record is part
-- of the desired document, and the Expected Differences it caused (revoked if the intent turns out
-- not to have been applied). ADR-0342.
ALTER TABLE "app"."mutation" ADD COLUMN "written_by_step" TEXT;
ALTER TABLE "app"."mutation" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'desired';
ALTER TABLE "app"."mutation" ADD COLUMN "derived_differences" JSONB NOT NULL DEFAULT '[]';
