# ADR-0270: Event payload shape, topics, and SSE stream details

- Status: agent-decided
- Date: 2026-10-08
- Task: T-022
- Affects: JOB-060, API-011, AUTH-020, AUTH-021

## Context

JOB-060 gives the payload as `{ type, ids, at }` and names four example topics. It does not say what `ids` is, which topics exist besides those four, how a client is told about a gap, how the browser detects a missing heartbeat, how long a stream lives, or what bounds apply to a connection.

## Decision

1. **`ids` is an object** keyed by kind: `migration`, `run`, `task`, `endpoint`, `invitation`, each a string matching `^[A-Za-z0-9_-]{1,64}$`. A bare array cannot say which Run or Migration changed. The payload stays at or below 7,000 bytes (measured in UTF-8 bytes); `encodeEvent` refuses larger ones.
2. **Topics** are `quota`, `list:migrations`, `list:runs`, `list:tasks`, `list:repositories`, `list:invitations`, and `<kind>:<id>` for the five kinds. `topicsForEvent` (in `core`) maps an event to its topics: a Run change also reaches `migration:<id>` when `ids.migration` is set, and every change that shows in a list reaches that list. A `GET /api/v1/events` request names 1 to 50 topics; an unknown topic is a 422 `validation_failed` problem.
3. **Authorization.** Every role may read everything (AUTH-020), so the endpoint requires the `read` capability and the usual Actor resolution (session or API key; a disabled Actor is a 401). Events carry identifiers only and the client refetches through ZenStack or the API, where policies apply, so no per-topic lookup is done. If a later role gets narrower read rights, `eventsHandler` is the one place to add a per-topic capability.
4. **Heartbeat is a comment and a named event.** Browsers do not give `EventSource` comments to scripts, so a client cannot see the comment the spec asks for. The server sends `: heartbeat` and `event: heartbeat` together every 15 s; the client's 45 s watchdog resets on the named event.
5. **Gaps.** When the listener's connection is lost and re-established, notifications sent meanwhile are gone. The hub sends `event: resync` to every stream, and the client invalidates every topic it shows. The browser does the same after any reconnect.
6. **Bounds.** Each stream queues at most 64 frames. A burst past that replaces the queue by one `resync` frame and the client keeps its stream (it refetches). A client that reads nothing for 4 heartbeat ticks (60 s) while frames wait is dropped by erroring its stream. A process serves at most 2,000 streams and one Actor (by `actor.id`) at most 16; either limit answers 429 `too_many_streams` with `Retry-After: 5`. A stream ends after 10 minutes, spread by +-20% so that streams opened together do not end together; the client reconnects, with +-20% jitter on its backoff, and is authenticated again.
7. **Coalescing** of `run.log` is per Run in the hub: the first event goes out at once, later ones in the next 250 ms window are merged into one trailing event, which gives at most 4 per second per Run.
8. **Listener.** One dedicated `pg.Client` built from the pool's options (outside the pool) with a 10 s connect timeout and TCP keepalive, reconnecting with backoff from 0.5 s to 30 s. It starts when the first stream opens.
9. **Liveness.** A half-open connection raises no error, so the listener runs `select 1` on its connection every 30 s with a 10 s timeout and treats a failure as a lost connection. A connect plus `LISTEN` that takes longer than 10 s counts as failed. While the listener is not connected the hub sends no heartbeats (the clients' 45 s watchdog then falls back to polling), and every successful connect, the first included, sends `resync` to the streams.
10. **Disabled Actors and revoked keys.** `PATCH /actors/{id}` with `disabled: true` and `DELETE /api-keys/{id}` end the Actor's streams on the process that handled the request (`closeOwner`); on other pods a stream ends within its lifetime (10 minutes at most, +-20%). Residual risk: for that time a revoked key or disabled Actor can still receive event frames. They carry identifiers only and no refetch succeeds, so nothing beyond the existence of a change is exposed. Telling the other pods (a `NOTIFY`) is a possible follow-up.

## Alternatives

- `ids` as an array of strings: rejected, ambiguous.
- Per-topic authorization lookups through `forActor`: rejected for now, all roles read everything and it would add a query per topic per connection.
- Relying on `EventSource`'s own reconnect: rejected, it retries at a fixed delay and a failed HTTP response (401, 429) stops it for good, so the client reconnects itself with backoff.
- A cursor / `Last-Event-ID` replay: rejected, a refetch is cheaper than keeping history per process.
