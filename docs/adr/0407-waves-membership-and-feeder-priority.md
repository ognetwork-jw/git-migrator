# ADR-0407: Wave membership: capability, no staleness, CRUD through the Model API, priority already in the feeder

- Status: accepted (spec updated)
- Date: 2026-10-09
- Task: T-088
- Affects: LIF-090, JOB-022, UI-024, AUTH-020, DOM-013

## Context

LIF-090: waves have `name`, optional `targetDate`, `description`; wave members get priority in background analysis (JOB-022). UI-024: `/waves` CRUD, and `/waves/[id]` with a status breakdown and a repository table pre-filtered to the Wave. The Wave model and the feeder's wave ordering exist already (T-061).

## Decision

- Assign and remove need `manageWaves` (operator); analyze and migrate-ready need `operate`. Both are operator today, but the checks follow the AUTH-020 row for what is changed.
- Wave membership is not an input to Analysis, so assigning does not call `markAnalysesStale`. Remove-from-wave with a `waveId` removes only Migrations that are in that Wave (others are `not_in_wave`).
- "Wave priority reaches the feeder" is proven end to end by `bulk.test.ts`: Migrations assigned through the bulk endpoint are enqueued before older unassigned ones by `runFeeder`. No feeder change was needed: `candidatesFor` already orders wave never-analyzed, wave stale, never analyzed, stale.
- Wave create, edit and delete use the Model API (`wave` allows operator and admin to create, update and delete; deleting unsets `Migration.waveId`, DOM-013), so there is no second write path. The RPC audit plugin records them.
- Progress and the detail page's status breakdown read `GET /dashboard` (up to 200 Waves, flagged when truncated), so a Wave with more members than a page does not need an extra count query.
- The detail page opens the embedded repository list on the Route of one of the Wave's repositories; a Wave can span Routes, and the Route selector stays available. The list opens with the status filter `all` so finished repositories show.

## Alternatives

- A dedicated `/api/v1/waves` CRUD: duplicates a policy the Model API already enforces.
- Per-Wave `groupBy` queries from the browser: the RPC allow-list does not expose aggregation.
