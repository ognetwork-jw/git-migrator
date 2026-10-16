# ADR-0520: Web UI follow-up decisions

- Status: agent-decided
- Date: 2026-10-16
- Task: follow-ups (claude/followups-web-ui)
- Affects: JOB-060, UI-001

## Context

The Web UI follow-ups in `docs/followups.md` raise points the spec leaves open. Each decision below names the follow-up it closes.

## Decision

1. **A live stream counts as reconnected only once it proves the listener is up (JOB-060).** The spec says clients "return to SSE after a successful reconnect" and that the hub sends no heartbeats while its `LISTEN` connection is down. The hub still accepts streams then and sends `: connected`, so a client that left polling on `onopen` cycled through about 46 s of silent `sse` mode instead of polling every 10 s. Now:
   - The client keeps its mode (and keeps polling) on `onopen`. It switches to `sse` on the first `heartbeat`, `gm` or `resync` of the stream, and resets its reconnect backoff only then. That first frame of a reconnect reports every topic once, as before.
   - The hub sends a `heartbeat` right after `: connected` when its listener is connected, so a healthy stream is confirmed at once and not after the first 15 s tick. A stream opened while the listener is down gets nothing until the listener is back (its `resync` confirms it).

2. **The first paint uses the color scheme of the last visit (UI-001).** antd's theme is chosen in React, and the server cannot see the OS preference, so every first paint was light and dark-mode users saw a flash. The browser now writes its scheme to the `gm-color-scheme` cookie (`dark` or `light`, `Path=/`, one year, `SameSite=Lax`) and the root layout renders antd with it; hydration uses the same value, and the OS preference takes over right after. A first visit, or a browser that blocks cookies, still paints light once. The cookie is a display preference and carries nothing else. The `Sec-CH-Prefers-Color-Scheme` client hint was not used: browsers send it only after an `Accept-CH` round trip, and not all of them.

## Alternatives

- A `degraded` event from the hub while the listener is down: one more frame type for the same information that the missing heartbeat already gives.
- Leaving polling on `onopen` and relying on the 45 s watchdog: the behaviour the follow-up reported.

## Affected requirements

JOB-060, UI-001.
