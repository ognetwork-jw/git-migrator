# ADR-0121: Domain model details the spec left open

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-010
- Affects: DOM-001, DOM-003, DOM-004, DOM-013, DOM-014, DATA-030

## Context

03-domain-model.md is a field list. Turning it into ZModel and into a config sync needed several decisions.

## Decision

1. **`Route.retiredAt DateTime?` is added.** DATA-030 step 5 says to "mark missing ones retired" for Endpoints and Routes, but only `Endpoint` has a `status`. A nullable timestamp on `Route` records when config sync stopped seeing it, and clears when it returns. Nothing else about `Route` changes.
2. **Config sync creates the endpoint-scope Migration** (DOM-014: "exists for every Route"). Inventory creates only repository-scope Migrations. The partial unique index `migration(route_id) WHERE scope = 'endpoint'` backs it. Sync does not delete a retired Route's Migrations.
3. **A Route's `configHash` change** sets `Migration.analysisStaleAt = now()` for that Route's Migrations that have a `latestAnalysisId` (LIF-021 staleness lives on the Migration, because Analyses are immutable, DOM-012). A changed target endpoint or `targetNamespacePath` also clears `Route.targetNamespaceId`, which is only valid for the old target.
4. **The hash is computed by the caller** over the whole configured entry (`hashConfig` = SHA-256 of the RFC 8785 form, from `core`). `db` cannot import `config` (ARC-012), so `syncConfig` takes plain `EndpointSpec`/`RouteSpec` values and `apps/worker/src/db-commands.ts` maps `Config` to them. `Endpoint.displayName` has no config source and is the endpoint id.
5. **Every `DateTime` is `timestamptz(3)`** (`@db.Timestamptz(3)`). The spec says nothing; Prisma's default `timestamp(3)` has no zone and node-pg reads it in local time.
6. **Deletion is explicit on every relation.** Prisma's default for an optional relation is `SetNull`, which would contradict DOM-004 ("restricted by default"), so every relation names `onDelete`. `Restrict` everywhere, except `Cascade` for `RunStep.run`, `RunLog.run`, `PlanItem.analysis`; `SetNull` for `Migration.latestAnalysis`, `ManualTask.sourcePlanItem` (DOM-004) and `Migration.wave` (DOM-013). `RunLog.step` is `NoAction` (checked at the end of the statement) so that deleting a Run cascades to both steps and logs in one statement.
7. **JSON columns are plain `Json`.** DOM-001 describes typed JSON, but the payload of `FacetSnapshot.data`, `Analysis.translation` and `Overlay.data` depends on `facetKey`, so no single ZenStack `type` can describe it, and `db` may not import facet schemas. The writers (analysis, inventory, the RPC mount for `Overlay`/`NamingRule`) validate with the Zod schemas from `canonical`/`core` on write and on read. A `type` for the fixed-shape columns (`Route.policies`, `NamingRule.pipeline`) would duplicate the Zod schemas that already own them (config, `core`).
8. **Table names are singular snake_case** (`facet_snapshot`, `quota_event`), as in the DATA-011 index list; enum types are `@@map`ped the same way.
9. **Seeded test Actors have no `authUserId`.** Better Auth users are created by T-020; sign-in links by email.

## Alternatives

- A `RouteStatus` enum instead of `retiredAt`: more ceremony for the same information.
- Creating the endpoint-scope Migration lazily on first use: DOM-014 says it exists for every Route, and the unique index would make a race an error.
