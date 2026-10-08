# ADR-0223: Ban direct HTTP in adapters; adapter-sdk re-exports quota vocabulary

- Status: accepted (no spec change needed)
- Date: 2026-10-08
- Task: T-032
- Affects: ADP-060, ARC-012, TST-006

## Decision

- `tools/check-deps.ts` gains rule `ADP-060`: non-test source under `packages/adapters/*` may not reference the global `fetch` (call, value, `globalThis.fetch`), `XMLHttpRequest`, any use of the global object (`globalThis`, `global`, `self`, `window`: aliasing, destructuring, computed access), `WebSocket`, or import (first path segment, `node:` prefix ignored) `http`, `https`, `http2`, `net`, `tls`, `dgram`, `ws`, `undici`, `axios`, `got`, `ky`, `node-fetch`, `superagent`, `needle` or `request`. Property names (`ctx.fetch`) are allowed. This resolves follow-up T-026 round 1; T-033 gets it for free.
- `adapter-sdk` re-exports `bucketKey`, `BucketSpec`, `QuotaFeedback` and `QuotaPool` from `quota`, because classifiers and `interpret` need them and adapters may not import `quota` (ARC-012).
- `@git-migrator/provider-fakes` exports `validateAgainstSpec` through its `bitbucket` namespace so adapter fixture tests can validate raw fixtures against the published OpenAPI document. The fake gains `GET /2.0/workspaces/{ws}/permissions` (workspace memberships with `owner` or `member`).

The rule also bans `EventSource`, `navigator.sendBeacon`, `eval` and the `Function` constructor, `process.getBuiltinModule` of a banned module, and the modules `dns`, `child_process`, `worker_threads` and `cloudflare:sockets`. Members of the global object other than the connection-opening ones (`globalThis.crypto`), `typeof window` and locally bound names are allowed. It is a lint-level guard, not a sandbox: the SDK's runtime origin pinning and test host allowlist are the backstop.

## Alternatives

A Biome rule: cannot see imports and calls across the whole adapter tree as simply. Duplicating `bucketKey` in each adapter: drifts from the quota package.
