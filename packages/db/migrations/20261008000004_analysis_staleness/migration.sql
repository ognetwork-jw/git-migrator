-- Rolling mean of provider calls per Analysis, per Route (JOB-020, ADR-0310). Starts at 30.
ALTER TABLE "app"."route" ADD COLUMN "avg_calls_per_analysis" DOUBLE PRECISION NOT NULL DEFAULT 30;

-- API-012: a write to a NamingRule, WebhookAllowlistEntry or Overlay marks the Route's Analyses
-- stale (LIF-021). Done in the database so it commits with the write, whichever client made it, and
-- so no code path can forget it. `analysis_stale_at` is the instant an Analysis becomes stale
-- (LIF-020 step 7): a Migration already stale keeps its earlier instant.
CREATE FUNCTION "app"."mark_route_analyses_stale"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    affected := OLD."route_id";
  ELSE
    affected := NEW."route_id";
  END IF;
  UPDATE "app"."migration"
     SET "analysis_stale_at" = clock_timestamp()
   WHERE "route_id" = affected
     AND "latest_analysis_id" IS NOT NULL
     AND ("analysis_stale_at" IS NULL OR "analysis_stale_at" > clock_timestamp());
  IF TG_OP = 'UPDATE' AND OLD."route_id" IS DISTINCT FROM NEW."route_id" THEN
    UPDATE "app"."migration"
       SET "analysis_stale_at" = clock_timestamp()
     WHERE "route_id" = OLD."route_id"
       AND "latest_analysis_id" IS NOT NULL
       AND ("analysis_stale_at" IS NULL OR "analysis_stale_at" > clock_timestamp());
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "naming_rule_marks_stale"
  AFTER INSERT OR UPDATE OR DELETE ON "app"."naming_rule"
  FOR EACH ROW EXECUTE FUNCTION "app"."mark_route_analyses_stale"();

CREATE TRIGGER "webhook_allowlist_entry_marks_stale"
  AFTER INSERT OR UPDATE OR DELETE ON "app"."webhook_allowlist_entry"
  FOR EACH ROW EXECUTE FUNCTION "app"."mark_route_analyses_stale"();

CREATE TRIGGER "overlay_marks_stale"
  AFTER INSERT OR UPDATE OR DELETE ON "app"."overlay"
  FOR EACH ROW EXECUTE FUNCTION "app"."mark_route_analyses_stale"();
