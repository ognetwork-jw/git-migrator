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
export {
  type CorrelateDeps,
  type CorrelateResult,
  correlateInvitations,
  INVITATION_UNRESOLVED_AFTER_MS,
  type InvitationDeps,
  InvitationInterruptedError,
  type InvitationStep,
  invitationHandlers,
  invitationTargetLockKey,
  normaliseEmail,
  type RevokeResult,
  runInvitationRevoke,
  runInvitationSend,
  runSeatPreview,
  type ScheduleInvitationStep,
  type SeatPreview,
  type SendResult,
} from './invitations/index.ts';
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
  computeParity,
  type FacetParity,
  type LfsObjectSource,
  MAX_STORED_DIFFS,
  type ParityComputation,
  type ParityDeps,
  ParityError,
  type ParityOptions,
  type ParityServices,
  type ParitySkip,
  ScratchInsufficientError,
  type StoredDiff,
  type StoredExclusion,
} from './parity/compute.ts';
export {
  applyContainment,
  checkLfsObjects,
  MAX_LISTED_OIDS,
  type RefRelation,
} from './parity/git.ts';
export { createMirrorLfsSource, type MirrorLfsSourceOptions } from './parity/lfs-source.ts';
export { mergeOverlay } from './parity/overlay.ts';
export { redactAtPath, redactFacetValue } from './parity/redact.ts';
export {
  PARITY_STATUSES,
  type ParityRunResult,
  parityHandlers,
  runParity,
} from './parity/run.ts';
export {
  createVerifyPlanner,
  createVerifyStep,
  VERIFY_STEP_KEY,
} from './parity/step.ts';
export {
  PARITY_COMPLETION_ACTION,
  PARITY_COMPLETION_NOTE,
  type StoreResult,
  storeParity,
} from './parity/store.ts';
export {
  applyParityVerdict,
  PARITY_RUN_KINDS,
  type ParityVerdict,
  parityVerdict,
  type VerdictApplied,
} from './parity/verdict.ts';
export {
  branchPatternMatches,
  chooseDefaultBranch,
  connectSide,
  createMigrationPlanner,
  effectiveMaxPushBytes,
  IMPLEMENTED_STEP_KEYS,
  MIGRATION_RUN_KINDS,
  type MigrationContext,
  MigrationLinks,
  type MigrationServices,
  registerMigrationSteps,
  type Side,
} from './migrate/index.ts';
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
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  retryDelayMs,
  StepFailure,
  serializeStepError,
} from './run/errors.ts';
export {
  ANALYSIS_GATED_KINDS,
  createRunAnalysisPort,
  DEFAULT_CANCEL_POLL_MS,
  type ExecuteOptions,
  type ExecuteResult,
  executeRun,
  type RunAnalysisPort,
  type RunExecutorDeps,
  runHandlers,
} from './run/executor.ts';
export {
  addRunBlocker,
  addRunTask,
  clearRunBlockers,
  type RunBlocker,
  recomputeReadiness,
} from './run/findings.ts';
export {
  applyRunFinished,
  type FinalRunStatus,
  finishRun,
  settleOrphanedMigrations,
} from './run/finish.ts';
export {
  ADOPTABLE_BLOCKERS,
  allowedReadiness,
  type CancelOutcome,
  type CreatedRun,
  type CreateRunInput,
  createRun,
  effectiveReadiness,
  type RunGuardCode,
  RunGuardError,
  requestRunCancel,
} from './run/guard.ts';
export { REPOSITORY_LEVEL_FACET, writeLedger } from './run/ledger.ts';
export {
  checkRunOptions,
  type OptionsCheck,
  type RunOptions,
  runOptionsSchema,
} from './run/options.ts';
export { QUEUED_GRACE_SECONDS, requeueOrphanedQueuedRuns } from './run/orphans.ts';
export {
  DEFAULT_MAX_ATTEMPTS,
  type LedgerWrite,
  type MigrationSnapshot,
  type MutationLike,
  RunCancelledError,
  RunLeaseLostError,
  type RunPlanInput,
  type RunPlanner,
  type RunSnapshot,
  RunStepRegistry,
  type StepContext,
  type StepDefinition,
  type StepFindings,
  type StepLedger,
  type StepResult,
  type StepSeverity,
} from './run/types.ts';
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
  startQueuedRun,
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
