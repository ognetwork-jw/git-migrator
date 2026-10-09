import { AdapterError, type MutationRecord, type SourceLock } from '@git-migrator/adapter-sdk';
import { mutationsToUndo, type RunKind } from '@git-migrator/core';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  frameworkSourceResources,
  SOURCE_LOCK_FACETS,
  sourceLockView,
} from '../analysis/framework-resources.ts';
import { createRun } from '../run/guard.ts';
import { Harness, silentLog } from '../run/harness.fixture.ts';
import { RunStepRegistry, type StepDefinition } from '../run/types.ts';
import type { BasicWorld } from '../world.fixture.ts';
import { refreshAnalysisStep } from './plan.ts';
import type { MigrationServices } from './services.ts';
import {
  createSourceLockPlanner,
  hasOpenLockIntent,
  keyOf,
  SOURCE_LOCK_UNSETTLED,
  sourceReadOnlyStep,
  targetWebUrl,
} from './source-read-only.ts';

vi.setConfig({ testTimeout: 30_000 });

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t073_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

const RESTRICTION: MutationRecord = {
  facetKey: 'branch-rules',
  action: 'create',
  resourceRef: { type: 'branch-restriction', repository: 'r', id: 7 },
  paths: ['/rules[pattern=**]'],
  before: null,
  after: { kind: 'push', pattern: '*', users: [], groups: [] },
};
const DESCRIPTION: MutationRecord = {
  facetKey: 'repository-settings',
  action: 'update',
  resourceRef: { type: 'repository-description', repository: 'r' },
  paths: ['/description'],
  before: { description: 'Hello' },
  after: { description: '[MIGRATED → https://git.test/acme/r] Hello' },
};

const SOURCE_REF = { providerId: 'src', namespace: { providerId: 'ns', slug: 'ws' }, slug: 'r' };

/** What `originals` reads before the write: the description as it was. */
const ORIGINAL: MutationRecord = {
  facetKey: 'repository-settings',
  action: 'update',
  resourceRef: { type: 'repository-description', repository: 'r' },
  paths: ['/description'],
  before: null,
  after: { description: 'Hello' },
};

interface Stub {
  readonly applyCalls: { targetWebUrl: string; originals?: readonly MutationRecord[] }[];
  /** What `SourceLock.originals` reads (the description before any write). */
  originals: MutationRecord[];
  /** The `originals` each `inspect` call was given. */
  readonly inspectOriginals: (readonly MutationRecord[] | undefined)[];
  readonly undoCalls: MutationRecord[][];
  apply: (() => Promise<MutationRecord[]>) | undefined;
  /** What `SourceLock.inspect` finds on the source. */
  inspected: MutationRecord[];
  /** Answers for the next `inspect` calls, in order; an Error is thrown. Then `inspected`. */
  inspectScript: (MutationRecord[] | Error)[];
  inspectCalls: number;
}

function stub(): Stub {
  return {
    applyCalls: [],
    originals: [ORIGINAL],
    inspectOriginals: [],
    undoCalls: [],
    apply: undefined,
    inspected: [],
    inspectScript: [],
    inspectCalls: 0,
  };
}

function services(
  h: Harness,
  s: Stub,
  lock: boolean = true,
  inspectable: boolean = true,
): MigrationServices {
  const sourceLock: SourceLock = {
    apply: async (_ref, ctx) => {
      s.applyCalls.push(ctx);
      return s.apply ? s.apply() : [RESTRICTION, DESCRIPTION];
    },
    undo: async (_ref, mutations) => {
      s.undoCalls.push(mutations);
      return mutations;
    },
    ...(inspectable
      ? {
          originals: async () => s.originals,
          inspect: async (_ref, options) => {
            s.inspectCalls += 1;
            s.inspectOriginals.push(options?.originals);
            const next = s.inspectScript.shift();
            if (next instanceof Error) throw next;
            return next ?? s.inspected;
          },
        }
      : {}),
  };
  return {
    db: h.db,
    logger: silentLog,
    connector: {
      async connect(endpointId: string) {
        if (endpointId.startsWith('src-')) {
          return {
            ...(lock ? { sourceLock } : {}),
            http: {},
          };
        }
        return { git: { remoteUrl: () => 'https://x:secret@git.test/acme/r.git' } };
      },
    },
  } as never;
}

type Seeded = BasicWorld & { readonly runId: string; readonly world: BasicWorld };

async function seed(h: Harness, withTarget = true): Promise<Seeded> {
  const queued = await h.queuedRun('migrate');
  const { world } = queued;
  if (withTarget) {
    const ns = await h.db.namespace.create({
      data: {
        endpointId: world.targetEndpointId,
        providerId: 'tns',
        kind: 'org',
        slug: 'acme',
        name: 'acme',
      },
    });
    const repo = await h.db.repository.create({
      data: {
        endpointId: world.targetEndpointId,
        namespaceId: ns.id,
        providerId: 'trepo',
        slug: 'r',
        name: 'r',
        fullPath: 'acme/r',
        isPrivate: true,
        lastInventoriedAt: new Date(),
      },
    });
    await h.db.migration.update({
      where: { id: world.migrationId },
      data: { targetRepositoryId: repo.id },
    });
  }
  return { ...world, runId: queued.runId, world };
}

const stepDef = (
  key: string,
  run: StepDefinition<MigrationServices>['run'] = async () => ({ status: 'succeeded' }),
  severity: StepDefinition<MigrationServices>['severity'] = 'independent',
): StepDefinition<MigrationServices> => ({ key, severity, run });

/** Runs a migrate Run of `steps` (the real step 14 last) and returns the step statuses. */
async function migrateRun(
  h: Harness,
  s: Stub,
  steps: readonly StepDefinition<MigrationServices>[],
  options: {
    skip?: boolean;
    sourceReadOnlyApplied?: boolean;
    routeAction?: 'read-only' | 'none';
  } = {},
) {
  const world = await seed(h);
  await h.db.route.update({
    where: { id: world.routeId },
    data: { sourcePostAction: options.routeAction ?? 'read-only' },
  });
  if (options.sourceReadOnlyApplied) {
    await h.db.migration.update({
      where: { id: world.migrationId },
      data: { sourceReadOnlyApplied: true },
    });
  }
  if (options.skip) {
    await h.db.run.update({
      where: { id: world.runId },
      data: { options: { skipSourceReadOnly: true } },
    });
  }
  const registry = new RunStepRegistry<MigrationServices>();
  registry.register('migrate', { steps: () => steps });
  const result = await h.execute(
    world.runId,
    {},
    {
      registry: registry as never,
      services: services(h, s) as never,
    },
  );
  return { world, result, statuses: await h.stepStatuses(world.runId) };
}

const setParity = (h: Harness, migrationId: string, status: string) =>
  h.db.parityResult.create({
    data: {
      migrationId,
      facetKey: 'git-refs',
      status,
      diffs: [],
      excluded: [],
      checkedAt: new Date(),
    },
  });

/** A `verify` stand-in that stores the git-refs parity result the way the real Step does. */
const verifyStep = (status: string, migrationOf: () => string, h: Harness) =>
  stepDef(
    'verify',
    async () => {
      await setParity(h, migrationOf(), status);
      return { status: 'succeeded' };
    },
    'advisory',
  );

describe('[LIF-070] Step 14 conditions', () => {
  it('[LIF-070] locks the source when steps 1 to 12 succeeded and git-refs parity is equal, and records the Mutations on the source side', async () => {
    const h = new Harness(t);
    const s = stub();
    let migrationId = '';
    const { world, result, statuses } = await migrateRun(h, s, [
      stepDef('git.push-refs'),
      stepDef('probe', async (ctx) => {
        migrationId = ctx.migration.id;
        return { status: 'succeeded' };
      }),
      verifyStep('equal', () => migrationId, h),
      sourceReadOnlyStep('migration'),
    ]);
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(statuses['source.read-only']).toBe('succeeded');
    // The target web URL has no credentials and no .git suffix.
    // The originals of the baseline go with the write, so it is made over exactly them.
    expect(s.applyCalls).toEqual([
      { targetWebUrl: 'https://git.test/acme/r', originals: [ORIGINAL] },
    ]);
    const rows = await h.db.mutation.findMany({
      where: { runId: world.runId },
      orderBy: { seq: 'asc' },
    });
    // The umbrella (inert) and the adapter's two records, all on the source side, origin framework.
    expect(rows.map((r) => [r.side, r.origin, r.state])).toEqual([
      ['source', 'framework', 'recorded'],
      ['source', 'framework', 'recorded'],
      ['source', 'framework', 'recorded'],
    ]);
    expect(rows.map((r) => r.facetKey)).toEqual([
      'framework',
      'branch-rules',
      'repository-settings',
    ]);
    // A source write never makes a target Expected Difference.
    expect(await h.db.expectedDifference.count({ where: { migrationId: world.migrationId } })).toBe(
      0,
    );
    expect((await h.migration(world.migrationId)).sourceReadOnlyApplied).toBe(true);
    // Rollback would revert the two real records, newest first, and not the umbrella.
    const undoable = mutationsToUndo(
      rows.map((r) => ({ ...r, resourceRef: r.resourceRef as Record<string, unknown> })),
    );
    expect(undoable.map((r) => r.facetKey)).toEqual(['repository-settings', 'branch-rules']);
  });

  it('[LIF-070] is skipped when the Run option skipSourceReadOnly is set, the Route leaves the source writable, or the source is already locked', async () => {
    for (const variant of [
      { skip: true },
      { routeAction: 'none' as const },
      { sourceReadOnlyApplied: true },
    ]) {
      const h = new Harness(t);
      const s = stub();
      const { statuses } = await migrateRun(
        h,
        s,
        [stepDef('git.push-refs'), sourceReadOnlyStep('migration')],
        variant,
      );
      expect(statuses['source.read-only']).toBe('skipped');
      expect(s.applyCalls).toEqual([]);
    }
  });

  it('[LIF-070] is skipped, with a warning, when a step of 1 to 12 failed', async () => {
    const h = new Harness(t);
    const s = stub();
    const { world, result, statuses } = await migrateRun(h, s, [
      stepDef('facet.webhooks.apply', async () => {
        throw new AdapterError({ code: 'invalid', provider: 'x', message: 'no' });
      }),
      sourceReadOnlyStep('migration'),
    ]);
    expect(result).toEqual({ outcome: 'finished', status: 'partial' });
    expect(statuses['source.read-only']).toBe('skipped');
    expect(s.applyCalls).toEqual([]);
    const log = await h.db.runLog.findMany({ where: { runId: world.runId, level: 'warn' } });
    expect(log.map((l) => l.message).join('\n')).toContain('steps 1 to 12 did not all succeed');
  });

  it('[LIF-070] is skipped when the Parity Check did not run, or git-refs is not equal', async () => {
    for (const parity of [undefined, 'different', 'unverifiable'] as const) {
      const h = new Harness(t);
      const s = stub();
      let migrationId = '';
      const { statuses } = await migrateRun(h, s, [
        stepDef('probe', async (ctx) => {
          migrationId = ctx.migration.id;
          return { status: 'succeeded' };
        }),
        ...(parity ? [verifyStep(parity, () => migrationId, h)] : []),
        sourceReadOnlyStep('migration'),
      ]);
      expect(statuses['source.read-only']).toBe('skipped');
      expect(s.applyCalls).toEqual([]);
    }
  });

  it('[LIF-070] a parity result that is older than this Run verify Step does not count', async () => {
    const h = new Harness(t);
    const s = stub();
    let migrationId = '';
    const { statuses } = await migrateRun(h, s, [
      stepDef('probe', async (ctx) => {
        migrationId = ctx.migration.id;
        await h.db.parityResult.create({
          data: {
            migrationId,
            facetKey: 'git-refs',
            status: 'equal',
            diffs: [],
            excluded: [],
            checkedAt: new Date(Date.now() - 3_600_000),
          },
        });
        return { status: 'succeeded' };
      }),
      stepDef('verify', undefined, 'advisory'),
      sourceReadOnlyStep('migration'),
    ]);
    expect(statuses['source.read-only']).toBe('skipped');
  });

  it('[LIF-042] a failing step 14 makes the Run partial and keeps the records written before it failed', async () => {
    const h = new Harness(t);
    const s = stub();
    s.apply = async () => {
      throw Object.assign(
        new AdapterError({ code: 'conflict', provider: 'x', message: 'description failed' }),
        { mutations: [RESTRICTION], possiblyApplied: [] },
      );
    };
    let migrationId = '';
    const { world, result, statuses } = await migrateRun(h, s, [
      stepDef('probe', async (ctx) => {
        migrationId = ctx.migration.id;
        return { status: 'succeeded' };
      }),
      verifyStep('equal', () => migrationId, h),
      sourceReadOnlyStep('migration'),
    ]);
    expect(result).toEqual({ outcome: 'finished', status: 'partial' });
    expect(statuses['source.read-only']).toBe('failed');
    const rows = await h.db.mutation.findMany({
      where: { runId: world.runId },
      orderBy: { seq: 'asc' },
    });
    // The umbrella is settled, the restriction that was made is ledgered and will be undone.
    expect(rows.map((r) => [r.facetKey, r.state])).toEqual([
      ['framework', 'recorded'],
      ['branch-rules', 'recorded'],
    ]);
    expect((await h.migration(world.migrationId)).sourceReadOnlyApplied).toBe(false);
  });

  it('[LIF-070] a write that may have been applied but could not be read back fails the Step with a manual-check code', async () => {
    const h = new Harness(t);
    const s = stub();
    s.apply = async () => {
      throw Object.assign(
        new AdapterError({ code: 'transient', provider: 'x', message: 'lost', retryable: true }),
        { mutations: [], possiblyApplied: ['branch-restriction'] },
      );
    };
    let migrationId = '';
    const { world, statuses } = await migrateRun(h, s, [
      stepDef('probe', async (ctx) => {
        migrationId = ctx.migration.id;
        return { status: 'succeeded' };
      }),
      verifyStep('equal', () => migrationId, h),
      sourceReadOnlyStep('migration'),
    ]);
    expect(statuses['source.read-only']).toBe('failed');
    expect(s.applyCalls).toHaveLength(1);
    const step = await h.db.runStep.findFirstOrThrow({
      where: { runId: world.runId, stepKey: 'source.read-only' },
    });
    expect(step.error).toMatchObject({
      code: 'source-read-only.possibly-applied',
      retryable: false,
    });
  });

  it('[LIF-070] fails with a code of its own when the source provider cannot be locked', async () => {
    const h = new Harness(t);
    const world = await seed(h);
    const registry = new RunStepRegistry<MigrationServices>();
    registry.register('source_read_only', createSourceLockPlanner('source_read_only'));
    const s = stub();
    await h.db.run.update({ where: { id: world.runId }, data: { status: 'cancelled' } });
    const created = await startKind(
      h,
      world.world.migrationId,
      world.world.actorId,
      'source_read_only',
    );
    const result = await h.execute(
      created,
      {},
      {
        registry: registry as never,
        services: services(h, s, false) as never,
      },
    );
    expect(result).toEqual({ outcome: 'finished', status: 'failed' });
    const step = await h.db.runStep.findFirstOrThrow({ where: { runId: created } });
    expect(step.error).toMatchObject({ code: 'source-read-only.unsupported' });
  });
});

/** Ends the Migration's current Run so another kind can start (the lifecycle table decides). */
async function startKind(
  h: Harness,
  migrationId: string,
  actorId: string,
  kind: RunKind,
): Promise<string> {
  await h.db.migration.update({
    where: { id: migrationId },
    data: { status: 'migrated', statusBeforeRun: null },
  });
  const created = await createRun(h.db, { migrationId, kind, triggeredById: actorId });
  return created.runId;
}

describe('[LIF-070] source_read_only and undo_source_read_only Runs', () => {
  async function lockedMigration(h: Harness, s: Stub) {
    const world = await seed(h);
    await h.db.run.update({ where: { id: world.runId }, data: { status: 'cancelled' } });
    const registry = new RunStepRegistry<MigrationServices>();
    registry.register('source_read_only', createSourceLockPlanner('source_read_only'));
    registry.register('undo_source_read_only', createSourceLockPlanner('undo_source_read_only'));
    const deps = { registry: registry as never, services: services(h, s) as never };
    const apply = await startKind(h, world.migrationId, world.world.actorId, 'source_read_only');
    const applied = await h.execute(apply, {}, deps);
    return { world, deps, apply, applied };
  }

  it('[LIF-070] a source_read_only Run applies the lock without a Parity Check and the lifecycle sets sourceReadOnlyApplied', async () => {
    const h = new Harness(t);
    const s = stub();
    const { world, applied } = await lockedMigration(h, s);
    expect(applied).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(s.applyCalls).toHaveLength(1);
    const migration = await h.migration(world.migrationId);
    expect(migration.sourceReadOnlyApplied).toBe(true);
    expect(migration.status).toBe('migrated');
  });

  it('[LIF-070] undo reverts the recorded Mutations newest first, one at a time, and marks them undone', async () => {
    const h = new Harness(t);
    const s = stub();
    const { world, deps } = await lockedMigration(h, s);
    const undo = await startKind(
      h,
      world.migrationId,
      world.world.actorId,
      'undo_source_read_only',
    );
    const result = await h.execute(undo, {}, deps);
    expect(result).toEqual({ outcome: 'finished', status: 'succeeded' });
    // The adapter got each record with the images as recorded (it restores `before`).
    expect(s.undoCalls.map((c) => c.map((m) => m.facetKey))).toEqual([
      ['repository-settings'],
      ['branch-rules'],
    ]);
    expect(s.undoCalls[0]?.[0]).toMatchObject({
      before: DESCRIPTION.before,
      after: DESCRIPTION.after,
    });
    const rows = await h.db.mutation.findMany({ where: { migrationId: world.migrationId } });
    const real = rows.filter((r) => r.facetKey !== 'framework');
    expect(real.every((r) => r.undoneAt !== null)).toBe(true);
    expect((await h.migration(world.migrationId)).sourceReadOnlyApplied).toBe(false);
    // Nothing active is left, so a repeated undo reverts nothing.
    const again = await startKind(
      h,
      world.migrationId,
      world.world.actorId,
      'undo_source_read_only',
    );
    s.undoCalls.length = 0;
    await h.execute(again, {}, deps);
    expect(s.undoCalls).toEqual([]);
    const step = await h.db.runStep.findFirstOrThrow({ where: { runId: again } });
    expect(step.status).toBe('succeeded');
  });

  it('[LIF-070] undo never reverts an adopted record or one that was not applied', async () => {
    const h = new Harness(t);
    const s = stub();
    s.apply = async () => [
      { ...RESTRICTION, resourceRef: { ...RESTRICTION.resourceRef, adopted: true } },
      {
        ...DESCRIPTION,
        resourceRef: { ...DESCRIPTION.resourceRef, adopted: true },
        after: DESCRIPTION.before,
      },
    ];
    const { world, deps } = await lockedMigration(h, s);
    const undo = await startKind(
      h,
      world.migrationId,
      world.world.actorId,
      'undo_source_read_only',
    );
    await h.execute(undo, {}, deps);
    expect(s.undoCalls).toEqual([]);
  });

  it('[LIF-070] undo keeps the flag and fails when a read-back still shows the lock', async () => {
    const h = new Harness(t);
    const s = stub();
    const { world, deps } = await lockedMigration(h, s);
    s.inspected = [RESTRICTION];
    const undo = await startKind(
      h,
      world.migrationId,
      world.world.actorId,
      'undo_source_read_only',
    );
    const result = await h.execute(undo, {}, deps);
    expect(result).toEqual({ outcome: 'finished', status: 'failed' });
    const step = await h.db.runStep.findFirstOrThrow({ where: { runId: undo } });
    expect(step.error).toMatchObject({ code: 'source-read-only.undo_incomplete' });
    expect((await h.migration(world.migrationId)).sourceReadOnlyApplied).toBe(true);
  });

  it('[LIF-070] an adopted description hides only its own text in the read-back after undo, not another prefix', async () => {
    const h = new Harness(t);
    const s = stub();
    s.apply = async () => [
      {
        ...DESCRIPTION,
        resourceRef: { ...DESCRIPTION.resourceRef, adopted: true },
        before: DESCRIPTION.after,
      },
    ];
    const { world, deps } = await lockedMigration(h, s);
    s.inspected = [flagged({ ...DESCRIPTION, after: { description: OTHER_PREFIXED } })];
    const undo = await startKind(
      h,
      world.migrationId,
      world.world.actorId,
      'undo_source_read_only',
    );
    expect(await h.execute(undo, {}, deps)).toEqual({ outcome: 'finished', status: 'failed' });
    const step = await h.db.runStep.findFirstOrThrow({ where: { runId: undo } });
    expect(step.error).toMatchObject({ code: 'source-read-only.undo_incomplete' });
  });

  it('[LIF-070] state the framework only adopted may remain after undo: the read-back accepts it and the flag is cleared', async () => {
    const h = new Harness(t);
    const s = stub();
    s.apply = async () => [
      { ...RESTRICTION, resourceRef: { ...RESTRICTION.resourceRef, adopted: true } },
    ];
    const { world, deps } = await lockedMigration(h, s);
    s.inspected = [
      { ...RESTRICTION, resourceRef: { ...RESTRICTION.resourceRef, possiblyFramework: true } },
    ];
    const undo = await startKind(
      h,
      world.migrationId,
      world.world.actorId,
      'undo_source_read_only',
    );
    expect(await h.execute(undo, {}, deps)).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect((await h.migration(world.migrationId)).sourceReadOnlyApplied).toBe(false);
  });

  it('[LIF-070] fails with a code of its own when the Migration has no target to point the source at', async () => {
    const h = new Harness(t);
    const world = await seed(h, false);
    await h.db.run.update({ where: { id: world.runId }, data: { status: 'cancelled' } });
    const registry = new RunStepRegistry<MigrationServices>();
    registry.register('source_read_only', createSourceLockPlanner('source_read_only'));
    const s = stub();
    const run = await startKind(h, world.migrationId, world.world.actorId, 'source_read_only');
    const result = await h.execute(
      run,
      {},
      {
        registry: registry as never,
        services: services(h, s) as never,
      },
    );
    expect(result).toEqual({ outcome: 'finished', status: 'failed' });
    expect(s.applyCalls).toEqual([]);
    const step = await h.db.runStep.findFirstOrThrow({ where: { runId: run } });
    expect(step.error).toMatchObject({ code: 'source-read-only.target_missing' });
  });
});

const flagged = (record: MutationRecord): MutationRecord => ({
  ...record,
  resourceRef: { ...record.resourceRef, possiblyFramework: true },
});
const OTHER_PREFIXED = '[MIGRATED → https://other.example/x] Original';

describe('[LIF-070] a step resumed after the worker died between the write and its record', () => {
  /**
   * Runs the standalone Step with a hand-built context whose ledger has one open intent. `baseline`
   * is what the intent kept (`null`: an intent with none).
   */
  async function resume(
    s: Stub,
    options: {
      inspectable?: boolean;
      baseline?: string[] | null;
      /** The originals the open intent kept (omitted: none). */
      originals?: MutationRecord[];
      existing?: { h: Harness; migrationId: string };
    } = {},
  ) {
    const h = options.existing?.h ?? new Harness(t);
    const migrationId = options.existing?.migrationId ?? (await seed(h)).migrationId;
    const confirmed: [string, string][] = [];
    const recorded: MutationRecord[] = [];
    const intended: unknown[] = [];
    const blockers: string[] = [];
    const cleared: string[] = [];
    const baseline = options.baseline === undefined ? [] : options.baseline;
    const ctx = {
      run: { id: 'run', options: {}, analysisId: null, kind: 'source_read_only' },
      migration: {
        id: migrationId,
        scope: 'repository',
        sourceRepositoryId: (await h.migration(migrationId)).sourceRepositoryId,
        sourceReadOnlyApplied: false,
      },
      services: services(h, s, true, options.inspectable ?? true),
      signal: new AbortController().signal,
      log: silentLog,
      checkpoint: () => undefined,
      runLog: async () => undefined,
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(h.db),
      findings: {
        addBlocker: async (f: { code: string }) => {
          blockers.push(f.code);
        },
        clearBlockers: async (codes: readonly string[]) => {
          cleared.push(...codes);
        },
      },
      ledger: {
        openIntents: async () => [
          {
            id: 'open-1',
            resourceRef: { kind: 'source-read-only', noop: true },
            before:
              baseline === null
                ? null
                : options.originals === undefined
                  ? { baseline }
                  : { baseline, originals: options.originals },
          },
        ],
        intend: async (_w: unknown, record: { before: unknown }) => {
          intended.push(record.before);
          return 'new-intent';
        },
        record: async (_w: unknown, rs: MutationRecord[]) => {
          recorded.push(...rs);
        },
        confirm: async (id: string, outcome: string) => {
          confirmed.push([id, outcome]);
        },
      },
    };
    const outcome = await sourceReadOnlyStep('standalone')
      .run(ctx as never)
      .then(
        (r) => ({ r }),
        (error: unknown) => ({ error }),
      );
    return { outcome, confirmed, recorded, intended, blockers, cleared };
  }

  it('[LIF-070] with nothing new on the source, the open intent is settled as not applied; the baseline of the new write is taken before it', async () => {
    const s = stub();
    const { outcome, confirmed, intended } = await resume(s);
    expect(outcome).toMatchObject({ r: { status: 'succeeded' } });
    expect(confirmed).toEqual([
      ['open-1', 'not_applied'],
      ['new-intent', 'applied'],
    ]);
    expect(intended).toEqual([{ baseline: [], originals: [ORIGINAL] }]);
    expect(s.applyCalls).toHaveLength(1);
  });

  it('[LIF-070] a lock that appeared after the baseline is recorded as undoable (not inert, flagged possiblyFramework) and the Step fails for a check', async () => {
    const s = stub();
    s.inspected = [flagged(RESTRICTION)];
    const { outcome, confirmed, recorded } = await resume(s);
    expect(outcome).toMatchObject({
      error: { code: 'source-read-only.needs-manual-check', details: { recorded: 1 } },
    });
    expect(confirmed).toEqual([['open-1', 'applied']]);
    expect(s.applyCalls).toEqual([]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.resourceRef).toMatchObject({ id: 7, possiblyFramework: true });
    expect(recorded[0]?.resourceRef.adopted).toBeUndefined();
    expect(recorded[0]?.resourceRef.noop).toBeUndefined();
  });

  it("[LIF-070] a user-less push restriction that was already there before the lock is the customer's: never recorded, so undo cannot delete it", async () => {
    const s = stub();
    s.inspected = [flagged(RESTRICTION)];
    const { outcome, recorded } = await resume(s, { baseline: [keyOf(RESTRICTION)] });
    // Nothing appeared, so the Step goes on and the adapter adopts what it finds.
    expect(outcome).toMatchObject({ r: { status: 'succeeded' } });
    expect(recorded.filter((r) => r.resourceRef.possiblyFramework === true)).toEqual([]);
  });

  it("[LIF-070] a description that already carried a prefix before the lock is the customer's: never recorded", async () => {
    const s = stub();
    const prefixed: MutationRecord = {
      ...DESCRIPTION,
      before: { description: 'Original' },
      after: { description: OTHER_PREFIXED },
    };
    s.inspected = [flagged(prefixed)];
    const { outcome, recorded } = await resume(s, { baseline: [keyOf(prefixed)] });
    expect(outcome).toMatchObject({ r: { status: 'succeeded' } });
    expect(recorded.filter((r) => r.resourceRef.possiblyFramework === true)).toEqual([]);
  });

  it('[LIF-070] a description whose text changed since the baseline is recorded, even if an adopted record of the same repository exists', async () => {
    const s = stub();
    const text = (d: string): MutationRecord => ({
      ...DESCRIPTION,
      before: { description: d },
      after: { description: `[MIGRATED → https://git.test/acme/r] ${d}` },
    });
    s.inspected = [flagged(text('Now'))];
    const { outcome, recorded } = await resume(s, { baseline: [keyOf(text('Then'))] });
    expect(outcome).toMatchObject({ error: { code: 'source-read-only.needs-manual-check' } });
    expect(recorded).toHaveLength(1);
  });

  it('[LIF-070] a recovered description is recorded with the original the baseline kept: the inspection is given those originals', async () => {
    const s = stub();
    // The adapter sets `before` from the originals it is given (never from the current text).
    s.inspected = [flagged(DESCRIPTION)];
    const { outcome, recorded, cleared } = await resume(s, { originals: [ORIGINAL] });
    expect(outcome).toMatchObject({
      error: { code: 'source-read-only.needs-manual-check', details: { recorded: 1 } },
    });
    expect(s.inspectOriginals[0]).toEqual([ORIGINAL]);
    expect(recorded.map((r) => r.before)).toEqual([{ description: 'Hello' }]);
    // Settled: the blocker on target writes is cleared even though the Step stops for a check.
    expect(cleared).toContain(SOURCE_LOCK_UNSETTLED);
  });

  it('[LIF-070] a recovered description with no original to restore is not recorded, and the Step fails for an inspection by hand', async () => {
    const s = stub();
    s.inspected = [flagged(RESTRICTION), flagged({ ...DESCRIPTION, before: null })];
    const { outcome, recorded, confirmed } = await resume(s);
    expect(outcome).toMatchObject({
      error: {
        code: 'source-read-only.needs-manual-check',
        details: { recorded: 1, unrecoverable: 1 },
        message: expect.stringContaining('by hand'),
      },
    });
    expect(recorded.map((r) => r.facetKey)).toEqual(['branch-rules']);
    expect(confirmed).toEqual([['open-1', 'applied']]);
  });

  it('[LIF-070] an adopted description of the same text does not hide a later framework write of it (relock after undo)', async () => {
    const h = new Harness(t);
    const s = stub();
    // Run 1 found the prefix already there and only adopted it.
    s.apply = async () => [
      {
        ...DESCRIPTION,
        resourceRef: { ...DESCRIPTION.resourceRef, adopted: true },
        before: DESCRIPTION.after,
      },
    ];
    const world = await seed(h);
    await h.db.run.update({ where: { id: world.runId }, data: { status: 'cancelled' } });
    const registry = new RunStepRegistry<MigrationServices>();
    registry.register('source_read_only', createSourceLockPlanner('source_read_only'));
    const deps = { registry: registry as never, services: services(h, s) as never };
    const first = await startKind(h, world.migrationId, world.world.actorId, 'source_read_only');
    expect(await h.execute(first, {}, deps)).toEqual({ outcome: 'finished', status: 'succeeded' });
    // The customer removed the prefix; a later write put the same text back and its record was lost.
    const later = stub();
    later.inspected = [flagged(DESCRIPTION)];
    const { outcome, recorded } = await resume(later, {
      existing: { h, migrationId: world.migrationId },
      originals: [ORIGINAL],
    });
    expect(outcome).toMatchObject({ error: { code: 'source-read-only.needs-manual-check' } });
    expect(recorded.map((r) => r.after)).toEqual([DESCRIPTION.after]);
  });

  it('[LIF-070] an intent with no baseline records nothing and fails for an inspection by hand', async () => {
    const s = stub();
    s.inspected = [flagged(RESTRICTION)];
    const { outcome, recorded, confirmed } = await resume(s, { baseline: null });
    expect(outcome).toMatchObject({
      error: {
        code: 'source-read-only.needs-manual-check',
        message: expect.stringContaining('by hand'),
      },
    });
    expect(recorded).toEqual([]);
    expect(confirmed).toEqual([['open-1', 'applied']]);
    expect(s.applyCalls).toEqual([]);
  });

  it('[LIF-070] a provider that cannot be inspected fails the resumed Step without recording anything', async () => {
    const s = stub();
    const { outcome, recorded } = await resume(s, { inspectable: false });
    expect(outcome).toMatchObject({ error: { code: 'source-read-only.needs-manual-check' } });
    expect(recorded).toEqual([]);
  });

  it('[LIF-070] when the source cannot be read on resume, the intent stays open and nothing is claimed', async () => {
    const s = stub();
    s.inspectScript = [
      new AdapterError({ code: 'transient', provider: 'x', message: 'down', retryable: true }),
    ];
    const { outcome, confirmed, recorded } = await resume(s);
    expect(outcome).toMatchObject({ error: { code: 'transient' } });
    expect(confirmed).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it('[LIF-070] when the source cannot be read before the first write, nothing is written', async () => {
    const h = new Harness(t);
    const s = stub();
    s.inspectScript = [new AdapterError({ code: 'invalid', provider: 'x', message: 'no access' })];
    const world = await seed(h);
    const registry = new RunStepRegistry<MigrationServices>();
    registry.register('migrate', { steps: () => [sourceReadOnlyStep('standalone', 'fatal')] });
    // queuedRun made a migrate Run; the first settle inspects nothing (no intent), the baseline fails.
    await h.execute(
      world.runId,
      {},
      { registry: registry as never, services: services(h, s) as never },
    );
    expect(s.applyCalls).toEqual([]);
  });
});

describe('[LIF-070] a write that could not be confirmed, then not inspected, is not lost', () => {
  async function setup(h: Harness, s: Stub) {
    const world = await seed(h);
    await h.db.run.update({ where: { id: world.runId }, data: { status: 'cancelled' } });
    const registry = new RunStepRegistry<MigrationServices>();
    registry.register('source_read_only', createSourceLockPlanner('source_read_only'));
    registry.register('undo_source_read_only', createSourceLockPlanner('undo_source_read_only'));
    return { world, deps: { registry: registry as never, services: services(h, s) as never } };
  }
  const ambiguous = () =>
    Object.assign(new AdapterError({ code: 'conflict', provider: 'x', message: 'lost' }), {
      mutations: [],
      possiblyApplied: ['branch-restriction'],
    });

  it('[LIF-070] the Step retries on a transient inspect failure, records the lock from the baseline on the next attempt, and undo removes it', async () => {
    const h = new Harness(t);
    const s = stub();
    s.apply = async () => {
      throw ambiguous();
    };
    // baseline (before the write), then the look after the ambiguous write fails, then it works.
    s.inspectScript = [
      [],
      new AdapterError({ code: 'transient', provider: 'x', message: 'down', retryable: true }),
      [flagged(RESTRICTION)],
    ];
    const { world, deps } = await setup(h, s);
    const apply = await startKind(h, world.migrationId, world.world.actorId, 'source_read_only');
    expect(await h.execute(apply, {}, deps)).toEqual({ outcome: 'finished', status: 'failed' });
    const step = await h.db.runStep.findFirstOrThrow({ where: { runId: apply } });
    expect(step.error).toMatchObject({ code: 'source-read-only.needs-manual-check' });
    const rows = await h.db.mutation.findMany({ where: { migrationId: world.migrationId } });
    const real = rows.filter((r) => (r.resourceRef as { noop?: boolean }).noop !== true);
    expect(
      real.map((r) => (r.resourceRef as { possiblyFramework?: boolean }).possiblyFramework),
    ).toEqual([true]);
    expect(rows.every((r) => r.state !== 'intended')).toBe(true);
    const undo = await startKind(
      h,
      world.migrationId,
      world.world.actorId,
      'undo_source_read_only',
    );
    expect(await h.execute(undo, {}, deps)).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(s.undoCalls.flat().map((m) => m.resourceRef.id)).toEqual([7]);
  });

  it('[LIF-070] when inspect keeps failing the intent stays open, the message claims nothing, the end-of-Run Analysis is skipped, and a later lock Run records the lock', async () => {
    const h = new Harness(t);
    const s = stub();
    s.apply = async () => {
      throw ambiguous();
    };
    const down = () => new AdapterError({ code: 'invalid', provider: 'x', message: 'no access' });
    s.inspectScript = [[], down()];
    const { world, deps } = await setup(h, s);
    const first = await startKind(h, world.migrationId, world.world.actorId, 'source_read_only');
    expect(await h.execute(first, {}, deps)).toEqual({ outcome: 'finished', status: 'failed' });
    const step = await h.db.runStep.findFirstOrThrow({ where: { runId: first } });
    expect(step.error).toMatchObject({ code: 'invalid' });
    expect(JSON.stringify(step.error)).not.toContain('recorded');
    expect(await hasOpenLockIntent(h.db, world.migrationId)).toBe(true);
    // Target-writing Runs are blocked until the lock is settled (LIF-045, LIF-049).
    expect((await h.migration(world.migrationId)).blockerCodes).toContain(SOURCE_LOCK_UNSETTLED);
    await h.db.migration.update({
      where: { id: world.migrationId },
      data: { status: 'migrated', statusBeforeRun: null },
    });
    await expect(
      createRun(h.db, {
        migrationId: world.migrationId,
        kind: 'resync',
        triggeredById: world.world.actorId,
      }),
    ).rejects.toMatchObject({ code: 'run.readiness_required' });
    // Even with the blocker dismissed, the open intent itself refuses the Run.
    const blocked = await h.migration(world.migrationId);
    await h.db.migration.update({
      where: { id: world.migrationId },
      data: { runBlockers: [], readiness: null, blockerCodes: [] },
    });
    await expect(
      createRun(h.db, {
        migrationId: world.migrationId,
        kind: 'resync',
        triggeredById: world.world.actorId,
      }),
    ).rejects.toMatchObject({
      code: 'run.readiness_required',
      message: expect.stringContaining('unsettled'),
    });
    await h.db.migration.update({
      where: { id: world.migrationId },
      data: {
        runBlockers: blocked.runBlockers as never,
        readiness: blocked.readiness,
        blockerCodes: blocked.blockerCodes,
      },
    });
    // A read of the source cannot tell the lock apart now: the Facets it writes are withheld.
    const unreadable = await sourceLockView(
      h.db,
      world.migrationId,
      {
        apply: async () => [],
        undo: async () => [],
        inspect: async () => {
          throw new AdapterError({ code: 'transient', provider: 'x', message: 'down' });
        },
      },
      SOURCE_REF,
    );
    expect(unreadable.withheld).toEqual(SOURCE_LOCK_FACETS);
    // When it can, what appeared since the baseline is left out of the read instead.
    const up = await sourceLockView(
      h.db,
      world.migrationId,
      { apply: async () => [], undo: async () => [], inspect: async () => [flagged(RESTRICTION)] },
      SOURCE_REF,
    );
    expect(up.withheld).toEqual([]);
    expect(up.resources.map((r) => r.id)).toEqual([7]);
    // The end-of-Run Analysis does not run while the outcome is unknown.
    const reanalyze = vi.fn();
    const refresh = await refreshAnalysisStep().run({
      migration: { id: world.migrationId },
      services: { db: h.db, reanalyze },
      runLog: async () => undefined,
      signal: new AbortController().signal,
    } as never);
    expect(refresh).toMatchObject({ status: 'skipped' });
    expect(reanalyze).not.toHaveBeenCalled();
    // A later lock Run settles it from the old baseline: the lock is recorded, undo reaches it.
    s.apply = undefined;
    s.inspected = [flagged(RESTRICTION)];
    const second = await startKind(h, world.migrationId, world.world.actorId, 'source_read_only');
    expect(await h.execute(second, {}, deps)).toEqual({ outcome: 'finished', status: 'failed' });
    const stepTwo = await h.db.runStep.findFirstOrThrow({ where: { runId: second } });
    expect(stepTwo.error).toMatchObject({ code: 'source-read-only.needs-manual-check' });
    expect(await hasOpenLockIntent(h.db, world.migrationId)).toBe(false);
    // Settled, and recorded: the blocker is gone and the read leaves the lock out by id.
    expect((await h.migration(world.migrationId)).blockerCodes).not.toContain(
      SOURCE_LOCK_UNSETTLED,
    );
    const settled = await sourceLockView(h.db, world.migrationId, undefined, SOURCE_REF);
    expect(settled).toMatchObject({ withheld: [] });
    expect(settled.resources.map((r) => r.id)).toEqual([7]);
    const undo = await startKind(
      h,
      world.migrationId,
      world.world.actorId,
      'undo_source_read_only',
    );
    s.inspected = [];
    expect(await h.execute(undo, {}, deps)).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(s.undoCalls.flat().map((m) => m.resourceRef.id)).toEqual([7]);
  });

  it('[LIF-070] undo records a lock left unconfirmed by an earlier Run and removes it', async () => {
    const h = new Harness(t);
    const s = stub();
    s.apply = async () => {
      throw ambiguous();
    };
    s.inspectScript = [
      [],
      new AdapterError({ code: 'invalid', provider: 'x', message: 'no access' }),
    ];
    const { world, deps } = await setup(h, s);
    const first = await startKind(h, world.migrationId, world.world.actorId, 'source_read_only');
    await h.execute(first, {}, deps);
    expect(await hasOpenLockIntent(h.db, world.migrationId)).toBe(true);
    s.inspected = [flagged(RESTRICTION)];
    const undo = await startKind(
      h,
      world.migrationId,
      world.world.actorId,
      'undo_source_read_only',
    );
    // The read-back after the revert shows nothing left.
    s.inspectScript = [[flagged(RESTRICTION)], []];
    expect(await h.execute(undo, {}, deps)).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect(s.undoCalls.flat().map((m) => m.resourceRef.id)).toEqual([7]);
    expect(await hasOpenLockIntent(h.db, world.migrationId)).toBe(false);
  });
});

describe('[LIF-070] adopted state that the baseline already showed', () => {
  it("[LIF-045] is tagged preexisting (the customer's own, translated as before); adopted state that appeared later is not", async () => {
    const h = new Harness(t);
    const s = stub();
    s.inspected = [flagged(RESTRICTION)];
    const adopted = { ...RESTRICTION, resourceRef: { ...RESTRICTION.resourceRef, adopted: true } };
    s.apply = async () => [adopted, DESCRIPTION];
    const world = await seed(h);
    await h.db.run.update({ where: { id: world.runId }, data: { status: 'cancelled' } });
    const registry = new RunStepRegistry<MigrationServices>();
    registry.register('source_read_only', createSourceLockPlanner('source_read_only'));
    const deps = { registry: registry as never, services: services(h, s) as never };
    const run = await startKind(h, world.migrationId, world.world.actorId, 'source_read_only');
    expect(await h.execute(run, {}, deps)).toEqual({ outcome: 'finished', status: 'succeeded' });
    const refs = (await frameworkSourceResources(h.db, world.migrationId)).map(
      (r) => r.type as string,
    );
    // The restriction was in the baseline: tagged and left out of the framework's resources.
    const rows = await h.db.mutation.findMany({ where: { migrationId: world.migrationId } });
    expect(
      rows.some((r) => (r.resourceRef as { preexisting?: boolean }).preexisting === true),
    ).toBe(true);
    expect(refs).toEqual(['repository-description']);
  });
});

describe('[LIF-070] undo when the original description already carried a prefix', () => {
  it('[LIF-077] the restored original is not a lock: the read-back accepts it and the flag is cleared', async () => {
    const h = new Harness(t);
    const s = stub();
    const prefixed: MutationRecord = {
      ...DESCRIPTION,
      before: { description: OTHER_PREFIXED },
      after: { description: `[MIGRATED → https://git.test/acme/r] ${OTHER_PREFIXED}` },
    };
    s.apply = async () => [RESTRICTION, prefixed];
    const world = await seed(h);
    await h.db.run.update({ where: { id: world.runId }, data: { status: 'cancelled' } });
    const registry = new RunStepRegistry<MigrationServices>();
    registry.register('source_read_only', createSourceLockPlanner('source_read_only'));
    registry.register('undo_source_read_only', createSourceLockPlanner('undo_source_read_only'));
    const deps = { registry: registry as never, services: services(h, s) as never };
    const apply = await startKind(h, world.migrationId, world.world.actorId, 'source_read_only');
    expect(await h.execute(apply, {}, deps)).toEqual({ outcome: 'finished', status: 'succeeded' });
    // After undo the source shows the original, prefix and all.
    s.inspectScript = [
      [
        {
          ...prefixed,
          before: { description: 'Original' },
          after: { description: OTHER_PREFIXED },
          resourceRef: { ...prefixed.resourceRef, possiblyFramework: true },
        },
      ],
    ];
    const undo = await startKind(
      h,
      world.migrationId,
      world.world.actorId,
      'undo_source_read_only',
    );
    expect(await h.execute(undo, {}, deps)).toEqual({ outcome: 'finished', status: 'succeeded' });
    expect((await h.migration(world.migrationId)).sourceReadOnlyApplied).toBe(false);
  });
});

describe('[LIF-070] target web URL', () => {
  it('[LIF-070] is the git remote without credentials, query or the .git suffix', () => {
    expect(targetWebUrl('https://x-access-token:abc@github.example/acme/repo.git')).toBe(
      'https://github.example/acme/repo',
    );
    expect(targetWebUrl('http://127.0.0.1:9/target/acme/repo.git/')).toBe(
      'http://127.0.0.1:9/target/acme/repo',
    );
  });
});
