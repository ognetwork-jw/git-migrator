# ADR-0520: Web UI follow-up decisions

- Status: agent-decided
- Date: 2026-10-16
- Task: follow-ups (claude/followups-web-ui)
- Affects: JOB-060, UI-001, UI-022, UI-023, UI-034, LIF-006

## Context

The Web UI follow-ups in `docs/followups.md` raise points the spec leaves open. Each decision below names the follow-up it closes.

## Decision

1. **A live stream counts as reconnected only once it proves the listener is up (JOB-060).** The spec says clients "return to SSE after a successful reconnect" and that the hub sends no heartbeats while its `LISTEN` connection is down. The hub still accepts streams then and sends `: connected`, so a client that left polling on `onopen` cycled through about 46 s of silent `sse` mode instead of polling every 10 s. Now:
   - The client keeps its mode (and keeps polling) on `onopen`. It switches to `sse` on the first `heartbeat`, `gm` or `resync` of the stream, and resets its reconnect backoff only then. That first frame of a reconnect reports every topic once, as before.
   - The hub sends a `heartbeat` right after `: connected` when its listener is connected, so a healthy stream is confirmed at once and not after the first 15 s tick. A stream opened while the listener is down gets nothing until the listener is back (its `resync` confirms it).

2. **The first paint uses the color scheme of the last visit (UI-001).** antd's theme is chosen in React, and the server cannot see the OS preference, so every first paint was light and dark-mode users saw a flash. The browser now writes its scheme to the `gm-color-scheme` cookie (`dark` or `light`, `Path=/`, one year, `SameSite=Lax`) and the root layout renders antd with it; hydration uses the same value, and the OS preference takes over right after. A first visit, or a browser that blocks cookies, still paints light once. The cookie is a display preference and carries nothing else. The `Sec-CH-Prefers-Color-Scheme` client hint was not used: browsers send it only after an `Accept-CH` round trip, and not all of them.

3. **A key issue request gives up after 30 s (UI-034, AUTH-040).** The one-time key dialog cannot be cancelled while its request is in flight, because the key it returns would be lost (ADR-0365). A request that hung kept Cancel disabled forever. `issueApiKey` now aborts after `ISSUE_TIMEOUT_MS` (30 s); the dialog then says the key was not confirmed and may still exist, asks the operator to check the list (which shows prefixes) and revoke any key they did not receive, and enables Cancel again. A late answer is dropped with the aborted request, so the key never reaches any state. `apiRequest` gains an optional `timeoutMs` that reports `timeout`.

4. **The Run log reads its tail first and re-reads a window on every update (UI-023).** The first load reads the newest `LOG_MAX_LINES` (20,000) lines from the end, newest page first, instead of the whole log from the start. Log ids are UUIDv7, made at insert time, and each line is written in its own short transaction, so a line can commit after a later one and a cursor "after the last id" skips it for good. A live update therefore reads from the smallest UUIDv7 of 30 s (`LOG_OVERLAP_MS`) before the newest line it has, and merges by id. 30 s is far above the time one log insert holds its transaction. A database sequence cursor was not added: it needs a schema change for the same result.

5. **The task list knows which tasks the data resolves (LIF-006).** The server refuses `done` on a task whose code has completion mode `resolution`, and a dismissal of one needs a reason; the page learned this only from the 422 after the click. Task rows come through the Model API and carry no completion mode. The repository detail page, a server component, now reads the `resolution` codes from the same built-in registry the API uses (`src/server/completion.ts`, computed once per process) and passes them to the client view. Such a task offers no "Mark done", says that it closes when its data changes, and its dismiss dialog requires a reason. No API field was added: spec 09 fixes the custom endpoints, and the registry is code, not data, so it cannot drift between the web and the API of one build.

6. **The page keys the legacy confirmation on the flag and the pin, as the guard does (ADR-0504).** The guard asks for the legacy confirmation only while `targetPlacementUnknown` is set and no place counts as pinned. A failed or cancelled legacy rollback keeps both the flag and the pin, so the server then judges the Migration by its pin: the rollback confirms the target's full name in the pinned Namespace, and the placement blocker is not waived until the next Analysis. The page keyed on the flag alone. It now reads the pin (`targetPlacedEndpointId`, `targetPlacedNamespaceId`, the pinned Namespace's slug and the Route's resolved ids) and treats the Migration as legacy only while the flag is set and no pin exists; a pin outside the Route names the target in the pinned Namespace. Residual: the guard counts a pin only while the target repository exists or target writes remain undone; when a failed legacy rollback undid every write and the repository is gone, the server is back in legacy mode while the page is not. The server's refusal then states the name to type. Closing this needs the server to expose the derived state, and spec 09 fixes the custom endpoints.

## Alternatives

- A `degraded` event from the hub while the listener is down: one more frame type for the same information that the missing heartbeat already gives.
- Leaving polling on `onopen` and relying on the 45 s watchdog: the behaviour the follow-up reported.

## Affected requirements

JOB-060, UI-001, UI-022, UI-023, UI-026, UI-034, AUTH-040, LIF-006, LIF-077.
