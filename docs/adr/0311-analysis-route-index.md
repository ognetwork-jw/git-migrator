# ADR-0311: What the Analysis puts into the translate context

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-061
- Affects: FAC-DKY-003, FAC-PIP-002, FAC-PIP-003, FAC-WEB-002, FAC-END, ADP-011, ADP-030, ADP-031, ARC-012, ADP-060

## Context

`translate` is pure and synchronous (ADP-031), so everything it needs beyond one document arrives in `ctx.route` and `ctx.routeIndex` (plain JSON, ADR-0140). Several follow-ups name the keys the facets read and ask the Analysis to fill them. `routeIndex.pipelines.sources` is the hard one: the pipelines document holds only the sha256 of the file, no connection method returns the text, and the translation lives in an adapter package that the job may not import (ARC-012).

## Decision

- **`ctx.route`** is `{ defaults: Route.defaults, webhookAllowlist: [WebhookAllowlistEntry.pattern] }`.
- **`routeIndex.pipelines.sources`.** `FacetRead` gains an optional `attachments: Record<sha256, string>`: in-memory content that `data` refers to only by hash. The Bitbucket pipelines driver fills it with the file text it already fetched to compute the hash. The Analysis merges the attachments of all reads into `routeIndex.pipelines.sources` and drops them. They are never persisted (Snapshots hold the hash only), never captured (the driver still reads with `capture: false`), never logged, and not part of the stored translation (a test searches the stored rows for a marker in the file). Neutral names throughout, so ARC-012 and ADP-060 hold. `routeIndex.pipelines.workspaceVariables` and `workspaceSecrets` are the names in the latest source Snapshot of `org-variables` and `org-secrets`, when the endpoint Migration has produced one.
- **`routeIndex.deployKeyUsage` (FAC-DKY-003).** For a repository Migration: per public key, the number of present source repositories on the Route, from the latest stored `deploy-keys` Snapshot of each other repository plus the keys just read for this one. Because an Analysis only knows the Snapshots stored so far, the first repository analyzed would never see the second. When the keys of this repository changed against its previous Snapshot, the Migrations whose latest Snapshot holds a changed key are marked stale (`migration.updated` is published for them), so the holders are analyzed again and the result converges whatever the order. Pre-detection raises the same `deploy-keys.key-in-use` post task the Run raises when the target refuses the key; the Run-time raise stays with the lifecycle (T-071).
- **Endpoint index (T-056 follow-up).** For an endpoint Migration: `targetOrgMembers` are the provider ids of the target Identities with `isMember`; `plannedSlugs` maps each source group's provider id to `GroupMapping.plannedSlug`; `invitationCandidates` are the provider ids of source Identities with a known email that have no mapping or an `unmapped` one (decided mappings, sent invitations and exclusions are not candidates).
- **Adapter read warnings.** `FacetRead.warnings` are plan warnings only when the Facet declares the code as a `warning` finding and the code starts with the Facet key (`webhooks.duplicate-url`, `branch-rules.branching-model`, `branch-rules.unknown-kind`). They have guidance, never gate, and are deduplicated by code and params. All others (reader diagnostics such as `webhooks.invalid-url`) are stored under `translation.readDiagnostics` of the Analysis and never shown as findings. This surfaces `mergeDuplicateWebhooks` warnings from both sides.
- **`branch-rules.exemptions-dropped`** is decided at translation time by the facet (a lossy decision); the driver's `resourceRef.exemptionsDropped` on the Mutation is a Run-time fact for the Run executor (T-071/T-072), not for the Analysis. Left to those tasks.

## Alternatives

- Add a connection method that returns file text: widens the contract for one Facet, and every call site would need quota and capture rules for a body that must not be captured.
- Put the text into the canonical document: changes the normative schema (ADR-0160) and stores file bodies.
- Compute key usage with a database query over all Snapshots at translate time: the facets are pure and receive plain JSON, so the Analysis computes it.

## Affected requirements

FAC-DKY-003, FAC-PIP-002, FAC-PIP-003, FAC-WEB-002, FAC-END, ADP-011, ADP-030, ADP-031, ARC-012, ADP-060.
