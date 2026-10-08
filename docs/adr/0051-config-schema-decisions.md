# ADR-0051: Configuration schema decisions where DEP-040 is silent

- Status: accepted (spec updated)
- Date: 2026-10-08
- Affects: DEP-040, ARC-030, AUTH-010, AUTH-012, FAC-005, JOB-043, JOB-050, LIF-030, LIF-044, ADP-071

## Context

DEP-040 gives the configuration keys with example values, not a complete schema with defaults. It also says the chart merges several top-level values into the file. The implementor must pick defaults, types and validation rules for every key.

## Decision

**Defaults.** Where the spec gives a value in its example or in the requirement that uses the key, that value is the default. Otherwise:

| Key | Default | Source |
|---|---|---|
| `environment` | `development` | Local development is the safe default for the schema; production must say so. |
| `publicUrl` | `http://localhost:3000` | Port of the web Service (DEP-030). |
| `auth.entra.tenantId` | `""` | Required in `production` (see below). |
| `endpoints[].baseUrl`, `gitBaseUrl` | the public hosts of each provider | Overridden in development and test (DEP-040 fakes). |
| `endpoints[].credentialsSecret` | `BITBUCKET_CREDENTIALS` / `GITHUB_APP_PRIVATE_KEY` | The example names of DEP-040. |
| `endpoints[].atlassianAdmin.apiKeySecret` | `ATLASSIAN_ADMIN_API_KEY` | Example name. |
| `routes[].sourcePostAction` | `read-only` | ADR-0020: the source is read-only by default. |
| `routes[].policies.*` | the FAC-005 defaults | Spec. |
| `routes[].defaults.mergeSettings` | all three strategies, `deleteBranchOnMerge: true` | Spec (FAC-MRG-002 fallback). |
| `routes[].defaults.naming`, `teamNaming` | the pipelines of 06-migration-lifecycle | Spec. |
| `postgres.host` | `localhost` | Development default; the chart sets the real host. |
| `postgres.sslmode` | `require` | DEP-031 value. |
| `postgres.auth` | `password` | DEP-031 value. |
| `postgres.database`, `user` | `git_migrator` | DEP-031 values. |
| `secretspec.profile` | `production` | Entrypoint default (DEP-002). |
| `observability.logLevel` | `info` | DEP-031 value. `serviceName` `git-migrator`. |
| `metrics.port` | `9464` | DEP-050. |
| `worker.*.concurrency` | the DEP-031 values | Spec. |

**Strict objects.** Every object rejects unknown keys. A misspelled key is an error, because a silently ignored policy or limit is worse than a failed start.

**Placeholders.** The DEP-040 example uses `appId: 0`, `installationId: 0` and `orgId: ""` as placeholders. They are accepted (non-negative integers, any string). The GitHub adapter must treat `0` as unset when it uses the value; that check is part of the adapter task, not of config.

**The example's empty `tenantId` is a placeholder that is invalid in production.** DEP-040 shows `environment: production` with `auth.entra.tenantId: ""`. Production needs an Entra tenant (see the cross-field rules below), so that example is rejected there. The orchestrator will update the spec example. The DEP-040 example is also not loadable verbatim: its `roleMappings: [ ... ]` is an ellipsis, which the schema rejects. The test `spec-example.test.ts` asserts both facts: as written, the load fails at the ellipsis; with it read as an empty list, the only failure is the empty tenant.

**Default environment.** `environment` is `development` by default, as the spec's defaults require. A default is a fail-open choice for production guards, so the loader warns (to standard error, or a `warn` callback) when `environment` is not set by the file or by `GM_ENVIRONMENT`, and either `auth.testSignIn.enabled` is true or `publicUrl` is set explicitly to an http URL. The default `publicUrl` is plain http for local development and does not warn. The chart must set `GM_ENVIRONMENT`; the warning is a second line of defence, not the mechanism.

**URL settings** (`publicUrl`, `endpoints[].baseUrl`, `gitBaseUrl`, `observability.otlpEndpoint`) must be http or https and must not carry a username, password, query string or fragment. A secret in a URL setting would be written into logs and manifests.

**Provider options live in the config package.** `endpoints[].options` is a discriminated union on `provider` (`bitbucket-cloud`: `workspace`; `github`: `org`, `appId`, `installationId`), because DEP-040 is normative and the config package has no dependencies (ARC-012). The glossary terms (GLO-002) are used here as configuration keys mandated by DEP-040, not as core, facet, database or UI vocabulary. A new provider adds a member to the union in the same PR.

**Provider names in the file.** The DEP-040 keys that name providers (`endpoints[].provider`, `options.workspace`, `options.org`, `atlassianAdmin`, the top-level `github` section, and the default secret names) are kept as the spec writes them. They are configuration vocabulary that operators must type, so the GLO-002 rule for core, facets, database and UI code does not apply to this package.

**Quota overrides** are `endpoints[].quota.overrides`: resource group name to a positive whole number. The keys are not validated against the Bitbucket list because JOB-043 says updated numbers need no code change; the adapter decides which names it reads. `quota` is accepted on every endpoint, not only on Bitbucket, so one shape serves all providers.

**Durations** use `Ns`, `Nm`, `Nh`, `Nd` with a whole number. They are parsed to milliseconds in the output. Other units (`ms`, weeks, ISO 8601) are rejected to keep one notation.

**Cron** is five fields, numeric only (no names, `L`, `W`, `#` or `?`). A step must be between 1 and the field maximum. A cron with a sixth seconds field is rejected, because BullMQ schedulers in DEP-040 use the five-field form.

**Naming pipelines.** A step's variable must be initialized by an earlier step; the template may only use initialized variables. `replace` patterns must compile as JavaScript regular expressions (flag `u`). Validation of the target name (length, characters) remains LIF-031's job at analysis time.

**Step strictness against LIF-030.** LIF-030 writes the transform step as `{ var, op, arg?: number }`. This schema requires `arg` for `truncate` (a positive integer) and rejects `arg` on `lowercase` and `kebab`, because an ignored argument would hide a mistake in the rule. Every other op takes exactly its own fields (`pattern` and `with` for `replace`). The schema is stricter than the type in LIF-030 on purpose; a rule that LIF-030 would accept with an ignored argument is rejected here.

**Cross-field rules are not always reported together.** Zod skips refinements of an object once one of its fields has failed, so a production-only rule (tenant, https, test sign-in) appears only after the other errors are fixed. This keeps the report free of follow-on noise and is documented here rather than worked around.

**Provider names are an explicit exception to GLO-002.** AGENTS.md states the glossary rule without exceptions. DEP-040 mandates provider-keyed configuration (`provider: bitbucket-cloud`, `options.workspace`, the top-level `github` section, the default secret names), so this package uses those names. This is an explicit exception, recorded here, for configuration keys only; core, facets, database and UI code stay provider-neutral.

**Cross-field rules** checked when the rest of the document is valid: endpoint and route ids are unique; route source and target are defined endpoints and differ; in `production`, `publicUrl` is https, `auth.entra.tenantId` is set, and `auth.testSignIn.enabled` is false (AUTH-012, Q66). A cross-field rule is not reported when an earlier error already stopped validation, which is how Zod works.

**Role mapping method** is a lowercase name, not an enum, because AUTH-010 says future sign-in methods map their own claims. `entra` is the only method named in the spec.

## Alternatives

- Requiring every key to be explicit would fail the local development start with no benefit.
- Accepting unknown keys with a warning would keep the file forward compatible, but a warning in a container log is easy to miss for a policy.
- Moving provider options to the adapters (validated through a registry hook) keeps config free of provider words, but adds a registration step and needs config to accept opaque options first. Revisit if a third provider makes the union large.

## Affected requirements

DEP-040, ARC-030, AUTH-010, AUTH-012, FAC-005, JOB-043, JOB-050, LIF-030, FAC-MRG-001, ADR-0020, ADR-0052.
