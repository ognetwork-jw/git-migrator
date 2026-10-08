# @git-migrator/jobs

Queue names, job payloads, the BullMQ runtime on PostgreSQL, the scheduler leader, schedulers, maintenance jobs, Run leases and the reaper, retention, scratch handling and the worker health server (JOB-010 to JOB-015, JOB-046, JOB-050, ARC-023, LIF-046, DATA-020). Inventory (JOB-030, DOM-014, AUTH-050 step 2). Decisions: ADR-0210, ADR-0211, ADR-0212, ADR-0280, ADR-0281.

Internal dependencies (ARC-012, checked by `pnpm lint`): @git-migrator/core, @git-migrator/canonical, @git-migrator/db, @git-migrator/quota, @git-migrator/registry, @git-migrator/git, @git-migrator/adapter-sdk, @git-migrator/config, @git-migrator/observability, @git-migrator/guidance.

## Runtime

- `queues.ts`: the seven queues, which jobs each carries, role to queue mapping (`queuesForRole`), concurrency from config, default job options (`removeOnComplete` 1 day, `removeOnFail` 7 days, 3 attempts with exponential backoff, 1 for Run queues), `runQueue` / `analysisQueue` routing.
- `payloads.ts`: strict Zod payloads, IDs only. Validated on enqueue and again on processing.
- `runtime.ts`: `JobRuntime` owns the shared `pg.Pool` (`search_path = bullmq`), one Queue per name, and Workers. `enqueue`, `enqueueAnalysis` and `enqueueRun` deduplicate with `deduplication.id`. `startWorkers(role, config, handlers)`, `close()` (graceful), and `isRunJobPending(dedupeId)` for the reaper.
- `connection.ts`: `migrateBullmqSchema` is DATA-030 step 4; `bullmqPoolSize` is the JOB-014 formula (see `docs/deployment.md`).
- `telemetry.ts`: `bullmq-otel` traces for every Queue and Worker (DEP-050).
- `leader.ts`: `LeaderElection` with `pg_try_advisory_lock` (ARC-023). `schedules.ts`: `desiredSchedulers`, `reconcileSchedulers`, `SchedulerManager` (JOB-050).
- `maintenance.ts`: handlers for `maintenance.prune` (`QuotaService.prune()` plus hourly `retention.ts`), `maintenance.scratch-cleanup`, `maintenance.run-reaper`; scheduled jobs of later tasks complete as skipped (ADR-0212).
- `run-leases.ts`, `reaper.ts`: Run lease claim, renew, release and `keepRunLease`; pending markers that carry the awaited job's deduplication id; `reapRuns`, which counts a dead resume or hand-off job toward the bound (LIF-046). The Run executor (T-070) uses `keepRunLease`.
- `scratch.ts`: size class, disk precheck, per-Run scratch directory, cleanup (JOB-015).
- `provider-wiring.ts`: `RawCaptureSink` over `RawResponse`, `ProviderTelemetry` over `MetricRecorders` and the tracer, and `createProviderEnvironment` for the adapter host (ADR-0190).
- `inventory/`: the `inventory.endpoint` processor (`runInventory`, `inventoryHandlers`). One pass per Endpoint under an advisory lock: namespaces, repositories (upsert by provider id, presence, renames, size class, stale marking), Migrations (DOM-014), `source_missing` / `source_present` through the lifecycle machine, identities, groups, and the AUTH-050 matching cascade (`matching.ts`, pure) for every Route the Endpoint belongs to. `connector.ts`: `EndpointConnector` and `createEndpointConnector` (adapter config, credential and account key from config and secrets, through the registry). Handlers check `ctx.shutdown.aborted` and throw `InventoryInterruptedError`. Inventory is not a Run: it uses no Run lease. Live-update events are not published yet (T-022).
- `analysis/`: the `analysis.migration` processor (`runAnalysis`, `analysisHandlers`) and the `analysis.feeder` processor (`runFeeder`, `feederHandlers`).
  - `analysis.ts`: reads the Facets of a repository Migration (source, and the target when it exists) or of the endpoint Migration, with read-time capabilities overlaid on the static ones, resolves the planned target name and collisions (`planRouteNaming`), builds the translate context (principal resolvers over the mappings, `routeIndex`), translates, builds the Plan. Counts provider calls for the per-Route mean `avgCallsPerAnalysis`. `AnalysisDeps.git` is the `GitClient` for `git-refs` (`createAnalysisGitClient`).
  - `persist.ts`: one transaction for Snapshots, Analysis, PlanItems, ManualTask upsert (done stays done; an `obsolete` dismissal by the Analysis is reopened on recurrence), Expected Differences, readiness, the guarded `analysis_completed` write, and `migration.updated` / `task.updated` events.
  - `context.ts`: pure helpers (FAC-006 resolvers, deploy-key usage, LIF-045 filtering, read warnings).
  - `fresh.ts`: `needsReanalysis`, `analyzeForRun` and `readinessWorsened` for the Run executor (LIF-021, LIF-022: abort with `readiness_changed`).
  - `feeder.ts`: enqueues background analyses per source Endpoint within the free background capacity of its quota buckets, minus the queued backlog, in JOB-022 priority order, through `JobRuntime.enqueueAnalysis` (dedupe ids); `maxBatch` 50.
  - Failures: a fault retrying cannot fix is an `AnalysisError` (`UnrecoverableError`); the last failed attempt sets `Migration.analysisFailedAt` / `analysisFailureCount` and the feeder backs off 5 min doubling to 6 h (ADR-0312). A future mapping-edit endpoint must call `markAnalysesStale` for the Route (AUTH-050 step 5), and every task-dismiss path must set `completedById` (ADR-0310).
  - Staleness: `analysisStaleAt <= now` is stale. Marked by `syncConfig` (Route configuration), a database trigger (NamingRule, WebhookAllowlistEntry, Overlay), inventory (provider timestamp, mappings) and the Analysis itself (deploy-key holders), all through `markAnalysesStale` or its SQL twin in `@git-migrator/db`.
- `health.ts`, `queue-metrics.ts`: the worker health server (port 8081) and the `gm_queue_jobs` gauge.

Handlers are registered by the process: `JobHandlers` maps a job name to `(payload, { job, queue, log, shutdown }) => Promise`. A job without a handler fails without retry.

Tests use a throw-away Postgres database (`@git-migrator/db/testing`) and real BullMQ; no provider is contacted.
