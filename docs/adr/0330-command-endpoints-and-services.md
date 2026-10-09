# ADR-0330: Command endpoints and their services (batch 1)

- Status: accepted (spec updated)
- Date: 2026-10-09
- Task: T-062
- Affects: API-010, API-011, API-020, API-021, AUTH-021, AUTH-022, JOB-011, JOB-030, JOB-060, LIF-020

## Context

API-020 lists `POST /inventory/refresh` and `POST /migrations/{id}/analyze` with their effect ("Enqueue inventory", "Enqueue interactive analysis") and nothing else. The spec does not say what the response is, which Migrations may be analyzed, whether the commands are audited or publish events, or how `packages/api` obtains the job producer, the quota service and the registry (until now `createApiApp` needed only the database, auth and the event hub).

## Decision

- **Services are injected.** `ApiDeps.services` holds `jobs` (a `JobRuntime` used only to enqueue and to read queues), `quota` (`QuotaService.snapshot`) and `registry` (`ProviderRegistry`). The process owner builds them: the web process creates a producer-only `JobRuntime` (`workerCount: 0`, as the runtime documents), a `QuotaService` with the configured tuning, and `createBuiltinRegistry()`, and closes the runtime on shutdown. Each service is optional, so a test or process that does not need an endpoint leaves it out. An endpoint whose service is missing answers 503 `not_ready` (an existing problem code, so `problem.not_ready` in `apps/web/messages/en.json` already covers it) rather than 500.
- **Responses are 202.** Both commands only enqueue, so they answer 202 Accepted. `POST /inventory/refresh` returns `{endpoints: [ids]}` (the Endpoints a pass was requested for). `POST /migrations/{id}/analyze` returns `{migrationId, queue: "analysis-interactive"}`. A request that BullMQ deduplicates against an already queued job still answers 202: the wanted work is queued either way.
- **Inventory refresh.** Without a body, every `active` Endpoint (sources and targets, as the scheduler does) is enqueued; `{endpointId}` enqueues that one (404 unknown, 409 retired). Each job goes to the `inventory` queue with the dedupe id `inventory-<endpointId>` that ADR-0280 recommends. The body is optional.
- **Analyze.** The job goes to the interactive queue through `JobRuntime.enqueueAnalysis(id, 'interactive')`, which uses the dedupe id `analysis-<migrationId>` (ADR-0310). Dedupe ids are per queue, so a queued background analysis does not suppress the interactive one. A Migration in status `source_missing` (the source cannot be read) answers 409 `conflict`; any other status, `running` and endpoint Migrations included, is accepted: the processor leaves `running` unchanged (LIF-002). The status check and the enqueue are not atomic: a Migration that turns `source_missing` in between is analyzed and the analysis fails, which the failure backoff of ADR-0312 handles. The feeder's exclusion of `verified`, `manually_completed` and `rolled_back` applies to automatic selection only; an operator may ask for those explicitly.
- **Audit, no domain events.** AUTH-022 says every mutation by an Actor produces an `AuditEvent`. An enqueue is not a model mutation, but both commands write one (`inventory.refresh` per Endpoint, subject type `endpoint`; `migration.analyze`, subject type `migration`) after the enqueue succeeded, so the log shows what was requested. Neither command changes lifecycle state, so neither publishes a JOB-060 event: the inventory and analysis processors publish `inventory.progress` and `migration.updated` when they change something.
- **Outages are 503.** A queue call (`enqueue`, `enqueueAnalysis`, the reads of the quota view) or a database connection failure (refused, reset, timed out, shut down) is answered 503 `not_ready` with `Retry-After: 5` and no detail of the fault; the fault is logged as safe fields only. The producer pool in the web process has a 5 s checkout timeout so an outage fails in seconds. No audit row is written for a command that failed to enqueue.
- **At-least-once audit.** The audit event is written after the enqueue, so a crash between the two loses the event while the job runs, and a request BullMQ deduplicates still audits (BullMQ does not say whether an add was deduplicated, so the event cannot record it).
- **Authorization.** `operate` (operator) for both commands and for the naming preview, `read` (viewer) for the reads, all through `can()` (AUTH-021), as the API-020 table states.
- **No mapping changes.** None of these endpoints edits mappings, naming rules or tasks, so the ADR-0310 obligations (`markAnalysesStale`, `completedById`) do not apply here.

## Alternatives

- Make the services required in `ApiDeps`: every existing test and the composition would need fakes for endpoints they do not call.
- Answer 200 with a job id: the id of a deduplicated job is another request's job, and nothing consumes it.
- Refuse an analyze request while a job is already queued: the dedupe id already collapses them, and the caller wants the outcome, not an error.
