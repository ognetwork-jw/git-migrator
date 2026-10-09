# @git-migrator/adapter-bitbucket-cloud

The Bitbucket Cloud source adapter (T-032). Provider facts: `docs/providers/bitbucket-cloud.md`. Decisions: ADR-0220 to ADR-0223.

`bitbucketCloudAdapter.connect(endpoint, ctx)` validates `config` (`workspace`, `gitBaseUrl`, `quota.overrides`; ADR-0220) and the credential (`accountId`, `email`, `apiToken`, optional `gitUsername`), builds one `ProviderHttpClient` and returns an `EndpointConnection`. All HTTP goes through that client; `tools/check-deps.ts` fails the build on direct `fetch` or HTTP imports here (ADP-060).

| Module | Purpose |
|---|---|
| `quota.ts` | Route to bucket classifier (JOB-043: `repository-data`, `webhooks`, `raw-files` counted in both, `app-properties`, `git`), `interpret` for `X-RateLimit-Limit` / `NearLimit` with `observedSince` from the grant, `minBlockSeconds: 60` |
| `client.ts` | `authorize` (Basic header and declared secrets computed once), Atlassian token shapes for scrubbing |
| `mappers.ts` | Pure provider JSON to canonical mappers (every Facet) |
| `facets.ts`, `reader.ts` | Read-only Facet drivers (`capture: true`), short-lived shared fetches |
| `inventory.ts` | Namespaces (workspace, projects), repositories, identities, groups |
| `source-lock.ts` | LIF-070 apply, undo, `originals` and `inspect` with the guarded description `PUT` (ADR-0222). With `originals` (taken before the write) apply writes the description only while it still shows the original, and `inspect` sets a recovered description's `before` from the original, never from the current text (ADR-0425). `frameworkRestrictionIds` lets the `branch-rules` read leave the framework's restrictions out by id (`FacetTarget.frameworkResources`) |
| `git-access.ts` | `remoteUrl` (no credentials) and the token credential for `git` |

Behavior worth knowing:

- Bitbucket is the source: every Facet is `read: true, write: false`, drivers have no `apply`, target operations throw `unsupported`.
- Optional reads degrade to `FacetRead.unreadable` (merge settings, wiki, issue and download counts, team membership without the groups endpoint); any other 4xx fails the read so a missing token scope is visible.
- Warnings returned with reads: `branch-rules.unknown-kind`, `branch-rules.branching-model`, `webhooks.unmapped-events`, `webhooks.invalid-url`, `webhooks.duplicate-url`, `deploy-keys.unparsable-skipped`, `variables.invalid-name-skipped`, `access-control.workspace-owners-unknown`, `members.roles-unknown`.
- `SourceLockPartialError.mutations` carries the Mutations already made when `apply` fails midway; the runner must record them.

## Tests

`pnpm --filter @git-migrator/adapter-bitbucket-cloud test`. Tests run against `testing/provider-fakes` through the client's `fetch` seam and never touch the network (TST-006). `fixtures/*.json` are raw response shapes of the published API; `mappers.test.ts` validates each against Atlassian's OpenAPI document before mapping it.
