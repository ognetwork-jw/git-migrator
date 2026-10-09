/**
 * Source read-only (LIF-070): LIF-040 step 14 `source.read-only` of a migrate, run-anyway or resync
 * Run, and the Steps of the `source_read_only` and `undo_source_read_only` Run kinds. Every write
 * goes through the source adapter's `SourceLock` (provider HTTP client plus quota) and is ledgered
 * on the source side with origin `framework` (LIF-045): an umbrella intent before the call, the
 * adapter's records after it, a confirm last. Undo restores exactly the recorded `before` and marks
 * each Mutation undone as it goes. Decisions: docs/adr/0425-source-read-only-steps.md.
 */
import type { MutationRecord, RepositoryRef, SourceLock } from '@git-migrator/adapter-sdk';
import { mutationsToUndo, type RunKind } from '@git-migrator/core';
import {
  hasOpenLockIntent,
  identityOf,
  keyOf,
  LOCK_INTENT_KIND,
  type LockBaseline,
  openLockIntents as openLockIntentsOf,
  parseBaseline,
} from '../analysis/framework-resources.ts';
import { StepFailure } from '../run/errors.ts';
import { REPOSITORY_LEVEL_FACET } from '../run/ledger.ts';
import type {
  LedgerWrite,
  RunPlanner,
  StepDefinition,
  StepResult,
  StepSeverity,
} from '../run/types.ts';
import { partialMutationsOf } from './change-requests.ts';
import type { MigrationContext, MigrationServices } from './services.ts';

/** The Step key of LIF-040 step 14. */
export const SOURCE_READ_ONLY_STEP = 'source.read-only';
/** The Step key of an `undo_source_read_only` Run. */
export const UNDO_SOURCE_READ_ONLY_STEP = 'source.read-only.undo';

/**
 * The run-origin blocker of a Migration whose lock write is unsettled (LIF-049, ADR-0425): until a
 * `source_read_only` or `undo_source_read_only` Run settles it, no Run that writes the target starts.
 */
export const SOURCE_LOCK_UNSETTLED = 'branch-rules.source-lock-unsettled';

export { hasOpenLockIntent, keyOf };

/** Run kinds whose whole job is the source lock (LIF-070). */
export const SOURCE_LOCK_RUN_KINDS: readonly RunKind[] = [
  'source_read_only',
  'undo_source_read_only',
];

const SOURCE_WRITE: LedgerWrite = { side: 'source', origin: 'framework' };

/** Steps that do not count for "steps 1 to 12 all succeeded": the advisory ones and this one. */
const NOT_STEPS_1_TO_12: ReadonlySet<string> = new Set([
  'verify',
  SOURCE_READ_ONLY_STEP,
  'analysis.refresh',
]);

/**
 * The web URL of a target repository: its git remote without the `.git` suffix and without
 * credentials. Both supported provider families serve the repository page at that address, and the
 * adapter contract carries no separate web URL (ADR-0425).
 */
export function targetWebUrl(remoteUrl: string): string {
  const url = new URL(remoteUrl);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
  return url.toString();
}

interface LockWorld {
  readonly sourceEndpointId: string;
  readonly targetEndpointId: string;
  readonly sourceRef: RepositoryRef;
  readonly targetRef: RepositoryRef | undefined;
  readonly sourcePostAction: string;
}

/** What the lock Steps need; unlike `loadRunWorld` it needs no Analysis (the kinds have none). */
async function loadLockWorld(ctx: MigrationContext): Promise<LockWorld> {
  if (ctx.migration.scope !== 'repository' || ctx.migration.sourceRepositoryId === null) {
    throw new StepFailure('run.scope_unsupported', 'Only a repository Migration has a source lock');
  }
  const m = await ctx.services.db.migration.findUniqueOrThrow({
    where: { id: ctx.migration.id },
    include: {
      route: true,
      sourceRepository: { include: { namespace: true } },
      targetRepository: { include: { namespace: true } },
    },
  });
  const source = m.sourceRepository;
  if (!source) {
    throw new StepFailure('run.source_missing', 'The Migration has no source repository');
  }
  const target = m.targetRepository;
  return {
    sourceEndpointId: m.route.sourceEndpointId,
    targetEndpointId: m.route.targetEndpointId,
    sourceRef: {
      providerId: source.providerId,
      namespace: { providerId: source.namespace.providerId, slug: source.namespace.slug },
      slug: source.slug,
    },
    targetRef: target
      ? {
          providerId: target.providerId,
          namespace: { providerId: target.namespace.providerId, slug: target.namespace.slug },
          slug: target.slug,
        }
      : undefined,
    sourcePostAction: m.route.sourcePostAction,
  };
}

async function connectSource(ctx: MigrationContext, world: LockWorld) {
  const connection = await ctx.services.connector.connect(world.sourceEndpointId, {
    pool: 'interactive',
    signal: ctx.signal,
  });
  const lock: SourceLock | undefined = connection.sourceLock;
  if (!lock) {
    throw new StepFailure(
      'source-read-only.unsupported',
      'The source provider cannot be made read-only by this tool',
    );
  }
  return { connection, lock };
}

/** Step 14's conditions beyond the Route and the option (LIF-040): `undefined` when all hold. */
async function whyNotYet(ctx: MigrationContext): Promise<string | undefined> {
  const { db } = ctx.services;
  const steps = await db.runStep.findMany({
    where: { runId: ctx.run.id },
    select: { stepKey: true, status: true, startedAt: true },
  });
  const unfinished = steps.filter(
    (s) => !NOT_STEPS_1_TO_12.has(s.stepKey) && s.status !== 'succeeded' && s.status !== 'skipped',
  );
  if (unfinished.length > 0) {
    return `steps 1 to 12 did not all succeed (${unfinished.map((s) => s.stepKey).join(', ')})`;
  }
  const verify = steps.find((s) => s.stepKey === 'verify');
  if (!verify || verify.status !== 'succeeded') return 'the Parity Check did not complete';
  const parity = await db.parityResult.findFirst({
    where: { migrationId: ctx.migration.id, facetKey: 'git-refs' },
    orderBy: { checkedAt: 'desc' },
    select: { status: true, checkedAt: true },
  });
  if (!parity || (verify.startedAt && parity.checkedAt < verify.startedAt)) {
    return 'there is no current git-refs parity result';
  }
  if (parity.status !== 'equal') return `git-refs parity is ${parity.status}, not equal`;
  return undefined;
}

/**
 * Keys of the active records the ledger holds as the framework's own writes on the source: the ones
 * undo would revert. Inert umbrellas, and state the framework only found there (adopted, including
 * `preexisting`), are not the framework's, so they never hide a later write of the same state.
 */
async function ledgeredKeys(ctx: MigrationContext): Promise<Set<string>> {
  const rows = await ctx.services.db.mutation.findMany({
    where: {
      migrationId: ctx.migration.id,
      side: 'source',
      undoneAt: null,
      state: { not: 'not_applied' },
    },
    select: { resourceRef: true, after: true },
  });
  return new Set(
    rows
      .filter((r) => {
        const ref = r.resourceRef as Record<string, unknown>;
        return ref.noop !== true && ref.adopted !== true && ref.preexisting !== true;
      })
      .map((r) => keyOf({ resourceRef: r.resourceRef as Record<string, unknown>, after: r.after })),
  );
}

/**
 * What the source shows before a write: the keys of its lock-shaped state and the originals of what
 * the lock updates in place. `undefined` when the provider cannot be inspected.
 */
async function baselineOf(
  lock: SourceLock,
  ref: RepositoryRef,
): Promise<{ baseline: string[]; originals?: MutationRecord[] } | undefined> {
  if (!lock.inspect) return undefined;
  const baseline = (await lock.inspect(ref)).map(keyOf);
  return lock.originals ? { baseline, originals: await lock.originals(ref) } : { baseline };
}

interface LockIntent {
  readonly id: string;
  /** What the source showed before the write (`undefined`: no baseline was taken). */
  readonly baseline: LockBaseline | undefined;
  /** Written by this Step (settled through the ledger) or by an earlier Run (settled directly). */
  readonly own: boolean;
}

/** The unconfirmed lock intents of the Migration: this Step's, and those an earlier Run left. */
async function openLockIntents(ctx: MigrationContext): Promise<LockIntent[]> {
  const mine = await ctx.ledger.openIntents();
  const out: LockIntent[] = mine
    .filter((i) => i.resourceRef.kind === LOCK_INTENT_KIND)
    .map((i) => ({ id: i.id, baseline: parseBaseline(i.before), own: true }));
  for (const f of await openLockIntentsOf(ctx.services.db, ctx.migration.id)) {
    if (f.runId !== ctx.run.id) out.push({ id: f.id, baseline: f.baseline, own: false });
  }
  return out;
}

async function settleIntent(
  ctx: MigrationContext,
  intent: LockIntent,
  outcome: 'applied' | 'not_applied',
): Promise<void> {
  if (intent.own) {
    await ctx.ledger.confirm(intent.id, outcome);
    return;
  }
  // An intent of an earlier Run cannot be confirmed through this Step's ledger; it is inert.
  await ctx.transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE app.mutation
      SET state = ${outcome === 'applied' ? 'recorded' : 'not_applied'}, updated_at = clock_timestamp()
      WHERE id = ${intent.id} AND state = 'intended'`;
  });
}

const BY_HAND =
  'Inspect the source repository by hand: remove a push restriction on every branch and a migration prefix on the description if they are not yours';

/**
 * Records, as NON-inert records flagged `possiblyFramework`, the lock-shaped state that appeared on
 * the source AFTER the baseline and that the ledger does not name, so `undo_source_read_only` can
 * remove it. State that was already there (in the baseline) is never claimed: ownership is never
 * inferred (ADR-0222). A resource updated in place is recorded only with the original the baseline
 * kept (the adapter sets `before` from it, never from what the source shows now); without one it is
 * left unrecorded and counted as `unrecoverable`, for an inspection by hand.
 */
async function recordAppeared(
  ctx: MigrationContext,
  lock: SourceLock,
  ref: RepositoryRef,
  baseline: LockBaseline,
): Promise<{ found: number; recorded: number; unrecoverable: number }> {
  if (!lock.inspect) return { found: 0, recorded: 0, unrecoverable: 0 };
  const found = await lock.inspect(
    ref,
    baseline.originals === undefined ? {} : { originals: baseline.originals },
  );
  const before = new Set(baseline.keys);
  const known = await ledgeredKeys(ctx);
  const appeared = found.filter((r) => !before.has(keyOf(r)) && !known.has(keyOf(r)));
  const undoable = (r: MutationRecord) => r.action !== 'update' || r.before != null;
  const fresh = appeared
    .filter(undoable)
    .map((r) => ({ ...r, resourceRef: { ...r.resourceRef, possiblyFramework: true } }));
  await ctx.ledger.record(SOURCE_WRITE, fresh);
  return {
    found: found.length,
    recorded: fresh.length,
    unrecoverable: appeared.length - fresh.length,
  };
}

/** The message part about appeared state that could not be recorded (no original to restore). */
const unrecoverableText = (n: number): string =>
  n > 0
    ? ` ${n} change(s) could not be recorded because the baseline holds no original to restore. ${BY_HAND}.`
    : '';

/**
 * Settles the lock intents left open (the worker died between the adapter's write and its
 * records, or a write could not be confirmed). With a baseline, what appeared since is recorded as
 * undoable (`recordAppeared`) and the Step fails for a check when it recorded anything. Without a
 * baseline, or on a provider that cannot be inspected, nothing is recorded and the Step fails for
 * an operator to inspect by hand. If the source cannot be read, the intents stay OPEN (the error
 * propagates and the next attempt looks again). With `failWhenRecorded` false (undo), recording is
 * the point and no failure follows.
 */
async function settleOpenLocks(
  ctx: MigrationContext,
  world: LockWorld,
  lock: SourceLock,
  failWhenRecorded: boolean,
): Promise<void> {
  const open = await openLockIntents(ctx);
  if (open.length === 0) return;
  const baseline = open[0]?.baseline;
  if (!lock.inspect || baseline === undefined || open.some((i) => i.baseline === undefined)) {
    // Do not claim anything that cannot be told from the customer's own state.
    for (const intent of open) await settleIntent(ctx, intent, 'applied');
    await ctx.findings.clearBlockers([SOURCE_LOCK_UNSETTLED]);
    if (!failWhenRecorded) return;
    throw new StepFailure(
      'source-read-only.needs-manual-check',
      `A previous attempt may have changed the source, and there is no baseline to tell its changes from the existing state, so nothing was recorded. ${BY_HAND}`,
    );
  }
  // The earliest baseline is the state before any of the attempts wrote.
  const { found, recorded, unrecoverable } = await recordAppeared(
    ctx,
    lock,
    world.sourceRef,
    baseline,
  );
  for (const intent of open)
    await settleIntent(ctx, intent, found === 0 ? 'not_applied' : 'applied');
  // Settled: the ledger names what can be named, so target-writing Runs may start again.
  await ctx.findings.clearBlockers([SOURCE_LOCK_UNSETTLED]);
  // Undo's read-back reports what is left; a lock attempt stops for a check.
  if (failWhenRecorded && (recorded > 0 || unrecoverable > 0)) {
    throw new StepFailure(
      'source-read-only.needs-manual-check',
      `A previous attempt changed the source before it was recorded. What appeared since and can be undone (${recorded}) is recorded, and an undo_source_read_only Run will remove it.${unrecoverableText(unrecoverable)} Check the source repository`,
      { recorded, unrecoverable },
    );
  }
}

/**
 * Runs `fn`; when it throws and a lock write of the Migration is left unsettled, raises the
 * run-origin blocker `SOURCE_LOCK_UNSETTLED` first, so no Run that writes the target starts while
 * the source may hold a lock the ledger does not name (LIF-045, LIF-049, ADR-0425).
 */
async function whileUnsettled<T>(ctx: MigrationContext, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    try {
      if (await hasOpenLockIntent(ctx.services.db, ctx.migration.id)) {
        await ctx.findings.addBlocker({ code: SOURCE_LOCK_UNSETTLED, params: {} });
      }
    } catch (raise) {
      ctx.log.warn({ err: raise }, 'could not raise the unsettled source lock blocker');
    }
    throw error;
  }
}

/** Applies the lock to the source and ledgers every record (LIF-070, LIF-045). */
async function applyLock(ctx: MigrationContext, world: LockWorld): Promise<StepResult> {
  if (!world.targetRef) {
    throw new StepFailure(
      'source-read-only.target_missing',
      'The Migration has no target repository, so there is nothing to point the source to',
    );
  }
  const { lock } = await connectSource(ctx, world);
  await settleOpenLocks(ctx, world, lock, true);
  const targetConnection = await ctx.services.connector.connect(world.targetEndpointId, {
    pool: 'interactive',
    signal: ctx.signal,
  });
  const url = targetWebUrl(targetConnection.git.remoteUrl(world.targetRef));
  ctx.checkpoint();
  // The baseline comes BEFORE the intent and any write: a crash later can then claim only what
  // appeared after it. If the source cannot be inspected now, nothing has been written yet.
  const taken = await baselineOf(lock, world.sourceRef);
  const baseline = taken === undefined ? undefined : parseBaseline(taken);
  const intentId = await ctx.ledger.intend(SOURCE_WRITE, {
    facetKey: null,
    action: 'update',
    resourceRef: { kind: LOCK_INTENT_KIND, noop: true },
    paths: [],
    before: taken ?? null,
    after: null,
  });
  // State the adapter only found, that the baseline already showed and that the ledger does not
  // hold as the framework's own write, is the customer's: its record is tagged `preexisting`, so
  // it is not left out of translation (ADR-0425, round 4).
  const ours = await ledgeredKeys(ctx);
  const tagged = (list: MutationRecord[]): MutationRecord[] => {
    const before = new Set(baseline?.keys ?? []);
    return list.map((r) =>
      r.resourceRef.adopted === true && before.has(keyOf(r)) && !ours.has(keyOf(r))
        ? { ...r, resourceRef: { ...r.resourceRef, preexisting: true } }
        : r,
    );
  };
  let records: MutationRecord[];
  try {
    records = tagged(
      await lock.apply(world.sourceRef, {
        targetWebUrl: url,
        ...(baseline?.originals === undefined ? {} : { originals: baseline.originals }),
      }),
    );
  } catch (error) {
    // What the adapter did before it failed is real: ledger it, then fail (ADP-011, ADR-0222).
    const partial = tagged(partialMutationsOf(error));
    await ctx.ledger.record(SOURCE_WRITE, partial);
    const unconfirmed = (error as { possiblyApplied?: unknown } | null)?.possiblyApplied;
    if (Array.isArray(unconfirmed) && unconfirmed.length > 0) {
      const failure = (recorded: number, text: string) =>
        new StepFailure('source-read-only.possibly-applied', text, {
          unconfirmed: unconfirmed.map(String),
          recorded,
        });
      if (baseline === undefined) {
        await ctx.ledger.confirm(intentId, 'applied');
        throw failure(
          0,
          `A write to the source may have been applied, and there is no baseline to tell it from the existing state, so nothing was recorded. ${BY_HAND}`,
        );
      }
      // Look again, against the baseline. If the source cannot be read now, the intent stays
      // open: the next attempt (or the next lock Run) settles it from the same baseline.
      let outcome: { recorded: number; unrecoverable: number };
      try {
        outcome = await recordAppeared(ctx, lock, world.sourceRef, baseline);
      } catch (inspectError) {
        await ctx.runLog('warn', 'The source lock could not be confirmed or inspected', {});
        throw inspectError;
      }
      await ctx.ledger.confirm(intentId, 'applied');
      throw failure(
        outcome.recorded,
        `A write to the source may have been applied, but it could not be confirmed. What appeared since the baseline and can be undone (${outcome.recorded}) is recorded, and an undo_source_read_only Run will remove it.${unrecoverableText(outcome.unrecoverable)} Check the source repository`,
      );
    }
    await ctx.ledger.confirm(intentId, partial.length > 0 ? 'applied' : 'not_applied');
    throw error;
  }
  await ctx.ledger.record(SOURCE_WRITE, records);
  await ctx.ledger.confirm(intentId, 'applied');
  return { status: 'succeeded', detail: { records: records.length } };
}

/**
 * Step 14 of the migration kinds, and the one Step of a `source_read_only` Run. In a migration Run
 * it applies only when the Route asks for it, the Run option `skipSourceReadOnly` is unset, steps 1
 * to 12 succeeded and `git-refs` parity is `equal` (LIF-070); a standalone Run is the operator's
 * explicit request and has none of those conditions.
 */
export function sourceReadOnlyStep(
  mode: 'migration' | 'standalone',
  severity: StepSeverity = 'independent',
): StepDefinition<MigrationServices> {
  return {
    key: SOURCE_READ_ONLY_STEP,
    severity,
    clearsBlockers: [SOURCE_LOCK_UNSETTLED],
    async run(ctx): Promise<StepResult> {
      const world = await loadLockWorld(ctx);
      if (mode === 'migration') {
        if (world.sourcePostAction !== 'read-only') {
          return { status: 'skipped', reason: 'the Route leaves the source writable' };
        }
        if (ctx.run.options.skipSourceReadOnly === true) {
          return { status: 'skipped', reason: 'skipSourceReadOnly is set' };
        }
        if (ctx.migration.sourceReadOnlyApplied) {
          return { status: 'skipped', reason: 'the source is already read-only' };
        }
        const why = await whyNotYet(ctx);
        if (why !== undefined) {
          await ctx.runLog('warn', `The source is left writable: ${why}`, {});
          return { status: 'skipped', reason: why };
        }
      }
      const result = await whileUnsettled(ctx, () => applyLock(ctx, world));
      if (mode === 'migration') {
        // The lifecycle sets the flag for a `source_read_only` Run when it ends; a migration Run
        // ends `migrated`, so the Step records it itself.
        await ctx.transaction(
          (tx) =>
            tx.migration.update({
              where: { id: ctx.migration.id },
              data: { sourceReadOnlyApplied: true },
            }),
          { migration: true },
        );
      }
      return result;
    },
  };
}

/** Reverts the framework's active source Mutations, newest first (LIF-070, LIF-045). */
export function undoSourceReadOnlyStep(): StepDefinition<MigrationServices> {
  return {
    key: UNDO_SOURCE_READ_ONLY_STEP,
    severity: 'fatal',
    clearsBlockers: [SOURCE_LOCK_UNSETTLED],
    async run(ctx): Promise<StepResult> {
      const world = await loadLockWorld(ctx);
      // A lock written but never confirmed is recorded against its baseline first, so undo reaches it.
      if (await hasOpenLockIntent(ctx.services.db, ctx.migration.id)) {
        const { lock: first } = await connectSource(ctx, world);
        await whileUnsettled(ctx, () => settleOpenLocks(ctx, world, first, false));
      }
      const rows = await ctx.services.db.mutation.findMany({
        where: { migrationId: ctx.migration.id, side: 'source' },
        orderBy: { seq: 'asc' },
      });
      const todo = mutationsToUndo(
        rows.map((r) => ({ ...r, resourceRef: r.resourceRef as Record<string, unknown> })),
      );
      if (todo.length === 0 && !ctx.migration.sourceReadOnlyApplied) {
        return { status: 'succeeded', detail: { undone: 0 } };
      }
      const { lock } = await connectSource(ctx, world);
      let undone = 0;
      for (const row of todo) {
        ctx.checkpoint();
        const record: MutationRecord = {
          facetKey: row.facetKey === REPOSITORY_LEVEL_FACET ? null : row.facetKey,
          action: row.action as MutationRecord['action'],
          resourceRef: row.resourceRef as Record<string, unknown>,
          paths: row.paths,
          before: row.before,
          after: row.after,
        };
        // One at a time, each marked as soon as it is reverted: a crash repeats at most one
        // revert, and the adapter's undo tolerates state that is already gone.
        await lock.undo(world.sourceRef, [record]);
        await ctx.transaction(async (tx) => {
          await tx.$executeRaw`
            UPDATE app.mutation SET undone_at = clock_timestamp(), updated_at = clock_timestamp()
            WHERE id = ${row.id} AND undone_at IS NULL`;
        });
        undone += 1;
      }
      // The flag is cleared (by the lifecycle, when this Run succeeds) only if a read-back shows no
      // lock left. State the framework only found there (adopted) is not ours to remove and does
      // not count; anything else means the source is still locked by us, or by something unknown.
      if (lock.inspect) {
        // Matched by the state it showed, not by identity alone: an adopted description hides only
        // its own text. The ledger keeps an adopted record's image in `after` (`before` and `after`
        // are the same for inert records); one that kept no image is matched by identity, which
        // names a single resource (a restriction id).
        const adopted = rows
          .filter(
            (r) =>
              r.state !== 'not_applied' &&
              (r.resourceRef as Record<string, unknown>).adopted === true,
          )
          .map((r) => ({
            identity: identityOf(r.resourceRef as Record<string, unknown>),
            key:
              r.after == null
                ? undefined
                : keyOf({ resourceRef: r.resourceRef as Record<string, unknown>, after: r.after }),
          }));
        const isAdopted = (r: MutationRecord): boolean =>
          adopted.some((a) =>
            a.key === undefined ? a.identity === identityOf(r.resourceRef) : a.key === keyOf(r),
          );
        // A description the undo restored (it may itself carry a prefix) is the original, not a lock.
        const restored = new Set(
          todo.filter((r) => r.action === 'update').map((r) => JSON.stringify(r.before ?? null)),
        );
        const remaining = (await lock.inspect(world.sourceRef)).filter(
          (r) =>
            !isAdopted(r) &&
            !(r.action === 'update' && restored.has(JSON.stringify(r.after ?? null))),
        );
        if (remaining.length > 0) {
          throw new StepFailure(
            'source-read-only.undo_incomplete',
            'The source still shows state of the read-only lock after undo, so it stays marked read-only. Check the source repository',
            { remaining: remaining.map((r) => String(r.resourceRef.type ?? 'unknown')) },
          );
        }
      }
      return { status: 'succeeded', detail: { undone } };
    },
  };
}

/** The planner of the `source_read_only` and `undo_source_read_only` kinds: one Step each. */
export function createSourceLockPlanner(
  kind: 'source_read_only' | 'undo_source_read_only',
): RunPlanner<MigrationServices> {
  return {
    steps: () => [
      kind === 'source_read_only'
        ? sourceReadOnlyStep('standalone', 'fatal')
        : undoSourceReadOnlyStep(),
    ],
  };
}
