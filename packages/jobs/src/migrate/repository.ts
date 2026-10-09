/**
 * LIF-040 steps 3 and 3a: `target.ensure-repository` (create or adopt, LIF-031) and
 * `target.lift-protection`. Every provider write has an intent in the ledger before it is made and
 * a confirmation after it, so a worker that dies in between leaves a record rollback can find
 * (ADR-0342). Decisions: docs/adr/0380-migration-steps.md.
 */
import { isAdapterError, type RepositoryRecord } from '@git-migrator/adapter-sdk';
import { StepFailure } from '../run/errors.ts';
import type { MutationLike, StepDefinition, StepResult } from '../run/types.ts';
import { branchPatternMatches } from './glob.ts';
import {
  connectSide,
  type MigrationContext,
  type MigrationServices,
  type Side,
} from './services.ts';
import { loadRunWorld, type RunWorld, repositoryRow, repositoryTarget, targetOf } from './world.ts';

const REPOSITORY_KIND = 'repository';

const snapshotOf = (record: RepositoryRecord) => ({
  name: record.name,
  isPrivate: record.isPrivate,
  defaultBranch: record.defaultBranch ?? null,
});

/** The ledger record of a repository this Run created (rollback deletes it, LIF-077). */
const createdRecord = (record: RepositoryRecord): MutationLike => ({
  facetKey: null,
  action: 'create',
  resourceRef: { kind: REPOSITORY_KIND, id: record.providerId, name: record.name },
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
  ctx.services.links.note(record.providerId, world.migrationId);
}

/** True when this Migration's ledger holds a creation of the repository by the framework. */
async function ledgerShowsCreation(
  ctx: MigrationContext,
  world: RunWorld,
  providerId: string,
): Promise<boolean> {
  const rows = await ctx.services.db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app.mutation
    WHERE migration_id = ${world.migrationId} AND side = 'target' AND action = 'create'
      AND state <> 'not_applied' AND resource_ref->>'kind' = ${REPOSITORY_KIND}
      AND resource_ref->>'id' = ${providerId}
      AND coalesce(resource_ref->>'adopted', 'false') <> 'true'`;
  return (rows[0]?.n ?? 0) > 0;
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
    async run(ctx): Promise<StepResult> {
      const world = await loadRunWorld(ctx);
      const target = await connectSide(ctx, world.targetEndpointId, world.targetType);
      const inventory = target.connection.inventory;
      const write = { side: 'target', origin: 'desired' } as const;

      // A resumed Step reconciles what a dead worker left open before it does anything (ADR-0342).
      for (const intent of await ctx.ledger.openIntents()) {
        if (intent.resourceRef.kind === REPOSITORY_KIND && intent.action === 'create') {
          const found = await inventory.findRepository(world.targetNamespaceRef, world.plannedName);
          if (found) await ctx.ledger.confirm(intent.id, 'applied', createdRecord(found));
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
        resourceRef: { kind: REPOSITORY_KIND, name: spec.name },
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
          const racing = await inventory.findRepository(
            world.targetNamespaceRef,
            world.plannedName,
          );
          if (racing) return adopt(ctx, world, target, racing, row.targetCreatedByFramework);
        }
        // A timeout or a crash may have created it: the intent stays open for the retry to settle.
        throw error;
      }
      await ctx.ledger.confirm(intentId, 'applied', createdRecord(created));
      await claimOrBlock(ctx, world, created, true);
      return { status: 'succeeded' };
    },
  };
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
  const empty = await target.connection.repositories.isEmpty(ref);
  if (!empty && !world.adoptNonEmpty) {
    return blockAndFail(ctx, 'target.exists-nonempty', existing.name);
  }
  // A repository this Migration created in an earlier attempt whose claim was never saved is ours.
  const createdByUs = createdBefore || (await ledgerShowsCreation(ctx, world, existing.providerId));
  await claimOrBlock(ctx, world, existing, createdByUs);
  if (!createdByUs) {
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
function branchesAboutToChange(
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

      for (const intent of await ctx.ledger.openIntents()) {
        await ctx.ledger.confirm(intent.id, 'applied');
      }
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
        resourceRef: { kind: 'lift-protection', noop: true },
        paths: [],
        before: null,
        after: null,
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
