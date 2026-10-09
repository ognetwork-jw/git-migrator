# ADR-0331: The diff view, its redaction, and the naming preview

- Status: agent-decided
- Date: 2026-10-09
- Task: T-062
- Affects: API-020, API-011, AUTH-022, LIF-030, LIF-031, LIF-063, FAC-WEB-002, FAC-SEC-001, ADP-014

## Context

`GET /migrations/{id}/diff` is specified as "Latest ParityResult and Snapshots side by side" and `POST /routes/{id}/naming/preview` as "Names and collisions for the rule". Neither fixes the shape, what is redacted, where the target's name limits come from (the connection supplies them, and a preview must not contact a provider), or how large Routes are paged.

## Decision

### Diff

- **Shape.** For the Migration's latest Analysis, one entry per Facet (registry dependency order, then alphabetical for unknown keys): the source Snapshot data, the desired target state and the translation's field `decisions` (fidelity markers) from `Analysis.translation`, the target Snapshot data, the unreadable paths and fetch times, the latest `ParityResult` (newest `checkedAt`, `diffs` and `excluded`) and the active Expected Differences (`revokedAt` null, the Migration's own and the Route-wide ones). Only the newest ParityResult per Facet is read (`distinct` on `facetKey`). `?facetKey` narrows to one Facet (422 for a key the registry does not know). A Migration without an Analysis has an empty `facets` list.
- **Redaction.** The response is built with the same intent as the audit diff (AUTH-022) but is kept useful for a diff view: a string under a key that `isSensitiveKey` (the log redactor's rule) accepts, or below such a key, becomes `[REDACTED]`, and so does the `value` of a `{name|key, value}` pair whose name is sensitive; booleans, numbers and `null` stay, so `hasSecret: true` and counts still diff; the `secrets` and `org-secrets` Facets hold names only (FAC-SEC-001), so their keys are not treated as secret names, but any string under `value`, `encrypted_value`, `secret`, `token`, `password` or similar is still redacted; `url` fields of `webhooks` and `org-webhooks` reduce to `<origin>/…` (`redactWebhookUrl`, FAC-WEB-002); every other string goes through `redactString` (URL userinfo, credential schemes, token shapes). A ParityResult side is sensitive when ANY segment of its `path` is a sensitive key (bracket indices stripped) or a bracket selector such as `[name=Authorization]` names one. Notes and unreadable paths go through `redactString`. Raw response bodies, Snapshot hashes and raw response ids are never returned. The `redactValue` of the log redactor was not used as is: it replaces whole subtrees by key, which would hide `hasSecret` and the secret names.
- **Authorization.** `read` (viewer): the diff holds nothing a viewer cannot read through RPC (Snapshots, Analyses, ParityResults), and it is redacted further.

### Naming preview

- **Rule body.** `{rule: {scope: "namespace" | "repository", scopeRef, pipeline | override}}`, exactly one of `pipeline` and `override` (override only at repository scope), mirroring the `NamingRule` model. `scopeRef` must be a Namespace or Repository of the Route's source Endpoint (404 otherwise). The candidate replaces the saved rule of its own scope; every other saved rule and the Route default apply with the LIF-030 precedence.
- **Limits without a connection.** The target's `repositoryName` limits come from `ProviderRegistry.repositoryNameLimits(type)`, filled at composition from the adapters' static limits (the target adapter now exports its limits as `githubLimits`; the source adapter already exported `limits`). The connection's own limits still decide at analysis time. A target type without registered limits answers 409.
- **Existing targets.** No provider is contacted, so the only existing targets the plan sees are those already claimed by a Migration of the Route (`targetRepositoryId`); a repository that exists on the target and belongs to no Migration is not detected (`target.exists-*` findings come from the analysis). The preview reports `naming.invalid`, `naming.collision` and `target.owned-by-other-migration` as `planRouteNaming` produces them.
- **Result.** Every Migration of the Route is named in memory (collisions need all of them). The response lists the in-scope Migrations plus the members of every collision group that involves one (`items`, sorted by Migration id, cursor paginated with the id as cursor, API-011), each with its current `plannedTargetName`, the previewed name, whether it `changed`, the rule source and the findings, plus the collision groups and a summary (`affected`, `changed`, `invalid`, `colliding`). Nothing is written and nothing is enqueued.
- **Limit.** Collisions need the whole Route, so a Route with more than 20,000 present repositories answers 422 `validation_failed` (the message names the count and the limit) instead of planning without bound.
- **Path.** The API-020 path `POST /routes/{id}/naming/preview` is authoritative over the wording in LIF-031.
- **Authorization.** `operate` (operator), as the API-020 table says, although saving a rule is an admin action.

## Alternatives

- Reuse `redactValue` or `auditValue` unchanged: they hide the structure the diff exists to show.
- Connect to the target for its limits: slow, uses quota and credentials, and a preview must work when the provider is down.
- Return every Migration of the Route: unbounded output for a one-namespace rule.
