/**
 * LIF-040 steps 3 and 3a: `target.ensure-repository` (create or adopt, LIF-031) and
 * `target.lift-protection`. Every provider write has an intent in the ledger before it is made and
 * a confirmation after it, so a worker that dies in between leaves a record rollback can find
 * (ADR-0342). Decisions: docs/adr/0380-migration-steps.md.
 */

import { isAdapterError, type RepositoryRecord } from '@git-migrator/adapter-sdk';
import { parseFieldPath } from '@git-migrator/core';
import type { Db } from '@git-migrator/db';
import { StepFailure } from '../run/errors.ts';
import type { MutationLike, StepDefinition, StepResult } from '../run/types.ts';
import { recoverOpenIntents } from './facets.ts';
import { branchPatternMatches } from './glob.ts';
import {
  connectSide,
  type MigrationContext,
  type MigrationServices,
  type Side,
  withSessionLock,
} from './services.ts';
import { loadRunWorld, type RunWorld, repositoryRow, repositoryTarget, targetOf } from './world.ts';

const REPOSITORY_KIND = 'repository';

const snapshotOf = (record: RepositoryRecord) => ({
  name: record.name,
  isPrivate: record.isPrivate,
  defaultBranch: record.defaultBranch ?? null,
});

/**
 * The ledger record of a repository this Run created (rollback deletes it, LIF-077). It names the
 * Endpoint, so a rollback after the Route moved to another Endpoint finds it (ADR-0504).
 */
const createdRecord = (record: RepositoryRecord, endpointId: string): MutationLike => ({
  facetKey: null,
  action: 'create',
  resourceRef: { kind: REPOSITORY_KIND, id: record.providerId, name: record.name, endpointId },
  paths: [],
  before: null,
  after: snapshotOf(record),
});

/** State that existed before the Run: undo never removes or rewrites it (LIF-045, ADR-0222). */
const adoptedRecord = (record: RepositoryRecord, forced: boolean): MutationLike => ({
  facetKey: null,
  action: 'create',
  resourceRef: {
    kind: REPOSITORY_KIND,
    id: record.providerId,
    name: record.name,
    adopted: true,
    ...(forced ? { forced: true } : {}),
  },
  paths: [],
  before: snapshotOf(record),
  after: snapshotOf(record),
});

class ClaimedElsewhere extends Error {}

/**
 * Persists the target `Repository` row and the claim on it (`Migration.targetRepositoryId`,
 * `targetCreatedByFramework`) in one transaction. An advisory lock per target repository makes the
 * check "no other Migration holds it" and the write one step, so two Runs cannot adopt the same
 * repository (LIF-031 `target.owned-by-other-migration`).
 */
async function claimTarget(
  ctx: MigrationContext,
  world: RunWorld,
  record: RepositoryRecord,
  createdByFramework: boolean,
): Promise<void> {
  const now = (ctx.services.now ?? (() => new Date()))();
  const row = repositoryRow(world, record, now);
  await ctx.transaction(
    async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`target-claim:${world.targetEndpointId}:${record.providerId}`}, 0))`;
      const repo = await tx.repository.upsert({
        where: {
          endpointId_providerId: {
            endpointId: world.targetEndpointId,
            providerId: record.providerId,
          },
        },
        create: row,
        update: row,
        select: { id: true },
      });
      const other = await tx.migration.findFirst({
        where: { targetRepositoryId: repo.id, id: { not: world.migrationId } },
        select: { id: true },
      });
      if (other) throw new ClaimedElsewhere();
      await tx.migration.update({
        where: { id: world.migrationId },
        data: { targetRepositoryId: repo.id, targetCreatedByFramework: createdByFramework },
      });
    },
    { migration: true },
  );
}

/** True when this Migration's ledger holds a recorded, non-adopted creation of exactly `record`. */
export async function creationRecorded(
  db: Db,
  migrationId: string,
  record: Pick<RepositoryRecord, 'providerId'>,
): Promise<boolean> {
  const recorded = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app.mutation
    WHERE migration_id = ${migrationId} AND side = 'target' AND action = 'create'
      AND state = 'recorded' AND resource_ref->>'kind' = ${REPOSITORY_KIND}
      AND resource_ref->>'id' = ${record.providerId}
      AND coalesce(resource_ref->>'adopted', 'false') <> 'true'`;
  return (recorded[0]?.n ?? 0) > 0;
}

/**
 * How long after its Run ended an unsettled create intent can still vouch for an empty repository
 * (LIF-077): the create request may have been sent just before the cancel and land at the provider
 * after the Run finished, and the provider's clock is not ours. A repository an operator made by
 * hand later than that is not ours, however empty it is (ADR-0465).
 */
export const INTENT_SETTLE_MARGIN_SECONDS = 60;

/**
 * True when this Migration's ledger shows that the framework created `record` (LIF-031, LIF-077:
 * rollback deletes what the framework created, so a doubt must resolve to "not ours").
 * - A recorded, non-adopted creation of exactly this repository (by provider id) is proof.
 * - An unsettled create intent for the name (a cancelled or crashed Run, response lost) counts
 *   only when the repository is empty and the provider created it no earlier than the intent was
 *   written (provider times have second resolution) and no later than the Run's last recorded
 *   activity (its latest Step that was not skipped by the end of the Run; `finished_at` caps it, and
 *   a reaper that ends an abandoned Run late must not widen the window) plus
 *   `INTENT_SETTLE_MARGIN_SECONDS`. A Run still running has no end. A repository an operator made
 *   by hand and filled is never ours, whatever intent is open; one made by hand and left empty
 *   after the Run ended is not ours either.
 */
export async function ledgerShowsCreation(
  db: Db,
  migrationId: string,
  record: RepositoryRecord,
  empty: boolean,
): Promise<boolean> {
  if (await creationRecorded(db, migrationId, record)) return true;
  if (!empty || record.createdAt === undefined) return false;
  const intents = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app.mutation m JOIN app.run r ON r.id = m.run_id
    WHERE m.migration_id = ${migrationId} AND m.side = 'target' AND m.action = 'create'
      AND m.state = 'intended' AND m.resource_ref->>'kind' = ${REPOSITORY_KIND}
      AND coalesce(m.resource_ref->>'adopted', 'false') <> 'true'
      AND lower(m.resource_ref->>'name') = ${record.name.toLowerCase()}
      AND date_trunc('second', m.created_at) <= ${record.createdAt}
      AND (r.finished_at IS NULL
           OR ${record.createdAt} <= LEAST(
                r.finished_at,
                GREATEST(
                  m.created_at,
                  coalesce((SELECT max(s.updated_at) FROM app.run_step s
                             WHERE s.run_id = r.id AND s.status <> 'skipped'), m.created_at))
              ) + make_interval(secs => ${INTENT_SETTLE_MARGIN_SECONDS}))`;
  return (intents[0]?.n ?? 0) > 0;
}

/**
 * Nothing holds the name now, so an unsettled create intent for it from an earlier Run did not
 * create anything that is still there: it is settled `not_applied` before a new create is made, so
 * it cannot later vouch for a repository somebody else makes (LIF-077).
 */
async function settleStaleCreateIntents(
  ctx: MigrationContext,
  world: RunWorld,
  name: string,
): Promise<void> {
  const now = (ctx.services.now ?? (() => new Date()))();
  await ctx.transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE app.mutation SET state = 'not_applied', updated_at = ${now}
      WHERE migration_id = ${world.migrationId} AND side = 'target' AND action = 'create'
        AND state = 'intended' AND run_id <> ${ctx.run.id}
        AND resource_ref->>'kind' = ${REPOSITORY_KIND}
        AND lower(resource_ref->>'name') = ${name.toLowerCase()}`;
  });
}

async function blockAndFail(
  ctx: MigrationContext,
  code: 'target.owned-by-other-migration' | 'target.exists-nonempty',
  name: string,
): Promise<never> {
  await ctx.findings.addBlocker({ code, params: { name } });
  throw new StepFailure(code, `The target repository ${name} cannot be used by this Migration`);
}

/**
 * Step 3: creates the target repository with the planned name, visibility and description, or
 * adopts an existing one: an empty one automatically (LIF-031, Q12), a non-empty one only with the
 * Run option `adoptNonEmpty`, whose typed confirmation was checked when the Run was created
 * (LIF-043). Records `targetRepositoryId` and `targetCreatedByFramework` and upserts the target
 * `Repository` row at once.
 */
export function ensureRepositoryStep(): StepDefinition<MigrationServices> {
  return {
    key: 'target.ensure-repository',
    severity: 'fatal',
    // LIF-049: the Step passed, so the blockers it raised are gone.
    clearsBlockers: ['target.exists-nonempty', 'target.owned-by-other-migration'],
    async run(ctx): Promise<StepResult> {
      const world = await loadRunWorld(ctx);
      // One Migration at a time looks up, creates and claims a given name on the target, so a
      // repository created here cannot be claimed by another Migration before this one claims it.
      return withSessionLock(
        ctx.services.pool,
        `target-name:${world.targetEndpointId}:${world.plannedName.toLowerCase()}`,
        () => ensure(ctx, world),
        { signal: ctx.signal },
      );
    },
  };
}

async function ensure(ctx: MigrationContext, world: RunWorld): Promise<StepResult> {
  {
    const target = await connectSide(ctx, world.targetEndpointId, world.targetType);
    const inventory = target.connection.inventory;
    const write = { side: 'target', origin: 'desired' } as const;

    // A resumed Step reconciles what a dead worker left open before it does anything (ADR-0342).
    // A repository found now is ours only by the same test as in `adopt`: a foreign one that
    // appeared meanwhile settles the intent `not_applied` and is judged below.
    for (const intent of await ctx.ledger.openIntents()) {
      if (intent.resourceRef.kind === REPOSITORY_KIND && intent.action === 'create') {
        const found = await inventory.findRepository(world.targetNamespaceRef, world.plannedName);
        const ours =
          found !== null &&
          (await ledgerShowsCreation(
            ctx.services.db,
            world.migrationId,
            found,
            await target.connection.repositories.isEmpty({
              providerId: found.providerId,
              namespace: world.targetNamespaceRef,
              slug: found.slug,
            }),
          ));
        if (found && ours)
          await ctx.ledger.confirm(
            intent.id,
            'applied',
            createdRecord(found, world.targetEndpointId),
          );
        else await ctx.ledger.confirm(intent.id, 'not_applied');
      } else {
        await ctx.ledger.confirm(intent.id, 'applied');
      }
    }

    const row = await ctx.services.db.migration.findUniqueOrThrow({
      where: { id: world.migrationId },
      select: { targetCreatedByFramework: true, targetRepository: true },
    });
    let existing: RepositoryRecord | null = null;
    let owned = false;
    if (row.targetRepository) {
      existing = await inventory.getRepository({
        providerId: row.targetRepository.providerId,
        namespace: world.targetNamespaceRef,
        slug: row.targetRepository.slug,
      });
      owned = existing !== null;
    }
    existing ??= await inventory.findRepository(world.targetNamespaceRef, world.plannedName);

    if (existing && owned) {
      // Ours already (resync, or a resumed Run): refresh the row, change nothing on the target.
      await claimOrBlock(ctx, world, existing, row.targetCreatedByFramework);
      return { status: 'succeeded' };
    }
    if (existing) return adopt(ctx, world, target, existing, row.targetCreatedByFramework);

    // Not there: create it. The intent comes first, so a lost response leaves a trace.
    await settleStaleCreateIntents(ctx, world, world.plannedName);
    const settings = world.facets.get('repository-settings')?.desired as
      | { visibility?: 'private' | 'public'; description?: string }
      | undefined;
    const spec = {
      name: world.plannedName,
      visibility: settings?.visibility ?? 'private',
      description: settings?.description ?? '',
    } as const;
    const intentId = await ctx.ledger.intend(write, {
      facetKey: null,
      action: 'create',
      resourceRef: { kind: REPOSITORY_KIND, name: spec.name, endpointId: world.targetEndpointId },
      paths: [],
      before: null,
      after: { name: spec.name, isPrivate: spec.visibility === 'private' },
    });
    let created: RepositoryRecord;
    try {
      created = await target.connection.repositories.create(world.targetNamespaceRef, spec);
    } catch (error) {
      if (isAdapterError(error) && error.code === 'conflict') {
        // Taken between the lookup and the create. Whoever holds the name is judged as above.
        await ctx.ledger.confirm(intentId, 'not_applied');
        const racing = await inventory.findRepository(world.targetNamespaceRef, world.plannedName);
        if (racing) return adopt(ctx, world, target, racing, row.targetCreatedByFramework);
      }
      // A timeout or a crash may have created it: the intent stays open for the retry to settle.
      throw error;
    }
    await ctx.ledger.confirm(intentId, 'applied', createdRecord(created, world.targetEndpointId));
    await claimOrBlock(ctx, world, created, true);
    return { status: 'succeeded' };
  }
}

async function claimOrBlock(
  ctx: MigrationContext,
  world: RunWorld,
  record: RepositoryRecord,
  createdByFramework: boolean,
): Promise<void> {
  try {
    await claimTarget(ctx, world, record, createdByFramework);
  } catch (error) {
    if (error instanceof ClaimedElsewhere) {
      return blockAndFail(ctx, 'target.owned-by-other-migration', record.name);
    }
    throw error;
  }
}

/** LIF-031: an empty target is adopted; a non-empty one needs `adoptNonEmpty`. */
async function adopt(
  ctx: MigrationContext,
  world: RunWorld,
  target: Side,
  existing: RepositoryRecord,
  createdBefore: boolean,
): Promise<StepResult> {
  const ref = {
    providerId: existing.providerId,
    namespace: world.targetNamespaceRef,
    slug: existing.slug,
  };
  // Another Migration's claim is the more telling reason, whatever has been pushed since.
  const heldBy = await ctx.services.db.migration.findFirst({
    where: {
      id: { not: world.migrationId },
      targetRepository: {
        endpointId: world.targetEndpointId,
        providerId: existing.providerId,
      },
    },
    select: { id: true },
  });
  if (heldBy) return blockAndFail(ctx, 'target.owned-by-other-migration', existing.name);
  const empty = await target.connection.repositories.isEmpty(ref);
  if (!empty && !world.adoptNonEmpty) {
    return blockAndFail(ctx, 'target.exists-nonempty', existing.name);
  }
  // A repository this Migration created in an earlier attempt whose claim was never saved is ours.
  const recorded = await creationRecorded(ctx.services.db, world.migrationId, existing);
  const proven =
    createdBefore ||
    recorded ||
    (await ledgerShowsCreation(ctx.services.db, world.migrationId, existing, empty));
  await claimOrBlock(ctx, world, existing, proven);
  if (!proven) {
    await ctx.ledger.record({ side: 'target', origin: 'desired' }, [
      adoptedRecord(existing, !empty),
    ]);
    await ctx.runLog(
      'info',
      empty
        ? 'Adopted an empty target repository (target.exists-foreign-adopted)'
        : 'Force-adopted a non-empty target repository (adoptNonEmpty)',
      { name: existing.name },
    );
  } else if (!createdBefore && !recorded) {
    // Proven by an unsettled intent: record the creation, so the ledger says what rollback will do.
    await ctx.ledger.record({ side: 'target', origin: 'desired' }, [
      createdRecord(existing, world.targetEndpointId),
    ]);
  }
  return { status: 'succeeded' };
}

// -- step 3a --------------------------------------------------------------------------------------

/** What the Analysis put in a document, or an empty list. */
const listOf = (world: RunWorld, facet: string, field: string): unknown[] => {
  const value = world.facets.get(facet)?.desired[field];
  return Array.isArray(value) ? value : [];
};

/** Framework branches (LIF-047) a rule must not block either. */
const FRAMEWORK_BRANCH_PROBES = ['git-migrator/ci', 'git-migrator/codeowners'];

const shortBranch = (name: string): string => name.replace(/^refs\/heads\//, '');

/**
 * The branches this Run is about to write on the target: those the source has that the target
 * lacks or has at another commit, with `adoptNonEmpty` also the target branches the reconcile
 * deletes, and the framework's branches when a Change Request will be opened. A rule matching
 * only branches that stay as they are is left alone.
 */
export function branchesAboutToChange(
  world: RunWorld,
  targetRefs: readonly { name: string; kind: string; target: string }[],
): string[] {
  const wanted = (
    listOf(world, 'git-refs', 'refs') as { name: string; kind: string; target: string }[]
  ).filter((r) => r.kind === 'branch');
  const have = new Map(targetRefs.map((r) => [r.name, r.target]));
  const names = wanted.filter((r) => have.get(r.name) !== r.target).map((r) => shortBranch(r.name));
  if (world.adoptNonEmpty) {
    const wantedNames = new Set(wanted.map((r) => r.name));
    for (const r of targetRefs) {
      if (r.kind === 'branch' && !wantedNames.has(r.name)) names.push(shortBranch(r.name));
    }
  }
  const deliversChangeRequest =
    listOf(world, 'pipelines', 'files').length > 0 ||
    listOf(world, 'code-ownership', 'owners').length > 0;
  if (deliversChangeRequest) names.push(...FRAMEWORK_BRANCH_PROBES);
  return names;
}

/**
 * Step 3a: when the target already has protection rules (resync, adoption), deletes the rules that
 * match a ref about to be pushed, and the rules matching `git-migrator/*` branches, each recorded
 * as a Mutation. Step 10 creates the desired rules again. A rule that matches nothing stays.
 */
export function liftProtectionStep(): StepDefinition<MigrationServices> {
  return {
    key: 'target.lift-protection',
    severity: 'fatal',
    async run(ctx): Promise<StepResult> {
      const world = await loadRunWorld(ctx);
      const target = await connectSide(ctx, world.targetEndpointId, world.targetType);
      const driver = target.connection.facets['branch-rules'];
      if (!driver?.apply)
        return { status: 'skipped', reason: 'the target cannot write branch rules' };
      const { ref } = await targetOf(ctx, world);
      const facetTarget = repositoryTarget(world, ref);

      await recoverOpenIntents(ctx, target, facetTarget);
      const current = (await driver.read(target.driver, facetTarget)).data as {
        rules: { pattern: string }[];
      };
      const refsDriver = target.connection.facets['git-refs'];
      const targetRefs = refsDriver
        ? (
            (await refsDriver.read(target.driver, facetTarget)).data as {
              refs: { name: string; kind: string; target: string }[];
            }
          ).refs
        : [];
      const names = branchesAboutToChange(world, targetRefs);
      const lifted = current.rules.filter((rule) =>
        names.some((name) => branchPatternMatches(rule.pattern, name)),
      );
      if (lifted.length === 0) {
        return { status: 'skipped', reason: 'no protection rule matches a branch about to change' };
      }
      const keep = { ...current, rules: current.rules.filter((r) => !lifted.includes(r)) };
      const write = { side: 'target', origin: 'desired' } as const;
      const intentId = await ctx.ledger.intend(write, {
        facetKey: 'branch-rules',
        action: 'delete',
        // The rules before and after the lift: a resumed Step recovers a deletion whose record was lost.
        resourceRef: { kind: 'lift-protection', noop: true, meant: keep as never },
        paths: [],
        before: current,
        after: current,
      });
      await ctx.ledger.recordAll(
        write,
        driver.apply(target.driver, facetTarget, keep, current, []),
      );
      await ctx.ledger.confirm(intentId, 'applied');
      await ctx.runLog('info', `Lifted ${lifted.length} protection rule(s) for the push`, {
        patterns: lifted.map((r) => r.pattern),
      });
      return { status: 'succeeded' };
    },
  };
}

/**
 * A fatal Step failed after step 3a lifted protection rules: the target is left without them
 * until step 10 runs again. A run-origin post task names them (LIF-049); nothing re-applies them
 * automatically (ADR-0380).
 */
export async function warnIfProtectionLifted(ctx: MigrationContext): Promise<void> {
  const rows = await ctx.services.db.$queryRaw<{ paths: string[] }[]>`
    SELECT paths FROM app.mutation
    WHERE run_id = ${ctx.run.id} AND side = 'target' AND facet_key = 'branch-rules'
      AND action = 'delete' AND state <> 'not_applied'
      AND coalesce(resource_ref->>'noop', 'false') <> 'true'`;
  const patterns = [
    ...new Set(
      rows.flatMap((r) =>
        r.paths.flatMap((p) => {
          const key = parseFieldPath(p)[0]?.key?.value;
          return key === undefined ? [] : [key];
        }),
      ),
    ),
  ].sort();
  if (patterns.length === 0) return;
  await ctx.findings.addTask({
    code: 'branch-rules.protection-lifted',
    facetKey: 'branch-rules',
    phase: 'post',
    params: { paths: patterns },
  });
}
