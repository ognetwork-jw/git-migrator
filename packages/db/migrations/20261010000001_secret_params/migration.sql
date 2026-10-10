-- Secret guidance parameters (T-097, ADR-0503): a webhook URL may carry a credential, so it is kept
-- apart from `params`, and viewers cannot read it (field-level read deny in schema.zmodel).
ALTER TABLE "app"."plan_item" ADD COLUMN "secret_params" JSONB;
ALTER TABLE "app"."manual_task" ADD COLUMN "secret_params" JSONB;

-- Rows written before this migration held the URL in params: it moves to secret_params, and params
-- gets its display form as the application writes it (`redactWebhookUrl`: the origin, then `/…`;
-- never userinfo, path or query). Only http(s) URLs have a display form.
-- Rolling upgrade: pods of the previous version may still write params.targetUrl after this ran.
-- Every write path of the new version (an Analysis persisting, a Run adding a task) moves such
-- values of its Migration the same way first (`moveLegacySecretParams`), so they are cleaned on
-- the Migration's next Analysis or Run finding; until then they read as before.
CREATE FUNCTION "app"."gm_target_url_display"(url TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN url ~* '^https?://[^/?#]' THEN
    lower(substring(url from '^([A-Za-z]+)://')) || '://' ||
    regexp_replace(lower(substring(url from '^[A-Za-z]+://(?:[^/?#@]*@)?([^/?#]*)')),
      CASE WHEN url ~* '^https:' THEN ':443$' ELSE ':80$' END, '') || '/…'
  END
$$;
UPDATE "app"."plan_item" SET
  "secret_params" = jsonb_build_object('targetUrl', "params"->'targetUrl'),
  "params" = ("params" - 'targetUrl') || CASE
    WHEN "params" ? 'targetUrlDisplay' OR "app"."gm_target_url_display"("params"->>'targetUrl') IS NULL THEN '{}'::jsonb
    ELSE jsonb_build_object('targetUrlDisplay', "app"."gm_target_url_display"("params"->>'targetUrl')) END
  WHERE "params" ? 'targetUrl';
UPDATE "app"."manual_task" SET
  "secret_params" = jsonb_build_object('targetUrl', "params"->'targetUrl'),
  "params" = ("params" - 'targetUrl') || CASE
    WHEN "params" ? 'targetUrlDisplay' OR "app"."gm_target_url_display"("params"->>'targetUrl') IS NULL THEN '{}'::jsonb
    ELSE jsonb_build_object('targetUrlDisplay', "app"."gm_target_url_display"("params"->>'targetUrl')) END
  WHERE "params" ? 'targetUrl';
DROP FUNCTION "app"."gm_target_url_display"(TEXT);
