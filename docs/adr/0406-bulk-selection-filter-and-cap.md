# ADR-0406: Bulk selection: explicit ids or a saved filter, 200 at most, a 422 above it

- Status: agent-decided
- Date: 2026-10-09
- Task: T-088
- Affects: LIF-090, API-020, UI-021

## Context

LIF-090 says bulk actions "apply to an explicit selection or a saved filter" and caps analyze at 200 per request. It does not say what a filter is, what the cap is for the other actions, or what happens above the cap. The task asks for bounded bulk sizes.

## Decision

- The body takes exactly one of `ids` (at most 1000 entries in the array, so a huge body is a plain 422; at most 200 distinct ids) and `filter`; both or neither is a 422 `validation_failed`.
- `filter` is the filter of the repositories list (UI-021) with `routeId` required: `namespaceId`, `status` (`unmigrated` by default, `all`, or one status), `readiness`, `sizeClass`, `waveId`, `blockerCode`, `hasOpenTasks`, `search`. It is resolved on the server to repository-scope Migrations (the same `where` as the list's `buildWhere`, repeated in `bulk.ts` `filterWhere` because the API package cannot import the web app).
- The cap is 200 for every action, not only analyze: one request is a bounded unit of work (a Run per item, one audit event per item). A selection or a filter that matches more than 200 is a 422 with the path (`ids` or `filter`) and the limit; nothing is acted on. The user narrows the filter or works in batches.
- Unknown ids are not an error: they come back in `skipped` as `not_found`, so a stale selection (a Migration deleted by another user) is reported item by item.
- The web bar sends the ids of the rows selected across pages (it does not send a filter), and disables its buttons above 200 with a message.

## Alternatives

- Truncating to the first 200 and reporting the rest as skipped: silently acts on a subset the user did not choose.
- A cap of 200 only for analyze and an unbounded Run creation: an unbounded loop of locked transactions in one request.
