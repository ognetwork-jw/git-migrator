/**
 * Mutation ledger rules (LIF-045, ADP-012) and Expected Difference derivation. Pure: the Run
 * executor persists, this module decides. Decisions: docs/adr/0342-mutation-ledger.md.
 */
import { canonicalize } from './jcs.ts';

/** The fields of an adapter `MutationRecord` the rules need (structural: core never imports adapters). */
export interface LedgerRecord {
  /** `null` for repository-level operations. */
  readonly facetKey: string | null;
  readonly action: 'create' | 'update' | 'delete';
  readonly resourceRef: Readonly<Record<string, unknown>>;
  readonly paths: readonly string[];
  readonly before: unknown;
  readonly after: unknown;
}

export type LedgerSide = 'source' | 'target';

/**
 * Where a write belongs relative to the desired target document.
 * - `desired`: part of it (a Facet `apply`), so parity compares it and no Expected Difference is needed.
 * - `framework`: a resource the desired document does not contain (a `git-migrator/*` branch, a
 *   framework Change Request). Parity must not report it as a difference (LIF-045 target-side).
 */
export type LedgerOrigin = 'desired' | 'framework';

/** True for a record of state the Run did not change: adopted, or a write that changed nothing. */
export function isInertRecord(record: Pick<LedgerRecord, 'resourceRef'>): boolean {
  return record.resourceRef.adopted === true || record.resourceRef.noop === true;
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalize(a ?? null) === canonicalize(b ?? null);
}

/**
 * Adopted and no-op records describe state the Run did not change, so `before` equals `after`
 * (LIF-045). An adapter that sends them unequal is corrected here, so undo can never revert state
 * that existed before the Run: the `after` image is replaced by the `before` image.
 */
export function normalizeLedgerRecord<R extends LedgerRecord>(record: R): R {
  if (!isInertRecord(record)) return record;
  if (sameJson(record.before, record.after)) return record;
  return { ...record, after: record.before };
}

/** `intended` is written before the provider call; `recorded` and `not_applied` after it (ADR-0342). */
export type MutationState = 'intended' | 'recorded' | 'not_applied';

export interface StoredMutation {
  readonly resourceRef: Readonly<Record<string, unknown>>;
  readonly undoneAt: Date | null;
  /** Absent means `recorded`. */
  readonly state?: MutationState | string;
  /** Recording order (`Mutation.seq`); `bigint` as read from the database. */
  readonly seq?: bigint | number;
}

/** An intent whose outcome was never confirmed: the change may exist on the provider. */
export function isPossiblyApplied(mutation: Pick<StoredMutation, 'state'>): boolean {
  return mutation.state === 'intended';
}

/**
 * A record undo may revert: not already undone, neither adopted nor a no-op (LIF-045), and not
 * known to have failed. An unconfirmed intent counts: it may have been applied (ADR-0342).
 */
export function isUndoable(mutation: StoredMutation): boolean {
  return mutation.undoneAt === null && !isInertRecord(mutation) && mutation.state !== 'not_applied';
}

/**
 * The Mutations a rollback or `undo_source_read_only` reverts, newest first, ordered by `seq` when
 * the records carry it (otherwise `recorded` must already be oldest first). Undo of an entry for
 * which `isPossiblyApplied` holds must tolerate that the change is not there.
 */
export function mutationsToUndo<M extends StoredMutation>(recorded: readonly M[]): M[] {
  const ordered = recorded.every((m) => m.seq !== undefined)
    ? [...recorded].sort((a, b) => (BigInt(a.seq ?? 0) < BigInt(b.seq ?? 0) ? -1 : 1))
    : [...recorded];
  return ordered.filter(isUndoable).reverse();
}

/** Source-side Mutations the Analysis removes before translating (LIF-045, ADR-0310). */
export function isFilteredSourceMutation(
  mutation: StoredMutation & { readonly side: string; readonly action: string },
): boolean {
  return mutation.side === 'source' && mutation.action === 'create' && isUndoable(mutation);
}

export interface DerivedExpectedDifference {
  readonly facetKey: string;
  readonly path: string;
  readonly reason: 'framework_mutation';
  readonly note: string;
}

export interface LedgerEntry {
  readonly side: LedgerSide;
  readonly origin: LedgerOrigin;
  readonly record: LedgerRecord;
  /**
   * Explicit paths for records whose own `facetKey` is `null` (repository-level operations such as
   * a Change Request), or whose canonical paths differ from the parity paths.
   */
  readonly differences?: readonly { readonly facetKey: string; readonly path: string }[];
}

/**
 * `framework_mutation` Expected Differences of ledger entries (LIF-045 target-side, LIF-063).
 * Only a target write the desired document does not contain makes one, and only when it left
 * something behind: adopted and no-op records, and deletions, add nothing. Unique by (facetKey, path).
 */
export function deriveFrameworkMutationDifferences(
  entries: readonly LedgerEntry[],
): DerivedExpectedDifference[] {
  const out = new Map<string, DerivedExpectedDifference>();
  for (const entry of entries) {
    if (entry.side !== 'target' || entry.origin !== 'framework') continue;
    if (isInertRecord(entry.record) || entry.record.action === 'delete') continue;
    const facetKey = entry.record.facetKey;
    const targets =
      entry.differences ??
      (facetKey === null ? [] : entry.record.paths.map((path) => ({ facetKey, path })));
    for (const target of targets) {
      out.set(JSON.stringify([target.facetKey, target.path]), {
        facetKey: target.facetKey,
        path: target.path,
        reason: 'framework_mutation',
        note: 'Created by git-migrator, not part of the source configuration',
      });
    }
  }
  return [...out.values()];
}
