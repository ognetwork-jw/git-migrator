# ADR-0160: pipelines facet and where the pair override lives

- Status: agent-decided
- Date: 2026-10-08
- Task: T-057
- Affects: FAC-PIP-001, FAC-PIP-002, FAC-PIP-003, FAC-PIP-004, ADP-032, ARC-012, GLO-002, FAC-002

## Context

FAC-PIP-002 names source constructs (`BITBUCKET_BRANCH`, `pipe:`) and target constructs (`on.push`, `actions/checkout`), so the translation is provider vocabulary. `packages/facets` may not contain it (GLO-002), `adapters/*` may not depend on `facets` or on each other (ARC-012), and `registry` is not on the GLO-002 list. The canonical `Pipelines` document holds only `files[].path`/`sha256`, `enabled` and `translation`, so neither the source text nor the generated workflow text is in it. The spec does not say how the translation reaches the source text.

## Decision

- **Split.** `packages/facets/src/pipelines` is provider-neutral: `normalize`, the parity rule, the finding declarations, `isTaskSatisfied` and a fail-closed default `translate`. The pair override `{ source: 'bitbucket-cloud', target: 'github', facet: 'pipelines' }` lives in `packages/adapters/github/src/pair-overrides/bitbucket-cloud-pipelines/`, because an adapter package is where GLO-002 allows provider vocabulary, and the output is GitHub workflow syntax. It is exported from the adapter package as `bitbucketCloudToGithubPipelines` for the registry (T-058) to register with `registerOverride`. The adapter imports only `core`, `canonical` and `yaml` (pinned 2.9.1, already used by `config`).
- **Source text.** `translate` is pure and synchronous (ADP-031), so the caller passes the text of the source file in the plain-JSON context: `routeIndex.pipelines.sources` maps the file's `sha256` to its text. Optional `routeIndex.pipelines.workspaceVariables` and `workspaceSecrets` list workspace-level names (the `org-*` facets are endpoint-scoped and cannot be dependencies of a repository facet). Repository and environment names come from `deps.variables.desired` and `deps.secrets.desired`. A missing text throws (the engine reports `translate_failed`), because that is a caller bug. T-060/T-061 must fill `routeIndex.pipelines` when they build the context.
- **Generated content is recomputable.** `desired.files[].sha256` is the hash of the generated workflow. The delivery step (LIF-047, `change-requests.open`) calls the exported `translatePipelinesYaml(text, names)` with the same inputs to obtain the workflow contents; the translation is deterministic. The original file as `.github/git-migrator/bitbucket-pipelines.yml` is delivered by that step and is not part of `files`.
- **Default translate** (pairs without an override): nothing is generated. With a file present and `enabled`, the file path is `translation.unsupported`, with one `unsupported` decision at `/translation/unsupported` and post task `pipelines.complete-translation` (`workflowPath` is the source file path, so the facet names no target path or provider). No file: empty, supported. `enabled: false` with a file: empty plus warning `pipelines.disabled` (path `/enabled`). A `/files` field the source adapter reports `unreadable` (empty repository) defaults to an empty document with an `unreadable_defaulted` decision and no task, like `merge-settings`.
- **Findings and completion.** Fully translated: `pipelines.review-and-merge`, params `{ workflowPath, branch: 'git-migrator/ci' }`. Any unsupported path: `pipelines.complete-translation` only (FAC-PIP-003 lists them as alternatives), params `{ unsupported, workflowPath }`. `workflowPath` joins all generated paths with `, ` because the guidance parameter is a single text. When nothing at all could be generated (invalid YAML, `pipelines: {}`, empty lists, every step unsupported) the source file path is added to `translation.unsupported`, only `pipelines.complete-translation` opens, no review task is raised, and `workflowPath` is the source file path. Both tasks carry `workflowPaths` (the generated paths). `isTaskSatisfied` holds only when `workflowPaths` is non-empty, the target holds every one of them, and parity has no `/files` difference, so an empty file set can never close a task by parity (round 1 review).
- **Parity (FAC-PIP-004)** is one-directional: only desired paths missing from the target produce a difference, so workflows that already exist in the target and are not generated never make the facet different. `sha256`, `enabled` and `translation` are not compared.
- **Normalize** keeps `translation.supported` consistent with `unsupported` (false when anything is unsupported) and sorts and deduplicates the list.
- **No policy keys.** No decision in FAC-PIP is `lossy`; unsupported constructs are `unsupported` and covered by the completion task. No entries are needed in `AGENT_DECIDED_CODES` or `AGENT_DECIDED_POLICY_KEYS`.
- **YAML paths** in `translation.unsupported` are dotted with bracketed indices (`pipelines.default[0].step.script[1].pipe`); keys that are not plain words are written `['key']`, with control characters replaced and `${{` neutralised to `$ {{`.

## Alternatives

- Put the override in `packages/registry` or `packages/facets`: rejected, provider vocabulary (GLO-002), and facets are pure and neutral.
- Add `content` fields to the canonical `Pipelines` document: rejected, it would change the normative schema (FAC-001) and put file bodies into comparison and storage.
- Make the override depend on both adapters: not allowed by ARC-012.
