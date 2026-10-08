# ADR-0281: Endpoint connector for jobs

- Status: accepted (no spec change needed)
- Date: 2026-10-08
- Task: T-060
- Affects: JOB-042, ADP-010, ADP-060, ARC-012, AUTH-050

## Context

ADR-0220 and ADR-0230 say "the runner" builds each adapter's `config`, picks a credential and supplies `accountKey`, and T-028 was expected to provide it. It did not. Inventory is the first job that connects, and it may not import an adapter (ARC-012).

## Decision

- `packages/jobs` exports `EndpointConnector` (`connect(endpointId, { pool, signal })`) and `createEndpointConnector({ config, registry, env, environment, git })`. Jobs receive the interface, so tests and later tasks can decorate it. The implementation resolves the adapter with `registry.adapter(entry.provider)`.
- **Adapter config** is the Endpoint's `options` plus `gitBaseUrl`, `quota`, `quotaOverrides` (from `quota.overrides`) and `maxConcurrentRequests` (from `github.maxConcurrentRequests`), reduced to the keys the adapter's strict object schema declares. The runner stays free of provider names.
- **Credentials** come from `env[credentialsSecret]`: a JSON array of credentials, one JSON object, or a raw string (a PEM). Entries that fail `credentialSchema` are dropped. Errors name the secret key, never its value, and a JSON parse error is replaced by a fixed message (the parser can quote the input).
- **`accountKey`** is the credential's `accountId` when it has one, otherwise the Endpoint id (one credential per account; the quota key then stays per Endpoint).
- **Credential selection (JOB-042) is not implemented.** Choosing the credential with the most free capacity needs the buckets each adapter's classifier would charge, which the host cannot see. The first valid credential is used for the whole job. Follow-up: expose a per-adapter "bucket specs for a credential" hook in `adapter-sdk`, then call `selectCredential`.
- **Git.** Inventory uses no git transport; `noGitClient` throws on use, so a driver cannot reach git without the quota-aware `GitService`.
- The worker registers `inventoryHandlers` with this connector over `createBuiltinRegistry()`.
- **Atlassian Admin email enrichment (AUTH-050 step 1)** is an adapter feature and is not part of the Bitbucket adapter yet; source Identities carry no email until it lands, so the email step of the cascade matches nothing in production data (it is covered with decorated test data). Reported as a follow-up.

## Alternatives

- One connector per provider in `jobs`: breaks GLO-002 and ARC-012.
- Give the adapter the whole secret and let it select: the adapter cannot see sibling accounts' quota either.

## Affected requirements

JOB-042, ADP-010, ADP-060, ARC-012, AUTH-050.
