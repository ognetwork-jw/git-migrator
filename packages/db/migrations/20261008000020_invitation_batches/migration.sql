-- Invitation batches (AUTH-060, AUTH-061). Forward-only (DATA-031).

-- `unknown`: the system cannot rule out that the provider holds an invitation (a send whose outcome
-- was lost and could not be found again). It counts as outstanding until an operator resolves it.
-- (The new value is not named in any index or statement of this file: PostgreSQL cannot use an enum
-- value in the transaction that adds it.)
ALTER TYPE "app"."invitation_status" ADD VALUE 'unknown';

ALTER TABLE "app"."invitation_batch" ADD COLUMN "next_attempt_at" TIMESTAMPTZ(3);

ALTER TABLE "app"."invitation" ADD COLUMN "deselect_reason" TEXT;
ALTER TABLE "app"."invitation" ADD COLUMN "send_started_at" TIMESTAMPTZ(3);
ALTER TABLE "app"."invitation" ADD COLUMN "sent_at" TIMESTAMPTZ(3);
ALTER TABLE "app"."invitation" ADD COLUMN "invitee_login" TEXT;
-- The Route of the item's batch, the target Endpoint (the organization the invitation is sent to,
-- fixed when the item is created) and the normalised address. The defaults are placeholders: the
-- guard trigger sets all three, so that the unique indexes can say "one outstanding invitation per
-- person and per address in a target organization", across every Route that targets it.
ALTER TABLE "app"."invitation" ADD COLUMN "route_id" TEXT NOT NULL DEFAULT '';
ALTER TABLE "app"."invitation" ADD COLUMN "target_endpoint_id" TEXT NOT NULL DEFAULT '';
ALTER TABLE "app"."invitation" ADD COLUMN "email_normalised" TEXT NOT NULL DEFAULT '';
UPDATE "app"."invitation" i SET "route_id" = b."route_id", "target_endpoint_id" = r."target_endpoint_id",
  "email_normalised" = translate(btrim(i."email"), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
  FROM "app"."invitation_batch" b JOIN "app"."route" r ON r."id" = b."route_id" WHERE b."id" = i."batch_id";
ALTER TABLE "app"."invitation"
  ADD CONSTRAINT "invitation_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "app"."route"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "app"."invitation"
  ADD CONSTRAINT "invitation_target_endpoint_id_fkey" FOREIGN KEY ("target_endpoint_id") REFERENCES "app"."endpoint"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- One item per Identity in a batch.
CREATE UNIQUE INDEX "invitation_batch_id_source_identity_id_key"
  ON "app"."invitation" ("batch_id", "source_identity_id");
CREATE INDEX "invitation_source_identity_id_idx" ON "app"."invitation" ("source_identity_id");

-- AUTH-061: at most one outstanding invitation per person and per address in a target organization
-- (every Route that targets the same Endpoint shares it), whatever the API or a job does. An item is outstanding unless it ended: `selected` (it can still be sent),
-- `sent` and `unknown` (the provider may hold the invitation) count. `selected` only exists in a
-- batch that is not finished, so no denormalised flag is needed. The predicate names the ended
-- states, so it needs no enum value added in this file.
-- The address is compared as: spaces trimmed at both ends, ASCII letters lower-cased (the API does
-- the same in `normaliseEmail`).
CREATE UNIQUE INDEX "invitation_outstanding_person_key"
  ON "app"."invitation" ("target_endpoint_id", "source_identity_id") WHERE "status" NOT IN ('deselected', 'failed', 'expired', 'accepted');
CREATE UNIQUE INDEX "invitation_outstanding_address_key"
  ON "app"."invitation" ("target_endpoint_id", "email_normalised") WHERE "status" NOT IN ('deselected', 'failed', 'expired', 'accepted');

-- A deselection's identity_excluded Expected Difference is tied to its item, so reselecting revokes
-- exactly that one and never an exclusion the operator made on the mapping (AUTH-060 step 3).
ALTER TABLE "app"."expected_difference" ADD COLUMN "invitation_id" TEXT;
CREATE INDEX "expected_difference_invitation_id_idx" ON "app"."expected_difference" ("invitation_id");
ALTER TABLE "app"."expected_difference"
  ADD CONSTRAINT "expected_difference_invitation_id_fkey"
  FOREIGN KEY ("invitation_id") REFERENCES "app"."invitation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AUTH-061 in the database: nothing becomes `sent` unless its batch was approved by an Actor, and
-- the content of an approved batch cannot change. The send job checks the same things; this is the
-- last line when some other writer gets it wrong.
CREATE FUNCTION "app"."invitation_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  batch "app"."invitation_batch"%ROWTYPE;
BEGIN
  SELECT * INTO batch FROM "app"."invitation_batch" WHERE "id" = NEW."batch_id";
  NEW."route_id" := batch."route_id";
  NEW."email_normalised" := translate(btrim(NEW."email"), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
  -- The organization is fixed when the item is created: a Route that later moves to another target
  -- does not move an invitation that may already be there.
  IF TG_OP = 'INSERT' THEN
    SELECT "target_endpoint_id" INTO NEW."target_endpoint_id" FROM "app"."route" WHERE "id" = batch."route_id";
  ELSE
    NEW."target_endpoint_id" := OLD."target_endpoint_id";
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF batch."status" <> 'draft' OR NEW."status" NOT IN ('selected', 'deselected') THEN
      RAISE EXCEPTION 'invitations can only be added to a draft batch' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."batch_id" <> OLD."batch_id" OR NEW."source_identity_id" <> OLD."source_identity_id"
     OR NEW."email" <> OLD."email" OR NEW."team_slugs" <> OLD."team_slugs" THEN
    IF batch."status" <> 'draft' OR NEW."batch_id" <> OLD."batch_id" THEN
      RAISE EXCEPTION 'the content of an approved invitation batch cannot change' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."status" = OLD."status" THEN
    RETURN NEW;
  END IF;
  -- Nothing becomes selected (or deselected) outside a draft.
  IF NEW."status" IN ('selected', 'deselected') AND batch."status" <> 'draft' THEN
    RAISE EXCEPTION 'an approved batch cannot be edited' USING ERRCODE = '23514';
  END IF;
  IF batch."status" = 'draft' THEN
    IF NOT (OLD."status" IN ('selected', 'deselected') AND NEW."status" IN ('selected', 'deselected')) THEN
      RAISE EXCEPTION 'a draft batch item can only be selected or deselected' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."status" = 'sent' THEN
    -- From `selected`: the batch must be approved and sending. From `unknown` (an operator saying the
    -- invitation was sent): the batch must have been approved, whatever state it is in now.
    IF batch."approved_at" IS NULL OR batch."approved_by_id" IS NULL
       OR NOT ((OLD."status" = 'selected' AND batch."status" IN ('approved', 'sending'))
               OR OLD."status" = 'unknown') THEN
      RAISE EXCEPTION 'an invitation can only be sent from an approved batch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "invitation_guard" BEFORE INSERT OR UPDATE ON "app"."invitation"
  FOR EACH ROW EXECUTE FUNCTION "app"."invitation_guard"();

CREATE FUNCTION "app"."invitation_batch_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'draft' OR NEW."approved_by_id" IS NOT NULL OR NEW."approved_at" IS NOT NULL THEN
      RAISE EXCEPTION 'a batch starts as a draft without an approval' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."route_id" <> OLD."route_id" THEN
    RAISE EXCEPTION 'the Route of a batch cannot change' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'draft' AND NEW."status" <> 'draft' THEN
    IF NEW."status" <> 'approved' OR NEW."approved_by_id" IS NULL OR NEW."approved_at" IS NULL THEN
      RAISE EXCEPTION 'a draft batch can only become approved, with its approver' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD."status" <> 'draft' AND NEW."status" = 'draft' THEN
    RAISE EXCEPTION 'an approved batch cannot go back to draft' USING ERRCODE = '23514';
  ELSIF OLD."status" IN ('sent', 'partial') AND NEW."status" <> OLD."status"
        AND NOT (OLD."status" = 'sent' AND NEW."status" = 'partial') THEN
    RAISE EXCEPTION 'a finished batch cannot be reopened' USING ERRCODE = '23514';
  ELSIF OLD."status" = 'sending' AND NEW."status" = 'approved' THEN
    RAISE EXCEPTION 'a batch that started sending cannot go back to approved' USING ERRCODE = '23514';
  END IF;
  IF OLD."approved_at" IS NOT NULL AND (NEW."approved_at" IS DISTINCT FROM OLD."approved_at"
     OR NEW."approved_by_id" IS DISTINCT FROM OLD."approved_by_id") THEN
    RAISE EXCEPTION 'the approval of a batch cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "invitation_batch_guard" BEFORE INSERT OR UPDATE ON "app"."invitation_batch"
  FOR EACH ROW EXECUTE FUNCTION "app"."invitation_batch_guard"();
