# ADR-0350: Dashboard and repositories list: data access, Facet badges, selection, shared live connection

- Status: agent-decided
- Date: 2026-10-09
- Task: T-081
- Affects: UI-020, UI-021, UI-022, API-011, API-012, AUTH-021, JOB-060, LIF-043, UI-001

## Context

UI-021 asks for a server-paginated table with server-side sort and filters, the default filter "unmigrated" (defined in 06-migration-lifecycle.md as status not in {`verified`, `manually_completed`}), a Facet badge strip, and row selection that persists across pages. UI-020 asks for counts, Waves, quota gauges and recent Runs. The spec does not say which API serves the list, how a page follows live updates without one SSE stream per component, or what a filter change does to the selection. ADR-0270 limits one Actor to 16 SSE streams, and the shell already holds one (`list:runs`).

## Decision

1. **List data comes from the Model API** (`GET /api/model/migration/findMany` and `/count`, ZenStack RPC, API-012), not from a new `/api/v1` endpoint. The read policy is the same for every role, `where`, `orderBy`, `skip`/`take` already cover every filter of UI-021, and no endpoint is invented. The text search uses `contains` with `mode: insensitive`; a test against the real engine shows `%` and `_` are matched literally. The Route's namespaces and the Waves for the filter selects come from `namespace/findMany` and `wave/findMany`. Pages are numbered (`skip`/`take`, 50 per page) because the antd Table shows page numbers and a total from `count`. The order always ends with `id`, so it is deterministic; live refetches can still shift rows between pages while someone browses. The dashboard and quota use `GET /api/v1/dashboard` and `GET /api/v1/quota` (ADR-0332).
2. **"Unmigrated" follows 06-migration-lifecycle.md:** `status notIn [verified, manually_completed]`. The status select offers "Unmigrated" (default), "All statuses" and each status. `/repositories?route=&status=&readiness=` opens the list pre-filtered (`RepositoriesView` takes `initialRouteId` and `initialFilters`); the dashboard's per-Route link uses it. Other filter state lives in React state, not in the URL.
3. **Facet badge strip.** The list selects the latest Analysis's plan items (`facetKey`, `kind` only). There is one badge per Facet in the plan: colored and described by its worst finding (blocker, pre task, post task, warning), or "no findings" when the Facet has only `step` items.
4. **Selection** is a map of Migration ids kept in the view, independent of the shown page; it survives page, sort and filter changes and is cleared when the Route changes. When selected ids fall outside the current filters the view says "N selected (M hidden by filters)" (one `count` of the selected ids inside the filters, debounced by 200 ms). The check runs for up to 100 selected ids; above that the view shows the plain count, because the ids travel in a GET query. The dashboard's status and readiness cards link to the list with those filters. The view exposes the selection as a `bulkBar(selection)` render prop, shown to operators only. **T-088 owns all four bulk actions** (Analyze, Migrate ready, Assign to wave, Remove from wave) and must re-validate the ids on the server before acting: the ids can be stale or outside the filters.
5. **One live connection per page.** The shell owns the only `useLiveInvalidation` (`LiveTopicsProvider`). A view adds the topics it shows with `useLiveTopics` and the provider merges them with the shell's `list:runs` into the one connection; leaving the page removes them. Topic-set changes settle for 100 ms before the stream is (re)opened, and events refetch views once per 300 ms window. A page or a row never opens its own stream. The list follows `list:migrations`, `list:runs`, `list:tasks`, `list:repositories`; the dashboard follows `list:migrations`, `list:runs`, `quota`.
6. **Row actions: Analyze only.** `POST /migrations/{id}/analyze` exists. Migrate and Run anyway need `POST /migrations/{id}/runs`, which T-074 builds; the buttons are added together with it, including the typed `confirm` body field (LIF-043), the 409 and 422 readiness-changed messages and their integration tests. Failed Analyze requests show `repositories.action.error.<code>` for 409 `conflict`, 422 `validation_failed` and 404, and the generic problem text otherwise.

## Alternatives

- A new `GET /api/v1/migrations` list endpoint: duplicates what the Model API offers and adds a contract to maintain.
- Cursor pagination for the table: the cursor API cannot jump to page N or show a total.
- One `EventSource` per view: breaks the 16-stream limit as soon as two tabs and a few components are open.
- Shipping Migrate and Run anyway now: the Run endpoint does not exist yet, so the buttons would only fail.
- Deriving the Facet badges from `Analysis.translation`: needs the per-Facet fidelity JSON on every row; plan items already carry the severity.
