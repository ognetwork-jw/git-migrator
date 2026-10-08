-- Failure marker of the Analysis (ADR-0312): the feeder backs off from a Migration whose Analysis
-- keeps failing. Cleared by a successful Analysis and by anything that marks the Route stale.
ALTER TABLE "app"."migration" ADD COLUMN "analysis_failed_at" TIMESTAMPTZ(3);
ALTER TABLE "app"."migration" ADD COLUMN "analysis_failure_count" INTEGER NOT NULL DEFAULT 0;
-- When the feeder may try again (database clock): filtered in SQL, so Migrations in a long backoff
-- never crowd out healthy ones.
ALTER TABLE "app"."migration" ADD COLUMN "analysis_retry_at" TIMESTAMPTZ(3);

-- Bumped by every marker, unconditionally, including for Migrations that are already stale or were
-- never analyzed. An Analysis remembers the value it started with; a different value at the end
-- means something changed meanwhile and the result is stale from the start (ADR-0310).
ALTER TABLE "app"."migration" ADD COLUMN "stale_generation" BIGINT NOT NULL DEFAULT 0;

-- When the Analysis started, on the database clock, so concurrent Analyses of one Migration are
-- ordered without comparing clocks of different workers (ADR-0310).
ALTER TABLE "app"."analysis" ADD COLUMN "started_at" TIMESTAMPTZ(3);

-- The Expected Differences an Analysis records itself are unique while active, so concurrent
-- Analyses cannot insert the same record twice (INSERT ... ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX "expected_difference_analysis_unique"
  ON "app"."expected_difference" (
    "route_id", COALESCE("migration_id", ''), "facet_key", "path", "reason", COALESCE("note", '')
  )
  WHERE "revoked_at" IS NULL AND "reason" IN ('lossy_accepted', 'unreadable_defaulted');

-- API-012 staleness, now per statement: one UPDATE per statement for the distinct Routes, and one
-- `migration.updated` event (empty ids: topic list:migrations) when something was marked.
-- A Route change also clears the failure markers, so a fix is picked up promptly.
DROP TRIGGER "naming_rule_marks_stale" ON "app"."naming_rule";
DROP TRIGGER "webhook_allowlist_entry_marks_stale" ON "app"."webhook_allowlist_entry";
DROP TRIGGER "overlay_marks_stale" ON "app"."overlay";
DROP FUNCTION "app"."mark_route_analyses_stale"();

CREATE FUNCTION "app"."mark_routes_stale"(route_ids text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  touched integer;
BEGIN
  IF route_ids IS NULL OR cardinality(route_ids) = 0 THEN
    RETURN;
  END IF;
  -- Lock the rows in id order first: every other multi-row writer of Migrations (the JS marker,
  -- syncConfig) locks in id order too, while this UPDATE would lock in plan order and could
  -- deadlock with them.
  PERFORM 1 FROM "app"."migration" WHERE "route_id" = ANY (route_ids) ORDER BY "id" FOR UPDATE;
  -- A Route change lets the feeder try again at once; the failure count is kept, so the next
  -- failure resumes at the previous backoff step. Only a successful Analysis resets it.
  UPDATE "app"."migration"
     SET "stale_generation" = "stale_generation" + 1,
         "analysis_failed_at" = NULL,
         "analysis_retry_at" = NULL,
         "analysis_stale_at" = CASE
           WHEN "latest_analysis_id" IS NOT NULL
                AND ("analysis_stale_at" IS NULL OR "analysis_stale_at" > clock_timestamp())
           THEN clock_timestamp()
           ELSE "analysis_stale_at"
         END
   WHERE "route_id" = ANY (route_ids);
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched > 0 THEN
    PERFORM pg_notify(
      'gm_events',
      json_build_object(
        'type', 'migration.updated',
        'ids', '{}'::json,
        'at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )::text
    );
  END IF;
END;
$$;

CREATE FUNCTION "app"."stale_after_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "app"."mark_routes_stale"(ARRAY(SELECT DISTINCT "route_id" FROM new_rows));
  RETURN NULL;
END;
$$;

CREATE FUNCTION "app"."stale_after_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "app"."mark_routes_stale"(ARRAY(SELECT DISTINCT "route_id" FROM old_rows));
  RETURN NULL;
END;
$$;

CREATE FUNCTION "app"."stale_after_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "app"."mark_routes_stale"(
    ARRAY(SELECT "route_id" FROM new_rows UNION SELECT "route_id" FROM old_rows)
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER "naming_rule_stale_insert" AFTER INSERT ON "app"."naming_rule"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "app"."stale_after_insert"();
CREATE TRIGGER "naming_rule_stale_update" AFTER UPDATE ON "app"."naming_rule"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "app"."stale_after_update"();
CREATE TRIGGER "naming_rule_stale_delete" AFTER DELETE ON "app"."naming_rule"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION "app"."stale_after_delete"();

CREATE TRIGGER "webhook_allowlist_entry_stale_insert" AFTER INSERT ON "app"."webhook_allowlist_entry"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "app"."stale_after_insert"();
CREATE TRIGGER "webhook_allowlist_entry_stale_update" AFTER UPDATE ON "app"."webhook_allowlist_entry"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "app"."stale_after_update"();
CREATE TRIGGER "webhook_allowlist_entry_stale_delete" AFTER DELETE ON "app"."webhook_allowlist_entry"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION "app"."stale_after_delete"();

CREATE TRIGGER "overlay_stale_insert" AFTER INSERT ON "app"."overlay"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "app"."stale_after_insert"();
CREATE TRIGGER "overlay_stale_update" AFTER UPDATE ON "app"."overlay"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "app"."stale_after_update"();
CREATE TRIGGER "overlay_stale_delete" AFTER DELETE ON "app"."overlay"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION "app"."stale_after_delete"();

-- TRUNCATE fires no row or transition-table trigger: it marks every Route.
CREATE FUNCTION "app"."stale_after_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "app"."mark_routes_stale"(ARRAY(SELECT "id" FROM "app"."route"));
  RETURN NULL;
END;
$$;

CREATE TRIGGER "naming_rule_stale_truncate" AFTER TRUNCATE ON "app"."naming_rule"
  FOR EACH STATEMENT EXECUTE FUNCTION "app"."stale_after_truncate"();
CREATE TRIGGER "webhook_allowlist_entry_stale_truncate" AFTER TRUNCATE ON "app"."webhook_allowlist_entry"
  FOR EACH STATEMENT EXECUTE FUNCTION "app"."stale_after_truncate"();
CREATE TRIGGER "overlay_stale_truncate" AFTER TRUNCATE ON "app"."overlay"
  FOR EACH STATEMENT EXECUTE FUNCTION "app"."stale_after_truncate"();
