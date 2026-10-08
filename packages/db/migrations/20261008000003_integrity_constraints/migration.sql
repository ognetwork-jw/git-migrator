-- Integrity rules that ZModel cannot express: a CHECK constraint and updated_at triggers.
-- Forward-only (DATA-031): nothing here drops or renames an object. Prisma ignores both when it
-- diffs, so `zen migrate dev` neither knows nor removes them.

-- Ties Migration.scope to sourceRepositoryId: an endpoint-scope Migration has no source Repository
-- and a repository-scope Migration always has one (DOM-014, 03-domain-model). The table is empty or
-- consistent on every deployment because nothing writes a repository-scope Migration without its
-- source Repository.
ALTER TABLE "app"."migration"
  ADD CONSTRAINT "migration_scope_source_repository_check"
  CHECK (("scope" = 'endpoint') = ("source_repository_id" IS NULL));

-- updated_at on Migration and ManualTask is set by the database. The ORM's @updatedAt would write
-- the column in every update, and the field-level @deny('update') on updatedAt (DOM-011: operators
-- must not rewrite timestamps through RPC) would then reject allowed updates of waveId and note.
CREATE FUNCTION "app"."set_updated_at"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."updated_at" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "migration_set_updated_at"
  BEFORE UPDATE ON "app"."migration"
  FOR EACH ROW EXECUTE FUNCTION "app"."set_updated_at"();

CREATE TRIGGER "manual_task_set_updated_at"
  BEFORE UPDATE ON "app"."manual_task"
  FOR EACH ROW EXECUTE FUNCTION "app"."set_updated_at"();
