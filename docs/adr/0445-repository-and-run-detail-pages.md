# ADR-0445: Repository and Run detail pages

- Status: agent-decided
- Date: 2026-10-09
- Task: T-082
- Affects: UI-001, UI-022, UI-023, LIF-005, LIF-043, LIF-070, LIF-077, LIF-075, LIF-006, LIF-063, JOB-060, AUTH-020, API-012, API-020

## Context

UI-022 and UI-023 list what the pages show but not several details the code must settle: what the "source and target links" point to, which actions the header offers in which state, how a rollback is sequenced when the source is read-only, how the live log is fetched and bounded, and what the Facets tab's "JSON tree diff" compares.

## Decision

- **Source and target are shown by full name, not as external links.** No stored field holds a provider web address (`Endpoint.baseUrl` is the API address, and deriving a repository page from it needs provider knowledge the web app must not have, GLO-002). The header shows the source full path and Endpoint name, and the target full name (the target repository, else the Route's target namespace and the planned name, marked "Planned"). A real link needs an adapter-provided web URL on `Repository`; recorded as a follow-up.
- **Reads go through the Model API, actions through `/api/v1`.** The detail page reads the Migration (with Route, repositories, Wave and the latest Analysis' plan items), tasks, Runs and audit events with `findMany`; the diff view reads `GET /migrations/{id}/diff`. The two writes are the ones API-012 allows: `Migration.waveId` and `ManualTask.note`. Every other action is the endpoint ADR-0415 describes.
- **One live topic per page.** The detail page follows `migration:<id>` and the Run page `run:<id>` over the shell's single connection (ADR-0350). All the page's query keys share a prefix, so one event refreshes every tab. A `run.log` event refreshes the Run page's queries together; the log query itself fetches only lines after the last id it holds (ids are UUIDv7, so id order is time order).
- **Which actions show** (`migration-detail/rules.ts`) is a hint only; the server decides again and its problem code is shown.
  - Migrate: `ready`, Run anyway: `needs_attention`, both from `analyzed`, `failed` or `rolled_back`. Force adopt: the Migration has the blocker `target.exists-nonempty` (the one blocker LIF-043 lets it override). It starts `migrate`, or `run_anyway` when pre tasks are open, with `options.adoptNonEmpty` and the typed name as `confirm` (an exact match, as LIF-043 requires).
  - Resync from a migrated, partial, verified, manually completed or drifted status when not blocked; Verify and the source read-only actions need a target; Rollback follows LIF-077 (not for `running`, `source_missing`, `discovered`, `rolled_back`; needs a target or a Run that recorded Mutations).
  - Every action is disabled while a Run is queued or running (DOM-010) with a link to that Run.
  - Mark complete needs `markComplete`; every other action `operate` (AUTH-020). Both are operator today, but the page asks for the capability the action needs. A viewer sees no action and no Wave selector.
- **Rollback with the source read-only.** LIF-077 requires an `undo_source_read_only` Run to succeed first and says the UI offers both in sequence. When `sourceReadOnlyApplied` is true the Rollback dialog becomes "Undo source read-only first" (typed name, `undo_source_read_only` Run). When that Run has finished and the flag is cleared, the same button opens the normal rollback dialog. The page never chains the two Runs itself, because the second needs the first to have succeeded.
- **Typed names (UI-001).** Rollback, force adopt and undo source read-only use a dialog whose confirm button stays disabled until the typed text equals the target full name exactly. The server compares a rollback case-insensitively (ADR-0415); the stricter UI rule is intended. A rollback of a Migration with no target to name (only Mutations to undo) has nothing to type.
- **Per-Migration opt-out of source read-only (LIF-070)** is a checkbox in the Migrate, Run anyway and Resync dialogs that sends `options.skipSourceReadOnly`.
- **The Facets tab compares structurally for reading, and by parity for truth.** The source, desired and target documents are collapsible trees; entries that differ from the same place in the neighbouring document carry a text marker ("changed", "only here"; arrays compare by index). The authoritative differences are the ParityResult's paths, listed beside the trees, each with an Accept button that creates a `manual_accepted` Expected Difference. Expected Differences have a Revoke button except `identity_excluded` and `framework_mutation`, which the server refuses (ADR-0415) and the page labels "Managed by the system".
- **Audit tab.** Events whose subject is the Migration, plus events whose `data.migrationId` is the Migration (Run, task and Expected Difference events record it), newest first, 200 at most.
- **Log bounds.** The log is fetched in pages of 500, the page keeps the newest 20,000 lines and says when older ones were dropped. The viewer is virtualized with a fixed line height (only the lines in view and a margin are in the document), filters by minimum level, and follows the tail until the person scrolls up.
- **Route scoping.** The spec defines no per-Route permission for an Actor, so the pages gate on role only. A Migration's own Route shapes what the page shows (its target namespace, its endpoints).

## Alternatives

- Link to the provider pages from a web URL derived from `baseUrl`. Rejected: provider knowledge in the web app (GLO-002), and the API address is not the page address.
- Chain the undo and the rollback in one click. Rejected: the second Run is refused until the first succeeds, and a failure in the middle would leave a confusing state.
- A JSON diff library. Rejected: parity already gives the authoritative path list; the trees only help a person find the place.
- Fetch the whole log on every `run.log` event. Rejected: a Run can write tens of thousands of lines.
