# ADR-0241: The fake git server's LFS batch responses carry per-action headers

- Status: agent-decided
- Date: 2026-10-08
- Task: T-027
- Affects: TST-013, ADP-071, FAC-GIT-005

## Context

The fake git server (T-040) answered LFS batch requests with `"authenticated": true` on each object, while its object endpoints still required HTTP Basic credentials and the actions carried no `header`. In the git-lfs batch API (`docs/api/batch.md` in the git-lfs repository) `authenticated` tells the client that the action needs no credential lookup, and `actions.<name>.header` holds the HTTP headers the client must send with that action. git-lfs 3.4 therefore sent the object GET without credentials, got 401 and retried until it ran out of file descriptors. T-040's tests did not notice because they inject an `http.extraHeader` that is sent on every request. The package spec requires `GIT_ASKPASS` (ADP-071), which only works when the client either looks credentials up or is handed a header.

## Decision

The fake keeps `authenticated: true` and each `download`, `upload` and `verify` action now carries `header: { "X-Fake-Lfs-Ticket": <ticket> }`. A ticket is a random value the server remembers with its side, repository, operation (`download`: GET and HEAD of objects; `upload`: PUT of objects and verify), an expiry (`lfsTicketTtlMs`, default 5 minutes) and the identity that called the batch endpoint. Object GET, PUT and verify accept a matching ticket in place of credentials, and `authorize` runs for that identity on every use, so revoking access stops outstanding tickets (the batch call itself still needs credentials); T-040's tests that send credentials on every request keep working. A client must send the header it is given, as it would a signed-URL header or token against a real server, and the caller's own credential is never echoed back (as T-040's test requires). Dropping the flag was considered first and rejected because it made the fake behave unlike a server that pre-authorizes its actions. The fake GitHub's own LFS batch route (`src/github/app.ts`) is unchanged.

## Consequences

Tests of the git package use askpass end to end against the fake. The T-040 tests still pass (they send the header on every request).
