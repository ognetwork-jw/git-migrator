/**
 * The Mutation ledger writer (LIF-045, ADP-012): persists the `MutationRecord`s an adapter yields,
 * and the `framework_mutation` Expected Differences derived from them. Decisions:
 * docs/adr/0342-mutation-ledger.md.
 */
import { randomUUID } from 'node:crypto';
import {
  type DerivedExpectedDifference,
  deriveFrameworkMutationDifferences,
  type LedgerEntry,
  type LedgerOrigin,
  type LedgerSide,
  normalizeLedgerRecord,
} from '@git-migrator/core';
import type { LedgerWrite, MutationLike, OpenIntent, Tx } from './types.ts';

/** The ledger's `facet_key` for a record with none (repository-level operations). */
export const REPOSITORY_LEVEL_FACET = 'framework';

const json = (value: unknown): string | null =>
  value === undefined || value === null ? null : JSON.stringify(value);

export interface LedgerTarget {
  readonly migrationId: string;
  readonly routeId: string;
  readonly runId: string;
  /** The Step row that writes, so a resumed Step finds its open intents. */
  readonly stepId?: string | undefined;
}

type DifferenceKey = { readonly facetKey: string; readonly path: string };

/** Records the derived differences once; never again when an operator revoked one (ADR-0342). */
async function insertDifferences(
  tx: Tx,
  target: LedgerTarget,
  differences: readonly DerivedExpectedDifference[],
  now: Date,
): Promise<void> {
  for (const d of differences) {
    await tx.$executeRaw`
      INSERT INTO app.expected_difference
        (id, route_id, migration_id, facet_key, path, reason, note, updated_at)
      SELECT ${randomUUID()}, ${target.routeId}, ${target.migrationId}, ${d.facetKey}, ${d.path},
             'framework_mutation'::app.expected_difference_reason, ${d.note}, ${now}
      WHERE NOT EXISTS (
        SELECT 1 FROM app.expected_difference e
        WHERE e.migration_id = ${target.migrationId} AND e.facet_key = ${d.facetKey}
          AND e.path = ${d.path} AND e.reason = 'framework_mutation')
      ON CONFLICT DO NOTHING`;
  }
}

/**
 * Inserts the records in `tx`, marks the Run (`has_mutations`, which decides the cancelled outcome
 * of LIF-002) and records the derived Expected Differences. The caller holds the Run row lock.
 * `state` is `intended` for a record written before its provider call (ADR-0342). Returns the ids.
 */
export async function writeLedger(
  tx: Tx,
  target: LedgerTarget,
  write: LedgerWrite,
  records: readonly MutationLike[],
  now: Date,
  state: 'recorded' | 'intended' = 'recorded',
): Promise<readonly string[]> {
  if (records.length === 0) return [];
  const normalized = records.map((r) => normalizeLedgerRecord(r));
  const ids: string[] = [];
  const all: DerivedExpectedDifference[] = [];
  for (const record of normalized) {
    const id = randomUUID();
    ids.push(id);
    const entry: LedgerEntry = {
      side: write.side,
      origin: write.origin,
      record,
      ...(write.differences ? { differences: write.differences } : {}),
    };
    const derived = deriveFrameworkMutationDifferences([entry]);
    all.push(...derived);
    await tx.$executeRaw`
      INSERT INTO app.mutation
        (id, migration_id, run_id, side, facet_key, resource_ref, paths, action, before, after,
         state, written_by_step, origin, derived_differences, updated_at)
      VALUES
        (${id}, ${target.migrationId}, ${target.runId}, ${write.side},
         ${record.facetKey ?? REPOSITORY_LEVEL_FACET}, ${JSON.stringify(record.resourceRef)}::jsonb,
         ${[...record.paths]}::text[], ${record.action}, ${json(record.before)}::jsonb,
         ${json(record.after)}::jsonb, ${state}, ${target.stepId ?? null}, ${write.origin},
         ${JSON.stringify(derived.map((d) => ({ facetKey: d.facetKey, path: d.path })))}::jsonb,
         ${now})`;
  }
  await tx.$executeRaw`
    UPDATE app.run SET has_mutations = true, updated_at = ${now} WHERE id = ${target.runId}`;
  await insertDifferences(tx, target, all, now);
  return ids;
}

interface IntentRow {
  state: string;
  side: LedgerSide;
  origin: LedgerOrigin;
  derived_differences: DifferenceKey[];
}

/**
 * Settles an intent after the provider call (ADR-0342). Only an `intended` row can be settled; a
 * second confirm, or one for another Run's row, throws. `applied` keeps the row as a normal
 * record, optionally replaced by what really happened (its Expected Differences are derived
 * again); `not_applied` marks it so undo skips it and revokes the Expected Differences that only
 * this intent caused.
 */
export async function confirmLedger(
  tx: Tx,
  target: LedgerTarget,
  id: string,
  outcome: 'applied' | 'not_applied',
  actual: MutationLike | undefined,
  now: Date,
): Promise<void> {
  const rows = await tx.$queryRaw<IntentRow[]>`
    SELECT state, side, origin, derived_differences FROM app.mutation
    WHERE id = ${id} AND run_id = ${target.runId} FOR UPDATE`;
  const row = rows[0];
  if (!row || row.state !== 'intended') {
    throw new Error(`Mutation ${id} is not an open intent of Run ${target.runId}`);
  }
  if (outcome === 'not_applied') {
    await tx.$executeRaw`
      UPDATE app.mutation SET state = 'not_applied', updated_at = ${now} WHERE id = ${id}`;
    for (const key of row.derived_differences) {
      await tx.$executeRaw`
        UPDATE app.expected_difference e
        SET revoked_at = ${now}, updated_at = ${now}
        WHERE e.migration_id = ${target.migrationId} AND e.facet_key = ${key.facetKey}
          AND e.path = ${key.path} AND e.reason = 'framework_mutation'
          AND e.revoked_at IS NULL AND e.created_by_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM app.mutation m
            WHERE m.migration_id = ${target.migrationId} AND m.id <> ${id}
              AND m.state <> 'not_applied'
              AND m.derived_differences @> ${JSON.stringify([key])}::jsonb)`;
    }
    // A Run whose only records turned out not to have been applied recorded no Mutation (LIF-002).
    await tx.$executeRaw`
      UPDATE app.run
      SET has_mutations = EXISTS (
            SELECT 1 FROM app.mutation WHERE run_id = ${target.runId} AND state <> 'not_applied'),
          updated_at = ${now}
      WHERE id = ${target.runId}`;
    return;
  }
  if (!actual) {
    await tx.$executeRaw`
      UPDATE app.mutation SET state = 'recorded', updated_at = ${now} WHERE id = ${id}`;
    return;
  }
  const record = normalizeLedgerRecord(actual);
  const derived = deriveFrameworkMutationDifferences([
    {
      side: row.side,
      origin: row.origin,
      record,
      // A record with no Facet of its own keeps the paths the intent was written with.
      ...(record.facetKey === null && row.derived_differences.length > 0
        ? { differences: row.derived_differences }
        : {}),
    },
  ]);
  await tx.$executeRaw`
    UPDATE app.mutation
    SET state = 'recorded', resource_ref = ${JSON.stringify(record.resourceRef)}::jsonb,
        paths = ${[...record.paths]}::text[], action = ${record.action},
        before = ${json(record.before)}::jsonb, after = ${json(record.after)}::jsonb,
        derived_differences = ${JSON.stringify(
          derived.map((d) => ({ facetKey: d.facetKey, path: d.path })),
        )}::jsonb,
        updated_at = ${now}
    WHERE id = ${id}`;
  await insertDifferences(tx, target, derived, now);
}

/** The intents of a Step that were never confirmed: a resumed Step reconciles them (ADR-0342). */
export async function openIntentsOf(
  tx: Tx,
  runId: string,
  stepId: string,
): Promise<readonly OpenIntent[]> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      side: LedgerSide;
      facet_key: string;
      action: 'create' | 'update' | 'delete';
      resource_ref: Record<string, unknown>;
      paths: string[];
      before: unknown;
      after: unknown;
    }[]
  >`
    SELECT id, side, facet_key, action, resource_ref, paths, before, after FROM app.mutation
    WHERE run_id = ${runId} AND written_by_step = ${stepId} AND state = 'intended' ORDER BY seq`;
  return rows.map((r) => ({
    id: r.id,
    side: r.side,
    facetKey: r.facet_key === REPOSITORY_LEVEL_FACET ? null : r.facet_key,
    action: r.action,
    resourceRef: r.resource_ref,
    paths: r.paths,
    before: r.before,
    after: r.after,
  }));
}
