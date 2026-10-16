-- The batched retention delete (DATA-020, `maintenance.prune`) selects raw responses by age; without
-- this index every batch scans the whole table. Forward-only (DATA-031): additive.
CREATE INDEX "raw_response_fetched_at_idx" ON "app"."raw_response"("fetched_at");
