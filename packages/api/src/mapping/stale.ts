import { type Db, markAnalysesStale } from '@git-migrator/db';

/** The slice of a transaction or client that marking needs. */
export type StaleTx = Pick<Db, 'migration' | '$queryRaw'>;

/**
 * Marks the Analyses of every Migration on a Route stale (AUTH-050 step 5) with the shared
 * `markAnalysesStale` (LIF-021, ADR-0310): the generation of every Migration of the Route is
 * bumped, also those never analyzed or already stale, on the database clock and with row locks in
 * id order. Returns the number of Migrations that became stale now; the caller publishes one
 * list event when it is above zero.
 */
export async function markRouteAnalysesStale(tx: StaleTx, routeId: string): Promise<number> {
  return (await markAnalysesStale(tx, { routeId })).length;
}
