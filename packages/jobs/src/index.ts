/** The workspace package name (ARC-011). */
export const PACKAGE_NAME = '@git-migrator/jobs';

export {
  type AnalysisDeps,
  AnalysisError,
  AnalysisInterruptedError,
  type AnalysisResult,
  type AnalysisRunOptions,
  analysisHandlers,
  DEFAULT_NAMING,
  routeNaming,
  runAnalysis,
} from './analysis/analysis.ts';
export {
  deployKeyUsage,
  groupResolver,
  identityResolver,
  withoutFrameworkCreated,
} from './analysis/context.ts';
export {
  DEFAULT_MAX_BATCH,
  FEEDER_EXCLUDED_STATUSES,
  type FeederDeps,
  type FeederResult,
  feederHandlers,
  freeBackgroundCalls,
  runFeeder,
} from './analysis/feeder.ts';
export {
  type AnalysisAge,
  analyzeForRun,
  needsReanalysis,
  type RunAnalysisOutcome,
  readinessWorsened,
} from './analysis/fresh.ts';
export { createAnalysisGitClient } from './analysis/git.ts';
export {
  assertBullmqSchemaReady,
  BULLMQ_SCHEMA,
  type BullmqPoolOptions,
  bullmqPoolSize,
  createBullmqPool,
  migrateBullmqSchema,
  QUERY_CONNECTIONS,
} from './connection.ts';
export {
  HEALTH_PORT,
  type HealthServer,
  type HealthServerOptions,
  startHealthServer,
} from './health.ts';
export {
  adapterConfigFor,
  type ConnectOptions,
  createEndpointConnector,
  type EndpointConnector,
  type EndpointConnectorOptions,
  noGitClient,
} from './inventory/connector.ts';
export {
  type InventoryDeps,
  InventoryInterruptedError,
  type InventoryResult,
  type InventoryRunOptions,
  inventoryHandlers,
  runInventory,
} from './inventory/inventory.ts';
export {
  matchGroup,
  matchIdentity,
  normalizeDisplayName,
} from './inventory/matching.ts';
export { LEADER_LOCK_NAME, LeaderElection, type LeaderElectionOptions } from './leader.ts';
export {
  createPruner,
  type MaintenanceDeps,
  maintenanceHandlers,
  type PruneResult,
  type QuotaPruner,
  RETENTION_INTERVAL_MS,
} from './maintenance.ts';
export {
  InvalidPayloadError,
  isJobName,
  JOB_PAYLOADS,
  type JobPayloads,
  parsePayload,
} from './payloads.ts';
export {
  createProviderEnvironment,
  createProviderTelemetry,
  createRawCaptureSink,
  type ProviderEnvironmentOptions,
} from './provider-wiring.ts';
export {
  QUEUE_STATES,
  type QueueGaugeSink,
  recordQueueCounts,
  resetQueueCounts,
  startQueueMetrics,
} from './queue-metrics.ts';
export {
  type AnalysisPriority,
  analysisQueue,
  attemptsFor,
  BACKOFF_DELAY_MS,
  type ConsumerGroup,
  concurrencyFor,
  defaultJobOptions,
  type JobName,
  MAINTENANCE_CONCURRENCY,
  QUEUE_DEFINITIONS,
  QUEUE_NAMES,
  type QueueName,
  queuesForRole,
  REMOVE_ON_COMPLETE,
  REMOVE_ON_FAIL,
  type RunRouting,
  runQueue,
  WORKER_ROLES,
  type WorkerRole,
} from './queues.ts';
export {
  MAX_REAPER_RESUMES,
  type ReaperMetrics,
  type ReaperOptions,
  type ReaperResult,
  RUN_ABANDONED,
  type RunEnqueuer,
  reapRuns,
} from './reaper.ts';
export { applyRetention, type RetentionResult } from './retention.ts';
export {
  claimRunLease,
  HANDOFF_PENDING_OWNER,
  handOffRun,
  type KeepRunLeaseOptions,
  keepRunLease,
  newLeaseToken,
  type PendingMarkerKind,
  parsePendingMarker,
  pendingMarker,
  RESUME_PENDING_OWNER,
  RUN_LEASE_LOCAL_LIMIT_MS,
  RUN_LEASE_RENEW_MS,
  RUN_LEASE_TTL_SECONDS,
  type RunEnqueuerLike,
  type RunLeaseHandle,
  releaseRunLease,
  renewRunLease,
} from './run-leases.ts';
export {
  type EnqueueOptions,
  type JobContext,
  type JobHandler,
  type JobHandlers,
  JobRuntime,
  type JobRuntimeOptions,
} from './runtime.ts';
export {
  desiredSchedulers,
  endpointMigrationIds,
  reconcileSchedulers,
  SCHEDULED_QUEUES,
  SchedulerManager,
  type SchedulerManagerOptions,
  type SchedulerSpec,
} from './schedules.ts';
export {
  checkScratchSpace,
  classifySize,
  cleanScratch,
  DEFAULT_SCRATCH_DIR,
  estimateScratchNeed,
  isScratchActive,
  releaseScratchReservation,
  runScratchPath,
  SCRATCH_DELAY_MS,
  SCRATCH_INSUFFICIENT,
  SCRATCH_MAX_AGE_MS,
  SCRATCH_MAX_DELAYS,
  ScratchCleaner,
  type ScratchSpace,
  scratchRoot,
  withRunScratch,
} from './scratch.ts';
export { createBullmqTelemetry } from './telemetry.ts';
