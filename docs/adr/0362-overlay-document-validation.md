# ADR-0362: Overlay writes go through validated `/api/v1/overlays` endpoints, not RPC

- Status: agent-decided
- Date: 2026-10-09
- Task: T-091
- Affects: UI-032, LIF-048, DOM-001, DOM-003, API-010, API-012, AUTH-020, AUTH-022, ADR-0121
- Supersedes: the admin RPC write of Overlay in API-012, pending the spec fold

## Context

DOM-003 says every writer of `facetKey`-shaped JSON, Overlays included, validates it with the Facet's Zod schema. The RPC mount (API-012) has no per-model validation hook, so an RPC write of an Overlay cannot meet that. An ADR cannot waive DOM-003.

## Decision

- `POST /api/v1/overlays`, `PATCH /api/v1/overlays/{id}` and `DELETE /api/v1/overlays/{id}` are the only writers of an Overlay (API-010 allows custom endpoints). They need `manageRules` (`can()`, admin), answer problem+json, and write an audit event (`overlay.create`, `overlay.update`, `overlay.delete`; AUTH-022). The audit event records the Route, the Facet and the flag, never the document. The staleness trigger fires on these writes as before.
- `data` is validated against the Facet's schema in deep-partial strict form (`validateOverlayDocument`, `packages/facets/src/overlays`): every object field optional, unknown keys refused at any depth, defaults not applied, field rules kept, whole-document refinements dropped. Arrays keep their element schema in partial form. The document is stored as sent, not as parsed.
- Also refused: a non-object, the keys `__proto__`, `constructor` and `prototype` at any depth, nesting deeper than 32, a document over 64 KB, an unknown `facetKey`, an unknown Route. Errors are 422 `validation_failed` with `errors[].path`.
- The API reaches the helper through `ProviderRegistry.validateOverlay`, because ARC-012 lets only `registry` import facets.
- Policy: `Overlay` keeps `read` for enabled Actors and has no `create`, `update` or `delete` allow rule, so RPC writes are denied for every role including admin. This supersedes API-012's admin RPC write for Overlay, pending the spec fold. The DOM-005 and API-012 policy tests are flipped, not removed, and a test proves the endpoint is the only writer.
- The browser calls the endpoints and runs the same check locally (canonical schemas plus the shared helper). The server stays authoritative; its path errors are shown in the editor.

## Alternatives

- Keep RPC writes and validate in the editor only: a client check is not a validation of the writer. Rejected.
- A ZenStack plugin or hook validating by `facetKey`: no such hook in the pinned version.

## Follow-up

The orchestrator folds this into API-012 and UI-032 after merge.
