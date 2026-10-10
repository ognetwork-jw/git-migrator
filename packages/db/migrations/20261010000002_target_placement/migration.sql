-- Where the framework wrote a Migration's target (T-097, ADR-0504): a Route retargeted afterwards
-- must not split the Migration, and its rollback reverts where the writes went.
ALTER TABLE "app"."migration" ADD COLUMN "target_placed_endpoint_id" TEXT;
ALTER TABLE "app"."migration" ADD COLUMN "target_placed_namespace_id" TEXT;
ALTER TABLE "app"."migration" ADD COLUMN "target_placement_unknown" BOOLEAN NOT NULL DEFAULT false;

-- Existing Migrations are pinned only from evidence: their target repository's place.
UPDATE "app"."migration" m SET "target_placed_endpoint_id" = r."endpoint_id", "target_placed_namespace_id" = r."namespace_id"
  FROM "app"."repository" r WHERE r."id" = m."target_repository_id";
-- Target writes with no repository (an endpoint Migration, or a creation never linked): the Route
-- may have been retargeted since, so the place is unknown. The pin stays empty, and a rollback asks
-- the operator to confirm the place before it reverts anything.
UPDATE "app"."migration" m SET "target_placement_unknown" = true
  WHERE m."target_placed_endpoint_id" IS NULL
    AND EXISTS (SELECT 1 FROM "app"."mutation" x WHERE x."migration_id" = m."id" AND x."side" = 'target'
      AND x."undone_at" IS NULL AND x."state" <> 'not_applied'
      AND coalesce(x."resource_ref"->>'adopted', 'false') <> 'true'
      AND coalesce(x."resource_ref"->>'noop', 'false') <> 'true');

ALTER TABLE "app"."migration" ADD CONSTRAINT "migration_target_placed_endpoint_id_fkey" FOREIGN KEY ("target_placed_endpoint_id") REFERENCES "app"."endpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "app"."migration" ADD CONSTRAINT "migration_target_placed_namespace_id_fkey" FOREIGN KEY ("target_placed_namespace_id") REFERENCES "app"."namespace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
