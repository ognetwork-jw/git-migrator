/** The workspace package name (ARC-011). */
export const PACKAGE_NAME = '@git-migrator/db';

export {
  type CreateDbOptions,
  createDb,
  type Db,
  type DbHandle,
  type PolicyActor,
  type PolicyDb,
} from './client.ts';
export {
  buildConnectionString,
  type ConnectionParts,
  redactConnectionString,
} from './connection.ts';
export {
  createEventListener,
  type EventListener,
  type EventListenerOptions,
  type FeedMessage,
  type ListenClient,
  pgListenClient,
  publishEvent,
  publishEventIn,
  type QueryExecutor,
} from './events.ts';
export * from './generated/models.ts';
export { type SchemaType, schema } from './generated/schema.ts';
export { advisoryXactLock, invitationTargetLockKey, routeMappingLockKey } from './locks.ts';
export {
  type ApplyMigrationsOptions,
  applyAppMigrations,
  type ConfigSnapshot,
  type EndpointSpec,
  ensureSchemas,
  FRAMEWORK_BRANCH_DIFFERENCE,
  hashConfig,
  type RouteSpec,
  SCHEMAS,
  type SyncCounts,
  type SyncResult,
  syncConfig,
} from './migrate.ts';
export {
  SAMPLE_ALLOWLIST_PATTERN,
  SAMPLE_WAVE_NAME,
  type SeedResult,
  seedDev,
  TEST_ACTORS,
} from './seed.ts';
export { markAnalysesStale, type StaleScope, supersedeParityChecks } from './staleness.ts';
