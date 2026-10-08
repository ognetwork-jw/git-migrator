# ADR-0220: Bitbucket adapter connection, identifiers and inventory

- Status: agent-decided
- Date: 2026-10-08
- Task: T-032
- Affects: ADP-010, ADP-070, JOB-030, JOB-040, JOB-042, JOB-043, AUTH-050

## Context

`EndpointRuntime` carries `config`, `credential` and `accountKey`, but the spec does not say what `config` holds for Bitbucket, where the git username and base URL come from, which ids the inventory uses, or how Atlassian account ids (which contain `:`) fit a bucket key (`bucketKey` refuses `:`).

## Decision

1. **`config`** (validated by `configSchema`) is the endpoint's `options` plus two keys the runner copies in: `gitBaseUrl` (default `https://bitbucket.org`) and `quota` (`endpoints[].quota`, whose `overrides` may name only `repository-data`, `webhooks`, `raw-files`, `app-properties`, `git`). The config package keeps `options` strict (`{ workspace }`), so nothing changes there.
2. **`credential`** is one entry of `BITBUCKET_CREDENTIALS`: `accountId`, `email`, `apiToken` and an optional `gitUsername` (default `x-bitbucket-api-token-auth`, unverified, ADR-0036 item 1). Validation errors name paths only, never values.
3. **Bucket keys** use `accountKey` from the runner; `:`, `#` and whitespace runs are replaced by `_` (`557058:abc` becomes `557058_abc`). Distinct accounts differing only in those characters would collide, which Atlassian ids do not do.
4. **Ids.** Identity `providerId` = Atlassian `account_id`, else the user `uuid`; the same rule produces principal ids in every Facet. Group id = group slug. Project `providerId` = project `uuid`, `slug` = `key`. The workspace namespace has `providerId` = `slug` = the configured workspace slug (no `GET /workspaces/{ws}` call). Repository `providerId` = repository `uuid`; REST paths always use slugs.
5. **Cursors** are the provider's absolute `next` links (confined to the base origin by the client). Repository listing filters with `q=project.key="KEY"` (key charset checked) and trims with `fields`.
6. **Identities** come from workspace members only (no email: the API exposes none). `app_user` accounts are `bot`.
7. **Unsupported target operations** (`repositories.create/delete`, `refs.*`, `lfs.missing`) fail with `AdapterError('unsupported')`; `isEmpty` is true when there is no main branch. Every Facet is `read: true, write: false` and no driver has `apply`.

## Alternatives

Adding `gitUsername` to the config package: rejected, the credential is where it varies. Calling `GET /workspaces/{ws}` for a uuid: rejected, an extra call and not in the fake.

## Consequences

The runner must pass `gitBaseUrl` and `quota` inside `config`. T-058/T-060 should overlay `FacetRead.unreadable` (for example `/allowed`) onto the source capabilities when building `TranslateContext.sourceCaps` (FAC-MRG-002).
