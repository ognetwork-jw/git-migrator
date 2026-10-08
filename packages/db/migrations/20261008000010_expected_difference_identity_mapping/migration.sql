-- Ties an identity_excluded Expected Difference to the Identity Mapping whose exclusion created it
-- (AUTH-050 step 4), so revocation does not depend on the free-text note. Forward-only (DATA-031).
ALTER TABLE "app"."expected_difference" ADD COLUMN "identity_mapping_id" TEXT;

CREATE INDEX "expected_difference_identity_mapping_id_idx"
  ON "app"."expected_difference" ("identity_mapping_id");

ALTER TABLE "app"."expected_difference"
  ADD CONSTRAINT "expected_difference_identity_mapping_id_fkey"
  FOREIGN KEY ("identity_mapping_id") REFERENCES "app"."identity_mapping"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
