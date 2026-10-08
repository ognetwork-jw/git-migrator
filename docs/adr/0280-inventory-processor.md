# ADR-0280: Inventory processor design

- Status: agent-decided
- Date: 2026-10-08
- Task: T-060
- Affects: JOB-030, DOM-014, AUTH-050, FAC-DKY-003, LIF-002

## Context

JOB-030 lists what inventory does but not how a pass is structured, how `source_missing` interacts with a running Migration, when Analyses go stale, or what "FAC-DKY-003 support data" means for this task. AUTH-050 step 2 leaves several cascade details open (ambiguous matches, which rows exist, what the stale rule is).

## Decision

- **One job per Endpoint.** `inventory.endpoint` lists everything in a single pass. `inventory.namespace` stays declared but is not enqueued: "not seen during a *complete* pass" needs one place that knows every repository, and a per-namespace fan-out would need a join step. A pass takes a Postgres session advisory lock per Endpoint (`inventory:<endpointId>`), so a scheduled run and a manual refresh never interleave; the second returns `{skipped: 'already-running'}`. Callers should still enqueue with `dedupeId: inventory-<endpointId>` (JOB-011).
- **Order.** Endpoint Migrations for the Route (DOM-014) are created first, so they exist even when the provider is down. Then namespaces (parents are linked in a second step, because a parent may be listed after its child), repositories of the namespaces whose adapter level has `holdsRepositories`, presence, repository Migrations, `source_missing` reconciliation, identities, groups, and the mappings of every Route the Endpoint belongs to (source or target side: a new target identity changes the matches of the source side).
- **Shutdown.** The pass checks `shutdown.aborted` before each page and each stage and throws `InventoryInterruptedError`, so BullMQ retries the job. Nothing is marked missing unless the whole listing finished.
- **Presence and `source_missing` are level-triggered.** A repository not seen in a complete pass becomes `presence = missing`; one seen again becomes `present`. Each pass then sends `source_missing` to every Migration whose repository is missing and `source_present` to every Migration in `source_missing` whose repository is back, through `core`'s `transition()`. While a Migration is `running`, the state machine defers the event (ADR-0058: "remembering it is the JOB layer's job"). The memory is `Repository.presence`: the next pass after the Run finishes sends the event again, so no queue of deferred events exists. `statusBeforeMissing` is saved by the machine and restored on `source_present`.
- **Stale rule.** A Migration with an Analysis becomes stale (`analysisStaleAt := now`) when its source repository's `providerUpdatedAt` changed or its `fullPath` changed (a rename may not bump the provider timestamp; the planned target name derives from the path). A Route's Migrations also become stale when a mapping change makes a principal resolve differently, that is when a `confirmed` mapping appears or changes (AUTH-050 step 5 applies the same rule to operator changes).
- **Size class.** `large` when the provider's `sizeBytes` is above `sizeClass.largeThresholdBytes`; when the provider reports no size, the stored `sizeBytes` is kept (a Run may have measured the mirror) and, with none, the last known `lfsBytes` decides (JOB-015).
- **Identity mapping rows.** One `IdentityMapping` per source Identity per Route (bots and non-members included), created `unmapped` when nothing matches. Only `unmapped` and `suggested` rows are recomputed; `confirmed`, `excluded` and `pending_invite` are never touched. A step that finds more than one candidate (two identities with the same email or display name) is ambiguous and falls through. Confidence: email 1.0, login 0.9, name 0.7. An automatic email confirmation sets `decidedAt` and leaves `decidedById` null (no Actor decided). `autoConfirmEmail` comes from the Route's stored policies; unreadable policies fall back to the default (true) with a warning.
- **Group mappings.** One `GroupMapping` per source Group per Route with `plannedSlug` = the source slug (naming pipelines of a later task may rewrite it); a target Group with the same slug (case-insensitive) makes it `suggested`, otherwise it stays `unmapped` (planned for creation). Same rewrite rule as identities.
- **Identities and groups are never deleted** by inventory; there is no presence flag for them (DOM). A Group member that is not a known Identity is left out of `memberIds`.
- **CSV emails.** An Identity whose `emailSource` is `csv` keeps its email when the provider reports none.
- **`Route.targetNamespaceId`** is set by the first inventory of the target Endpoint, from the namespace whose slug or key equals the Route's `targetNamespacePath` (case-insensitive).
- **FAC-DKY-003 support data.** Deploy keys are facet data and are only readable from stored Snapshots, which exist after Analysis (T-061). Inventory provides what that computation needs and nothing else: the complete, de-duplicated set of source Repository rows per Route with their `presence`. T-061 builds `routeIndex.deployKeyUsage` from Snapshots of present repositories (follow-up recorded in the PR).
- **Empty listings.** A pass that sees zero Namespaces or zero Repositories while the database has present Repositories for that Endpoint is suspicious (a revoked grant or an outage answering 200 looks like this): it upserts what it saw, but marks nothing missing, sends no `source_missing`, logs a warning and returns `suspicious: true`. A genuinely emptied Endpoint stays unchanged until a later pass lists something; an operator can retire the Endpoint.
- **Guarded writes.** Reads and writes are not one transaction (a pass is long), so every write that depends on a read is conditional: the lifecycle write carries the status and saved-status fields it read (a Run that started meanwhile makes it a no-op, retried by the next pass), and mapping rewrites require `status in (unmapped, suggested)` (an operator decision made meanwhile survives, and the row is not counted as changed).
- **One-to-one automatic confirmation.** When several sources would be confirmed to the same target by email, or the target is already confirmed by a decided mapping, the cascade demotes them to `suggested`.
- **Cost.** Matching indexes the targets by email, login and normalized name once per Route (O(sources + targets)) and yields to the event loop every 500 sources. Write loops check for shutdown per row; unchanged repositories only get their `lastInventoriedAt` bumped, in batches.
- **Listing loops.** A listing that returns a cursor it already returned fails with an `invalid` AdapterError. If the advisory-lock release fails, the connection is destroyed instead of being returned to the pool.
- **Target namespace.** Preferred: a top-level namespace whose slug or key equals the Route's path; it is resolved again when the stored id is not one of the Endpoint's namespaces; an unresolved or ambiguous path logs a warning and is left unset.
- **Events.** Publishing live-update events is left to T-022; inventory has no dependency on it.

## Alternatives

- Fan out per namespace: more parallelism, but presence needs a barrier and BullMQ flows add failure modes.
- Enqueue a deferred `source_missing` event for running Migrations: another store to keep consistent; `presence` already is that store.
- Delete or flag missing Identities: unspecified, and mappings reference them (restricted FKs).

## Affected requirements

JOB-030, DOM-014, AUTH-050, FAC-DKY-003, LIF-002.
