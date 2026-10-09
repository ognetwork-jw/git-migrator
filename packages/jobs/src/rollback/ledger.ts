/**
 * What a rollback reads from the Mutation ledger (LIF-077, LIF-045): the records it may revert and
 * how each kind of record is reverted. `isUndoable` / `mutationsToUndo` in `@git-migrator/core` are
 * the one definition of "may revert"; the SQL here is its twin for the guard. Decisions:
 * docs/adr/0465-rollback.md.
 */
import { mutationsToUndo, type StoredMutation } from '@git-migrator/core';
import type { Db } from '@git-migrator/db';

/** The row of `app.mutation` a rollback works from. */
export interface LedgerRow extends StoredMutation {
  readonly id: string;
  readonly runId: string;
  readonly side: string;
  readonly facetKey: string;
  readonly action: string;
  readonly resourceRef: Record<string, unknown>;
  readonly paths: readonly string[];
  readonly before: unknown;
  readonly after: unknown;
  readonly state: string;
  readonly seq: bigint;
  readonly undoneAt: Date | null;
  readonly createdAt: Date;
}

/** The ledger rows of one side of a Migration, oldest first. */
export async function ledgerRows(
  db: Pick<Db, 'mutation'>,
  migrationId: string,
  side: 'source' | 'target',
): Promise<LedgerRow[]> {
  const rows = await db.mutation.findMany({
    where: { migrationId, side },
    orderBy: { seq: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    runId: r.runId,
    side: r.side,
    facetKey: r.facetKey,
    action: r.action,
    resourceRef: r.resourceRef as Record<string, unknown>,
    paths: r.paths,
    before: r.before,
    after: r.after,
    state: r.state,
    seq: r.seq,
    undoneAt: r.undoneAt,
    createdAt: r.createdAt,
  }));
}

/** The target-side records a rollback would revert, newest first (`mutationsToUndo`). */
export const undoableOf = (rows: readonly LedgerRow[]): LedgerRow[] => mutationsToUndo(rows);

/**
 * True when the ledger holds a record a rollback could revert, on either side (LIF-077: "provided
 * the Migration has a target or Mutations to undo"). The SQL twin of `isUndoable`.
 */
export async function hasUndoableMutations(
  db: Pick<Db, '$queryRaw'>,
  migrationId: string,
): Promise<boolean> {
  const rows = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app.mutation
    WHERE migration_id = ${migrationId} AND undone_at IS NULL AND state <> 'not_applied'
      AND coalesce(resource_ref->>'adopted', 'false') <> 'true'
      AND coalesce(resource_ref->>'noop', 'false') <> 'true'`;
  return (rows[0]?.n ?? 0) > 0;
}

/** How a record is reverted. */
export type Disposition =
  /** The target repository the framework created: deleted whole. */
  | 'repository'
  /** Refs and pushes are never undone on an adopted target (LIF-077): recorded as left in place. */
  | 'left'
  /** A framework Change Request: closed. */
  | 'change-request'
  /** A write whose own record was lost (ADR-0380): there is no exact reverse. */
  | 'unrecoverable'
  /** Everything else: the Facet driver's `undo`. */
  | 'driver';

/** Kinds of target record that describe git content (LIF-077: "leave git refs untouched"). */
const LEFT_KINDS: ReadonlySet<string> = new Set([
  'git-push',
  'lfs-push',
  'git-reconcile',
  'default-branch',
  'ref',
]);

export function dispositionOf(row: Pick<LedgerRow, 'action' | 'resourceRef'>): Disposition {
  const kind = String(row.resourceRef.kind);
  if (kind === 'repository' && row.action === 'create') return 'repository';
  if (LEFT_KINDS.has(kind)) return 'left';
  // A title patch on a Change Request is covered by closing it.
  if (kind === 'change-request') return row.action === 'create' ? 'change-request' : 'left';
  if (kind === 'recovered-write') return 'unrecoverable';
  return 'driver';
}

/**
 * The target-side records still to revert, read in the caller's transaction (the Migration row lock
 * is held, so a late write of an earlier Run cannot land between this read and the commit,
 * ADR-0342). At most `limit` are described; `count` is the total.
 */
export async function remainingTargetRecords(
  db: Pick<Db, '$queryRaw'>,
  migrationId: string,
  limit = 20,
): Promise<{ count: number; sample: { facetKey: string; kind: string; action: string }[] }> {
  const rows = await db.$queryRaw<{ facet_key: string; kind: string | null; action: string }[]>`
    SELECT facet_key, resource_ref->>'kind' AS kind, action FROM app.mutation
    WHERE migration_id = ${migrationId} AND side = 'target' AND undone_at IS NULL
      AND state <> 'not_applied'
      AND coalesce(resource_ref->>'adopted', 'false') <> 'true'
      AND coalesce(resource_ref->>'noop', 'false') <> 'true'
    ORDER BY seq DESC`;
  return {
    count: rows.length,
    sample: rows
      .slice(0, limit)
      .map((r) => ({ facetKey: r.facet_key, kind: r.kind ?? '', action: r.action })),
  };
}
