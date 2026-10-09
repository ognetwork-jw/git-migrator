/**
 * Transaction-scoped advisory locks shared by the API and the jobs (ADR-0320, ADR-0370, ADR-0435).
 * Two writers exclude each other only when they hash the same key the same way, so every path
 * takes its locks through `advisoryXactLock` and builds its keys with the functions here.
 * Lock order: the target Endpoint's invitation lock, then the Route mapping lock, then rows.
 */
import type { Db } from './client.ts';

/** The Route mapping lock key (identity and group mappings of one Route, ADR-0320). */
export const routeMappingLockKey = (routeId: string): string => `identity-mapping:${routeId}`;

/** The invitation lock key of a target Endpoint (AUTH-061 holds per target organization, ADR-0370). */
export const invitationTargetLockKey = (targetEndpointId: string): string =>
  `invitation-target:${targetEndpointId}`;

/** Takes `key` until the end of the transaction. The one hash everybody uses. */
export async function advisoryXactLock(tx: Pick<Db, '$executeRaw'>, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`;
}
