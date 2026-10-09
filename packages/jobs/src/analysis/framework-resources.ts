/**
 * LIF-045 source-side filtering by identity: the `resourceRef`s of what the framework created on, or
 * holds as the lock of, a Migration's source. A source read hands them to the adapter
 * (`FacetTarget.frameworkResources`), which leaves those resources out before it combines them into
 * the canonical document, so the Analysis, the Parity Check and the drift check all see the source
 * as it would be without the framework's own writes. While a lock write of the Migration is
 * unsettled (its intent is still open), what the source shows of the lock is not in the ledger yet:
 * `sourceLockView` then adds what appeared since the baseline, or withholds the Facets the lock
 * writes when that cannot be told. Decisions: docs/adr/0425-source-read-only-steps.md.
 */
import type { MutationRecord, RepositoryRef, SourceLock } from '@git-migrator/adapter-sdk';
import { canonicalize } from '@git-migrator/core';
import type { Db } from '@git-migrator/db';

type Ref = Readonly<Record<string, unknown>>;

/** `resourceRef.kind` of the inert umbrella intent written before every lock write. */
export const LOCK_INTENT_KIND = 'source-read-only';

/**
 * The canonical Facets the source lock writes (LIF-070: a push restriction on every branch, a
 * description prefix). While the lock's state is unknown they are not translated or compared.
 */
export const SOURCE_LOCK_FACETS: readonly string[] = ['branch-rules', 'repository-settings'];

/** The identity of a resource a record names: its `resourceRef` without the ownership flags. */
export function identityOf(ref: Ref): string {
  const { adopted: _a, possiblyFramework: _p, preexisting: _e, ...rest } = ref;
  return canonicalize(rest);
}

/**
 * A resource and the state it shows: what a baseline remembers, and what the ledger is matched by.
 * Canonical JSON (RFC 8785), so a record read back from the database (whose JSON keeps no key
 * order) gives the same key as the adapter's record.
 */
export function keyOf(record: { readonly resourceRef: Ref; readonly after: unknown }): string {
  return `${identityOf(record.resourceRef)}#${canonicalize(record.after ?? null)}`;
}

/** What a lock intent kept before its write (ADR-0425). */
export interface LockBaseline {
  /** `keyOf` every piece of lock-shaped state the source showed. */
  readonly keys: readonly string[];
  /** `SourceLock.originals` then: the resources the lock updates in place (`undefined`: none). */
  readonly originals: readonly MutationRecord[] | undefined;
}

/** The baseline an intent's `before` holds; `undefined` when it has none. */
export function parseBaseline(before: unknown): LockBaseline | undefined {
  const value = before as { baseline?: unknown; originals?: unknown } | null | undefined;
  if (!Array.isArray(value?.baseline)) return undefined;
  return {
    keys: value.baseline.map(String),
    originals: Array.isArray(value.originals) ? (value.originals as MutationRecord[]) : undefined,
  };
}

/** The lock intents of the Migration that were never confirmed, oldest first. */
export async function openLockIntents(
  db: Pick<Db, '$queryRaw'>,
  migrationId: string,
): Promise<{ id: string; runId: string; baseline: LockBaseline | undefined }[]> {
  const rows = await db.$queryRaw<{ id: string; run_id: string; before: unknown }[]>`
    SELECT id, run_id, before FROM app.mutation
    WHERE migration_id = ${migrationId} AND side = 'source' AND state = 'intended'
      AND resource_ref->>'kind' = ${LOCK_INTENT_KIND}
    ORDER BY seq`;
  return rows.map((r) => ({ id: r.id, runId: r.run_id, baseline: parseBaseline(r.before) }));
}

/** True while some lock write of the Migration was never confirmed (its outcome is unknown). */
export async function hasOpenLockIntent(
  db: Pick<Db, '$queryRaw'>,
  migrationId: string,
): Promise<boolean> {
  const rows = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app.mutation
    WHERE migration_id = ${migrationId} AND side = 'source' AND state = 'intended'
      AND resource_ref->>'kind' = ${LOCK_INTENT_KIND}`;
  return (rows[0]?.n ?? 0) > 0;
}

/**
 * Active (not undone) source-side records that name a resource: creates, the lock-shaped state the
 * framework adopted and records of a lock that may have been the framework's. Inert umbrella
 * intents, records that were not applied and adopted state tagged `preexisting` (the baseline
 * showed it before the framework touched the source: the customer's own, translated as before) name
 * nothing.
 */
export async function frameworkSourceResources(
  db: Pick<Db, 'mutation'>,
  migrationId: string,
): Promise<readonly Ref[]> {
  const rows = await db.mutation.findMany({
    where: { migrationId, side: 'source', undoneAt: null, state: { not: 'not_applied' } },
    orderBy: { seq: 'asc' },
    select: { resourceRef: true },
  });
  return rows
    .map((r) => r.resourceRef as Record<string, unknown> | null)
    .filter(
      (ref): ref is Record<string, unknown> =>
        ref !== null && ref.noop !== true && ref.preexisting !== true,
    );
}

/** How a source read must treat the framework's resources (see `sourceLockView`). */
export interface SourceLockView {
  /** For `FacetTarget.frameworkResources`. */
  readonly resources: readonly Ref[];
  /** Facets not to translate or compare: the lock's state on the source is unknown. */
  readonly withheld: readonly string[];
}

/**
 * The framework's resources on the source for a read (LIF-045). With no unsettled lock write, the
 * ledger's (`frameworkSourceResources`). With one, the lock may be on the source without a record:
 * what `inspect` shows of it that the earliest baseline did not is added (a lock that appeared after
 * the baseline is never translated; ownership is not claimed by this, the ledger is untouched). When
 * that cannot be told (no baseline, no `inspect`, or the source cannot be read), the Facets the lock
 * writes are withheld instead.
 */
export async function sourceLockView(
  db: Pick<Db, 'mutation' | '$queryRaw'>,
  migrationId: string,
  lock: SourceLock | undefined,
  ref: RepositoryRef,
  signal?: AbortSignal,
): Promise<SourceLockView> {
  const resources = await frameworkSourceResources(db, migrationId);
  const open = await openLockIntents(db, migrationId);
  if (open.length === 0) return { resources, withheld: [] };
  const baseline = open[0]?.baseline;
  if (!lock?.inspect || open.some((i) => i.baseline === undefined) || baseline === undefined) {
    return { resources, withheld: SOURCE_LOCK_FACETS };
  }
  let found: MutationRecord[];
  try {
    found = await lock.inspect(ref);
  } catch (error) {
    if (signal?.aborted) throw error;
    return { resources, withheld: SOURCE_LOCK_FACETS };
  }
  const before = new Set(baseline.keys);
  const appeared = found.filter((r) => !before.has(keyOf(r))).map((r) => r.resourceRef);
  return { resources: [...resources, ...appeared], withheld: [] };
}
