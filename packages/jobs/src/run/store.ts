/**
 * Fenced writes of the Run executor. Every write of a worker that processes a Run happens in a
 * transaction that first locks the Run row `WHERE lease_owner = token`: a worker that lost the lease
 * (a slow pause, a partition, a reaper resume elsewhere) finds no row and writes nothing (LIF-046).
 *
 * Lock order, everywhere: Migration row, then Run row (ADR-0340). The guard that creates a Run and
 * the transaction that finishes one both take them in this order, so they cannot deadlock.
 *
 * Both rows are locked `FOR NO KEY UPDATE`, never `FOR UPDATE`: the foreign-key checks of the rows
 * the executor inserts (`mutation`, `expected_difference`, `run_step`, `run_log`) take `FOR KEY
 * SHARE` on the Migration and Run rows, which `FOR UPDATE` blocks but `FOR NO KEY UPDATE` does not.
 * With `FOR UPDATE`, a ledger write (holding the Run) and a cancel (holding the Migration) formed a
 * deadlock cycle.
 */
import type { DomainEvent, EventType } from '@git-migrator/core';
import { type Db, publishEventIn } from '@git-migrator/db';
import type { Logger } from '@git-migrator/observability';
import { reconcileLateWrite } from './late.ts';
import { RunLeaseLostError, type Tx } from './types.ts';

export type { Tx };

/** Locks the Run row if `token` still holds the lease; throws `RunLeaseLostError` otherwise. */
export async function fenceRun(tx: Tx, runId: string, token: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM app.run
    WHERE id = ${runId} AND lease_owner = ${token} AND status = 'running'
    FOR NO KEY UPDATE`;
  if (rows.length !== 1) throw new RunLeaseLostError();
}

/** Locks the Migration row. Always before the Run row. */
export async function lockMigration(tx: Tx, migrationId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM app.migration WHERE id = ${migrationId} FOR NO KEY UPDATE`;
}

async function countMutations(tx: Tx, runId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app.mutation WHERE run_id = ${runId}`;
  return rows[0]?.n ?? 0;
}

export interface LockedRun {
  readonly status: string;
  readonly kind: string;
  readonly leaseOwner: string | null;
  readonly hasMutations: boolean;
  readonly cancelRequestedAt: Date | null;
}

/** Locks the Run row whatever its state and returns it; undefined when there is none. */
export async function lockRun(tx: Tx, runId: string): Promise<LockedRun | undefined> {
  const rows = await tx.$queryRaw<
    {
      status: string;
      kind: string;
      lease_owner: string | null;
      has_mutations: boolean;
      cancel_requested_at: Date | null;
    }[]
  >`
    SELECT status::text AS status, kind::text AS kind, lease_owner, has_mutations, cancel_requested_at
    FROM app.run WHERE id = ${runId} FOR NO KEY UPDATE`;
  const row = rows[0];
  if (!row) return undefined;
  return {
    status: row.status,
    kind: row.kind,
    leaseOwner: row.lease_owner,
    hasMutations: row.has_mutations,
    cancelRequestedAt: row.cancel_requested_at,
  };
}

/**
 * The ledger's transaction: the Run row is locked, but not by lease token. A record describes
 * something that already happened on a provider, so it is written even after the lease was lost
 * or the Run finished (ADR-0342). For a finished Run the Migration row is locked first (lock
 * order), and the write is reconciled with the Migration's status afterwards (`late.ts`).
 */
export async function ledgerTransaction<T>(
  db: Db,
  runId: string,
  fn: (tx: Tx) => Promise<T>,
  options: { readonly now?: () => Date; readonly log?: Logger | undefined } = {},
): Promise<T> {
  const now = options.now ?? (() => new Date());
  // The status is read without a lock to learn which order to lock in. If the Run finishes in
  // between, the second pass locks the Migration first.
  let assumeFinished = false;
  for (let pass = 0; pass < 2; pass++) {
    const result = await db.$transaction(async (tx) => {
      const probe = await tx.$queryRaw<{ status: string; migration_id: string }[]>`
        SELECT status::text AS status, migration_id FROM app.run WHERE id = ${runId}`;
      const first = probe[0];
      if (!first) throw new Error(`Run ${runId} does not exist`);
      const finished = assumeFinished || (first.status !== 'queued' && first.status !== 'running');
      if (finished) await lockMigration(tx, first.migration_id);
      const run = await lockRun(tx, runId);
      if (!run) throw new Error(`Run ${runId} does not exist`);
      const runFinished = run.status !== 'queued' && run.status !== 'running';
      if (runFinished && !finished) return { retry: true as const };
      const countBefore = runFinished ? await countMutations(tx, runId) : 0;
      const value = await fn(tx);
      if (runFinished) {
        // Any record added to a finished Run is late; confirming an intent adds none.
        if ((await countMutations(tx, runId)) > countBefore) {
          await reconcileLateWrite(tx, {
            runId,
            migrationId: first.migration_id,
            runStatus: run.status,
            hadMutations: run.hasMutations,
            now,
            log: options.log,
          });
        }
      }
      return { retry: false as const, value };
    });
    if (!result.retry) return result.value;
    assumeFinished = true;
  }
  throw new Error(`Run ${runId} kept changing state`);
}

export interface FenceTarget {
  readonly runId: string;
  readonly token: string;
  /** Also lock the Migration row, before the Run row. */
  readonly migrationId?: string;
}

export function fenced<T>(db: Db, target: FenceTarget, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    if (target.migrationId !== undefined) await lockMigration(tx, target.migrationId);
    await fenceRun(tx, target.runId, target.token);
    return fn(tx);
  });
}

export function publish(
  tx: Tx,
  type: EventType,
  ids: DomainEvent['ids'],
  now: () => Date,
): Promise<void> {
  return publishEventIn(tx, { type, ids, at: now().toISOString() });
}

export const publishRun = (
  tx: Tx,
  ids: { run: string; migration: string },
  now: () => Date,
): Promise<void> => publish(tx, 'run.updated', ids, now);

export const publishMigration = (tx: Tx, migrationId: string, now: () => Date): Promise<void> =>
  publish(tx, 'migration.updated', { migration: migrationId }, now);

/** A JSON column value for the ORM, detached from the caller's object. */
export const toJson = (value: unknown): never => JSON.parse(JSON.stringify(value ?? null)) as never;
