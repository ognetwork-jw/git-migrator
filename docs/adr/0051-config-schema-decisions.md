# ADR-0051: Configuration schema decisions where DEP-040 is silent

- Status: agent-decided
- Date: 2026-10-08
- Affects: DEP-040, ARC-030, AUTH-010, AUTH-012, FAC-005, JOB-043, JOB-050, LIF-030, LIF-044

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

**Provider options live in the config package.** `endpoints[].options` is a discriminated union on `provider` (`bitbucket-cloud`: `workspace`; `github`: `org`, `appId`, `installationId`), because DEP-040 is normative and the config package has no dependencies (ARC-012). The glossary terms (GLO-002) are used here as configuration keys mandated by DEP-040, not as core, facet, database or UI vocabulary. A new provider adds a member to the union in the same PR.

**Quota overrides** are `endpoints[].quota.overrides`: resource group name to a positive whole number. The keys are not validated against the Bitbucket list because JOB-043 says updated numbers need no code change; the adapter decides which names it reads. `quota` is accepted on every endpoint, not only on Bitbucket, so one shape serves all providers.

**Durations** use `Ns`, `Nm`, `Nh`, `Nd` with a whole number. They are parsed to milliseconds in the output. Other units (`ms`, weeks, ISO 8601) are rejected to keep one notation.

**Cron** is five fields, numeric only (no names, `L`, `W`, `#` or `?`). A step must be between 1 and the field maximum. A cron with a sixth seconds field is rejected, because BullMQ schedulers in DEP-040 use the five-field form.

**Naming pipelines.** A step's variable must be initialized by an earlier step; the template may only use initialized variables. `replace` patterns must compile as JavaScript regular expressions (flag `u`). Validation of the target name (length, characters) remains LIF-031's job at analysis time.

**Cross-field rules** checked when the rest of the document is valid: endpoint and route ids are unique; route source and target are defined endpoints and differ; in `production`, `publicUrl` is https, `auth.entra.tenantId` is set, and `auth.testSignIn.enabled` is false (AUTH-012, Q66). A cross-field rule is not reported when an earlier error already stopped validation, which is how Zod works.

**Role mapping method** is a lowercase name, not an enum, because AUTH-010 says future sign-in methods map their own claims. `entra` is the only method named in the spec.

## Alternatives

- Requiring every key to be explicit would fail the local development start with no benefit.
- Accepting unknown keys with a warning would keep the file forward compatible, but a warning in a container log is easy to miss for a policy.
- Moving provider options to the adapters (validated through a registry hook) keeps config free of provider words, but adds a registration step and needs config to accept opaque options first. Revisit if a third provider makes the union large.

## Affected requirements

DEP-040, ARC-030, AUTH-010, AUTH-012, FAC-005, JOB-043, JOB-050, LIF-030, LIF-044, ADR-0020.
