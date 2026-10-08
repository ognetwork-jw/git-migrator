# @git-migrator/adapter-sdk

Adapter and Facet driver contracts, the provider HTTP client, pagination helpers and secret stripping (ADP-010 to ADP-014, ADP-050, ADP-060, ADP-061, ADP-070). Design decisions: ADR-0190.

Internal dependencies (ARC-012, checked by `pnpm lint`): `@git-migrator/core`, `@git-migrator/canonical`, `@git-migrator/quota`. It has no edge to `observability` or `db`, so telemetry, raw-response persistence and the quota services arrive through small structural interfaces that the process wiring fills.

## Contracts (`types.ts`)

`ProviderAdapter`, `EndpointConnection`, `FacetDriver` / `FacetRead` / `FacetTarget`, `ProviderCapabilities`, `MutationRecord`, `ProviderLimits`, `GitAccess`, the writers (`ChangeRequestWriter`, `InvitationWriter`, `SourceLock`), inventory records and refs, `AdapterContext`, `DriverContext`, and `GitClient` (implemented by `packages/git`). Facet keys come from `canonical`, field capabilities from `core`.

## `AdapterError` (`errors.ts`)

`code`, `retryable`, `retryAfterMs`, `retryAt` (for `moveToDelayed`, JOB-044), `provider` and a secret-free `request`.

## `ProviderHttpClient` (`http.ts`)

An adapter builds one per connection in `connect`, from `AdapterContext` plus three adapter-owned pieces, and returns it as `EndpointConnection.http`:

```ts
new ProviderHttpClient({
  ...ctx,                    // quota, leases, logger, capture, telemetry, fetch, environment
  provider: 'my-provider', endpointId: endpoint.id, baseUrl: endpoint.baseUrl,
  classify: ({ method, path }) => ({ endpoint: 'repos.get', buckets: [{ key, limit, windowSeconds }] }),
  authorize: async () => ({ headers: { authorization: `Bearer ${token}` }, secrets: [token] }),
  interpret: (res) => ({ feedback: [...], signal: ..., adjust: [...] }),   // provider header parsing lives here
});
```

- Quota is acquired before every attempt in the request's pool (`pool` option, per-request override). `interpret` returns neutral numbers; the client sets `observedSince` to the stamp `acquire` returned for that request unless the adapter provides one (ADR-0180).
- Retries: network errors, 408 and 5xx, with full-jitter exponential backoff (1 s base, 60 s cap, 5 attempts). `retry: false` disables them for a write. 429 and adapter-reported limits are recorded with the quota service and thrown as `rate_limited` with `retryAt`; they are never retried in process.
- In-flight caps: a `RequestClass.concurrency` takes a `quota_lease` first (JOB-045).
- An absolute URL must share the base origin; redirects are followed only for same-origin reads.
- `capture: true` on a request saves a stripped `RawCaptureInput` through the `RawCaptureSink` and returns `rawResponseId`.
- Telemetry goes to `ProviderTelemetry` (`gm_provider_requests_total`, `gm_provider_request_duration_seconds`, spans).
- With `GM_ENVIRONMENT=test` it refuses every host except loopback, `GM_TEST_ALLOWED_HOSTS` and `testAllowedHosts` (TST-006).

The SDK also re-exports `bucketKey`, `BucketSpec`, `QuotaFeedback` and `QuotaPool` from `quota`, so adapters can write classifiers without importing `quota` (ADR-0223).

## Pagination (`pagination.ts`)

`parseLinkHeader`, `paginateLinks` (link-based), `paginateCursor` (cursor-based), `flattenPages`, `collect`. Loops and runaway paging are errors.

## Secret stripping (`redact.ts`)

`stripHeaders`, `stripUrl`, `stripBody`, `stripText`: used for raw captures, error messages and log fields. Never log or capture anything that has not passed through them.

Tests: `pnpm --filter @git-migrator/adapter-sdk test`. Network is never used beyond loopback.
