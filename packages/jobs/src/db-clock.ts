import type { Db } from '@git-migrator/db';

/**
 * The database clock. Times that are compared across processes (an Analysis against an inventory
 * pass, a stale mark against an Analysis start) are all read from here, so the comparison never
 * depends on the clocks of different workers (ADR-0310).
 */
export async function databaseNow(client: Pick<Db, '$queryRaw'>): Promise<Date> {
  const rows = await client.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return (rows[0] as { now: Date }).now;
}
