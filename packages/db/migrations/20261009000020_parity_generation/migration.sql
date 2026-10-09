-- Parity Check ordering (T-072, ADR-0396): bumped by every stored check; a check that started before
-- the latest stored one is discarded under the Migration lock.
ALTER TABLE "app"."migration" ADD COLUMN "parity_generation" BIGINT NOT NULL DEFAULT 0;
