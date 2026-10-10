/**
 * The Steps of a `rollback` Run (LIF-077). The source is never touched: its lock is undone first by
 * an `undo_source_read_only` Run (the guard refuses a rollback until then), and a rollback reverts
 * only what the framework did to the target.
 *
 * 1. `rollback.target`: a target repository the framework created is deleted, after the ledger
 *    proves it (the creation record by provider id, or an open create intent that the repository
 *    fits in time and emptiness, T-071); an adopted target is left standing and the framework's
 *    other writes are reverted newest first, one record at a time, each marked undone as it goes.
 *    Git refs are left as they are on an adopted target.
 * 2. `rollback.group-mappings` (endpoint Runs): the Group Mappings of undone teams go back to
 *    `unmapped`.
 * 3. `rollback.settle`: re-reads the ledger under the Migration lock (a late write of an earlier
 *    Run could have landed meanwhile, ADR-0342), fails if anything is left to revert, and releases
 *    the deleted repository from the Migration.
 *
 * Decisions: docs/adr/0465-rollback.md.
 */
import {
  type DriverContext,
  type EndpointConnection,
  type FacetTarget,
  isAdapterError,
  type MutationRecord,
  type NamespaceRef,
  type RepositoryRecord,
  type RepositoryRef,
  type UndoLeftEntry,
} from '@git-migrator/adapter-sdk';
import { hashCanonical } from '@git-migrator/core';
import { markAnalysesStale } from '@git-migrator/db';
import { noGitClient } from '../inventory/connector.ts';
import { creationRecorded, ledgerShowsCreation } from '../migrate/repository.ts';
import type { MigrationContext, MigrationServices } from '../migrate/services.ts';
import { StepFailure } from '../run/errors.ts';
import { recomputeReadiness } from '../run/findings.ts';
import { teamsInUse } from '../run/guard.ts';
import { REPOSITORY_LEVEL_FACET } from '../run/ledger.ts';
import { loadPlacement, placementOutside } from '../run/placement.ts';
import type { RunPlanner, StepDefinition, StepResult } from '../run/types.ts';
import { unmapUndoneTeams } from './endpoint.ts';
import {
  dispositionOf,
  type LedgerRow,
  ledgerRows,
  remainingTargetRecords,
  undoableOf,
} from './ledger.ts';

export const ROLLBACK_TARGET_STEP = 'rollback.target';
export const ROLLBACK_GROUP_MAPPINGS_STEP = 'rollback.group-mappings';
export const ROLLBACK_SETTLE_STEP = 'rollback.settle';

/** The run-origin post task for a repository the organization does not let the framework delete. */
export const DELETION_FORBIDDEN = 'repository-settings.deletion-forbidden';
/** The run-origin post task when the provider cannot tell whether the target still exists. */
export const TARGET_UNREADABLE = 'repository-settings.target-unreadable';
export const LEFT_IN_PLACE = 'repository-settings.left-in-place';
export const DELETION_UNPROVEN = 'repository-settings.deletion-unproven';

interface RollbackWorld {
  readonly migrationId: string;
  readonly routeId: string;
  readonly scope: 'repository' | 'endpoint';
  readonly sourceEndpointId: string;
  /** Where the target is: the target repository's Endpoint, or the Route's when there is none. */
  readonly targetEndpointId: string;
  readonly namespace: NamespaceRef | undefined;
  readonly targetRepository:
    | {
        readonly id: string;
        readonly providerId: string;
        readonly slug: string;
        readonly fullPath: string;
      }
    | undefined;
  readonly createdByFramework: boolean;
  /** The framework's target is not where the Route points any more (ADR-0504). */
  readonly outsideRoute: boolean;
}

/** Exported for tests. */
export async function loadWorld(ctx: MigrationContext): Promise<RollbackWorld> {
  const m = await ctx.services.db.migration.findUniqueOrThrow({
    where: { id: ctx.migration.id },
    include: { route: true, targetRepository: { include: { namespace: true } } },
  });
  // The target is reverted where the framework wrote it: a repository Migration's target
  // repository on its own Endpoint and in its own Namespace, an endpoint Migration's pinned
  // Namespace. Neither is the Route's when the Route was retargeted afterwards (ADR-0504). The
  // guard refuses a rollback whose Endpoints are no longer configured.
  const repo = m.scope === 'repository' ? m.targetRepository : null;
  const pinned = await loadPlacement(ctx.services.db, m.id);
  const placed = repo
    ? { endpointId: repo.endpointId, namespace: repo.namespace }
    : pinned
      ? { endpointId: pinned.endpointId, namespace: pinned.namespace }
      : null;
  const namespace = placed
    ? placed.namespace
    : m.route.targetNamespaceId
      ? await ctx.services.db.namespace.findUnique({ where: { id: m.route.targetNamespaceId } })
      : null;
  return {
    migrationId: m.id,
    routeId: m.routeId,
    scope: m.scope,
    sourceEndpointId: m.route.sourceEndpointId,
    targetEndpointId: placed?.endpointId ?? m.route.targetEndpointId,
    namespace: namespace ? { providerId: namespace.providerId, slug: namespace.slug } : undefined,
    targetRepository: m.targetRepository
      ? {
          id: m.targetRepository.id,
          providerId: m.targetRepository.providerId,
          slug: m.targetRepository.slug,
          fullPath: m.targetRepository.fullPath,
        }
      : undefined,
    createdByFramework: m.targetCreatedByFramework,
    outsideRoute: placementOutside(pinned, m.route),
  };
}

/**
 * The Run is about to change the target. LIF-002: a cancelled Run that "recorded a Mutation" leaves
 * the Migration `partial`, and a rollback's undo is not a ledger row, so it says so here, before the
 * change: a cancel that lands halfway then does not return the Migration to a status the target no
 * longer has.
 */
async function noteChanging(ctx: MigrationContext): Promise<void> {
  await ctx.transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE app.run SET has_mutations = true, updated_at = clock_timestamp()
      WHERE id = ${ctx.run.id} AND NOT has_mutations`;
  });
}

/** Marks records undone, one transaction each, so a crash repeats at most one revert (idempotent). */
async function markUndone(ctx: MigrationContext, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await ctx.transaction(async (tx) => {
      // An intent that was never confirmed was treated as possibly applied and is now reverted.
      await tx.$executeRaw`
        UPDATE app.mutation
        SET undone_at = clock_timestamp(), updated_at = clock_timestamp(),
            state = CASE WHEN state = 'intended' THEN 'recorded' ELSE state END
        WHERE id = ${id} AND undone_at IS NULL`;
    });
  }
}

/** An unconfirmed create intent that turned out to have created nothing of ours. */
async function settleNotApplied(ctx: MigrationContext, id: string): Promise<void> {
  await ctx.transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE app.mutation SET state = 'not_applied', updated_at = clock_timestamp()
      WHERE id = ${id} AND state = 'intended'`;
  });
}

const toRecord = (row: LedgerRow): MutationRecord => ({
  facetKey: row.facetKey === REPOSITORY_LEVEL_FACET ? null : row.facetKey,
  action: row.action as MutationRecord['action'],
  resourceRef: row.resourceRef,
  paths: [...row.paths],
  before: row.before,
  after: row.after,
});

/** What the deletion of a repository came to. */
type Deletion = 'deleted' | 'gone';

/**
 * The target cannot be told apart from "not visible to this credential": nothing is marked undone
 * and the Run fails with guidance (ADR-0465 round 2).
 */
async function failUnreadable(
  ctx: MigrationContext,
  fullName: string,
  why: string,
): Promise<never> {
  await ctx.findings.addTask({
    code: TARGET_UNREADABLE,
    facetKey: 'repository-settings',
    phase: 'post',
    params: { repository: fullName },
  });
  throw new StepFailure(
    TARGET_UNREADABLE,
    `${why}. ${fullName} may still exist, so nothing was reverted or released; check the installation's access to the repository, then roll back again`,
  );
}

/**
 * The repository by its provider id, wherever it is named now: the record, or `null` only when the
 * provider positively says it is gone. A 404 by name is not that: the repository may be renamed, or
 * invisible to the credential.
 */
async function lookupById(
  ctx: MigrationContext,
  connection: EndpointConnection,
  providerId: string,
  fullName: string,
): Promise<RepositoryRecord | null> {
  if (!connection.inventory.findRepositoryById) {
    return failUnreadable(ctx, fullName, 'The provider cannot look a repository up by its id');
  }
  try {
    return await connection.inventory.findRepositoryById(providerId);
  } catch (error) {
    if (
      isAdapterError(error) &&
      (error.code === 'forbidden' || error.code === 'not_found' || error.code === 'conflict')
    ) {
      return failUnreadable(ctx, fullName, 'The provider cannot say whether the repository exists');
    }
    throw error;
  }
}

/**
 * Deletes `ref`. The adapter refuses without the provider id and when the name now holds another
 * repository (`conflict`), so a repository somebody made under the same name is never deleted. When
 * the name does not hold ours, it is looked up by id: renamed, it is deleted under its current
 * name (the id is checked again); positively gone, it is gone; anything else fails the Run. A
 * provider that does not let the framework delete fails the Run with guidance (LIF-077).
 */
async function deleteRepository(
  ctx: MigrationContext,
  connection: EndpointConnection,
  ref: RepositoryRef,
  fullName: string,
  retried = false,
): Promise<Deletion> {
  try {
    await noteChanging(ctx);
    await connection.repositories.delete(ref);
    return 'deleted';
  } catch (error) {
    if (isAdapterError(error)) {
      if (error.code === 'not_found' || error.code === 'conflict') {
        const now = await lookupById(ctx, connection, ref.providerId, fullName);
        if (now === null) return 'gone';
        if (retried || now.slug === ref.slug) {
          return failUnreadable(ctx, fullName, 'The repository cannot be deleted under its name');
        }
        return deleteRepository(
          ctx,
          connection,
          { ...ref, slug: now.slug },
          `${ref.namespace.slug}/${now.slug}`,
          true,
        );
      }
      if (error.code === 'forbidden' || error.code === 'blocked_by_provider') {
        await ctx.findings.addTask({
          code: DELETION_FORBIDDEN,
          facetKey: 'repository-settings',
          phase: 'post',
          params: { repository: fullName },
        });
        throw new StepFailure(
          DELETION_FORBIDDEN,
          `The provider does not let the framework delete ${fullName}. Allow the framework to delete repositories in the target Namespace, or delete it by hand, then roll back again`,
        );
      }
    }
    throw error;
  }
}

/** True when another Migration has this repository as its target or recorded creating or adopting it. */
export async function repositoryHeldElsewhere(
  db: MigrationContext['services']['db'],
  migrationId: string,
  endpointId: string,
  providerId: string,
): Promise<boolean> {
  const other = await db.migration.findFirst({
    where: {
      id: { not: migrationId },
      targetRepository: { endpointId, providerId },
    },
    select: { id: true },
  });
  if (other) return true;
  const recorded = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app.mutation
    WHERE migration_id <> ${migrationId} AND side = 'target' AND action = 'create'
      AND state = 'recorded' AND resource_ref->>'kind' = 'repository'
      AND resource_ref->>'id' = ${providerId}`;
  return (recorded[0]?.n ?? 0) > 0;
}

/**
 * `lookupById` for a repository an earlier Run created, which is not this Migration's target. It is
 * looked up on the Endpoint its `Repository` row names, which is another one than the target's when
 * the Route was retargeted to another Endpoint in between (ADR-0504): a credential of one Endpoint
 * cannot see another's repositories, so asking the wrong one would read as "unreadable".
 */
async function lookupEarlier(
  ctx: MigrationContext,
  world: RollbackWorld,
  connection: EndpointConnection,
  providerId: string,
  fullName: string,
  /** The Endpoint the create record names (records written since ADR-0504 do). */
  recordedEndpointId?: string,
): Promise<RepositoryRecord | null> {
  let endpointId = recordedEndpointId;
  if (endpointId === undefined) {
    const rows = await ctx.services.db.repository.findMany({
      where: { providerId, endpointId: { not: world.sourceEndpointId } },
      select: { endpointId: true },
    });
    endpointId = rows.some((r) => r.endpointId === world.targetEndpointId)
      ? world.targetEndpointId
      : rows[0]?.endpointId;
  }
  if (endpointId === undefined) {
    // Asking the target's Endpoint could answer "not found" for a repository that lives elsewhere.
    throw new StepFailure(
      'rollback.endpoint-unknown',
      `The ledger does not say on which Endpoint ${fullName} was created, and no repository row records it, so nothing more is reverted. Delete ${fullName} by hand if it still exists, then contact an administrator to settle its creation record`,
      { repository: fullName },
    );
  }
  const where =
    endpointId === world.targetEndpointId
      ? connection
      : await ctx.services.connector.connect(endpointId, {
          pool: 'interactive',
          signal: ctx.signal,
        });
  return lookupById(ctx, where, providerId, fullName);
}

/** The Endpoint a repository create record names, if it names one. */
const recordedEndpoint = (row: LedgerRow): string | undefined =>
  typeof row.resourceRef.endpointId === 'string' ? row.resourceRef.endpointId : undefined;

/** A repository an earlier Run created, which still exists and is not this Migration's target. */
const leftRepository = (slug: string): UndoLeftEntry => ({
  kind: 'repository-earlier',
  name: slug,
});

/**
 * After the Migration's own target was deleted: the recorded creations of OTHER repositories (an
 * earlier Run created them, and the target moved on, for example after the Route was retargeted)
 * are checked by provider id, as on an adopted target. One that still exists is left and reported,
 * together with the records written between its creation and the deleted target's creation, which
 * went to it and not to the deleted repository. One the provider says is gone is undone with the
 * rest (ADR-0504).
 */
async function earlierRepositoriesLeft(
  ctx: MigrationContext,
  world: RollbackWorld,
  connection: EndpointConnection,
  deletedProviderId: string,
  rows: readonly LedgerRow[],
): Promise<{ ids: Set<string>; lefts: UndoLeftEntry[] }> {
  const isCreation = (row: LedgerRow) =>
    dispositionOf(row) === 'repository' && row.state === 'recorded';
  const deletedAt = rows.find(
    (r) => isCreation(r) && String(r.resourceRef.id ?? '') === deletedProviderId,
  )?.seq;
  const ids = new Set<string>();
  const lefts: UndoLeftEntry[] = [];
  let firstLeft: bigint | undefined;
  for (const row of rows) {
    const id = String(row.resourceRef.id ?? '');
    if (!isCreation(row) || id === '' || id === deletedProviderId) continue;
    ctx.checkpoint();
    const still = await lookupEarlier(
      ctx,
      world,
      connection,
      id,
      String(row.resourceRef.name ?? id),
      recordedEndpoint(row),
    );
    if (still === null) continue;
    ids.add(row.id);
    lefts.push(leftRepository(still.slug));
    if (firstLeft === undefined || row.seq < firstLeft) firstLeft = row.seq;
  }
  if (firstLeft !== undefined) {
    const from = firstLeft;
    for (const row of rows) {
      if (isCreation(row) || row.seq <= from) continue;
      if (deletedAt === undefined || row.seq < deletedAt) ids.add(row.id);
    }
  }
  return { ids, lefts };
}

/** How many entries a `left-in-place` task and failure name. */
const MAX_LEFT = 20;

/** The note on a `left-in-place` task that a later rollback replaced (ADR-0465 round 4). */
export const LEFT_IN_PLACE_SUPERSEDED = 'superseded by a later rollback';

/**
 * Keeps at most one open run-origin `left-in-place` task per Migration, with the current list: an
 * open one with another list is dismissed (by no Actor, as the Analysis dismisses obsolete tasks),
 * and the one whose params hash is `keep` is reopened if this rule dismissed it earlier. `keep`
 * null dismisses them all: the rollback left nothing (ADR-0465 round 4).
 */
async function settleLeftInPlaceTasks(ctx: MigrationContext, keep: string | null): Promise<void> {
  await ctx.transaction(
    async (tx) => {
      const tasks = await tx.manualTask.findMany({
        where: { migrationId: ctx.migration.id, code: LEFT_IN_PLACE, origin: 'run' },
        select: { id: true, status: true, paramsHash: true, completedById: true },
      });
      let changed = false;
      for (const task of tasks) {
        if (task.paramsHash === keep) {
          if (task.status === 'dismissed' && task.completedById === null) {
            await tx.manualTask.update({
              where: { id: task.id },
              data: { status: 'open', completedAt: null, note: null },
            });
            changed = true;
          }
        } else if (task.status === 'open') {
          await tx.manualTask.update({
            where: { id: task.id },
            data: {
              status: 'dismissed',
              note: LEFT_IN_PLACE_SUPERSEDED,
              completedAt: new Date(),
              completedById: null,
            },
          });
          changed = true;
        }
      }
      if (changed) await recomputeReadiness(tx, ctx.migration.id);
    },
    { migration: true },
  );
}

/**
 * Raises the post task that tells the operator what to do by hand, in place of the one an earlier
 * rollback raised, and builds the failure. The entries are structured: guidance renders each kind
 * in the glossary's terms (GLO-002).
 */
async function leftInPlace(
  ctx: MigrationContext,
  lefts: readonly UndoLeftEntry[],
): Promise<StepFailure> {
  const details = lefts.slice(0, MAX_LEFT).map((l) => ({ kind: l.kind, name: l.name }));
  const params = { details };
  await ctx.findings.addTask({
    code: LEFT_IN_PLACE,
    facetKey: 'repository-settings',
    phase: 'post',
    params,
  });
  await settleLeftInPlaceTasks(ctx, hashCanonical(params));
  return new StepFailure(
    'rollback.left-in-place',
    `${lefts.length} change(s) were left as they are because they are no longer provably the framework's: ${details.map((d) => `${d.kind} ${d.name}`).join('; ')}`,
    { left: details },
  );
}

/** True when a write was answered with a redirect: the repository moved under the rollback. */
function isRedirect(error: unknown): boolean {
  const status = isAdapterError(error) ? error.request?.status : undefined;
  return status !== undefined && status >= 300 && status < 400;
}

/** A write answered `not_found`: on an adopted target, the repository itself may be gone. */
function isNotFound(error: unknown): boolean {
  return isAdapterError(error) && error.code === 'not_found';
}

/** Thrown out of the revert loop when the target turns out to be gone from the organization. */
class TargetGone extends Error {}

/**
 * The provider says the adopted target is gone (deleted, or transferred out of the organization):
 * what the framework wrote went with it. Repositories an earlier Run created are other
 * repositories, so each is checked by id first; one that still exists is left and reported.
 */
async function settleGoneTarget(
  ctx: MigrationContext,
  world: RollbackWorld,
  connection: EndpointConnection,
  fullPath: string,
  tally: { undone: number; left: number; deleted: number },
): Promise<StepResult> {
  await ctx.runLog('info', 'The target repository no longer exists; nothing to revert', {
    repository: fullPath,
  });
  const rest = undoableOf(await ledgerRows(ctx.services.db, ctx.migration.id, 'target'));
  const gone: string[] = [];
  const stay: UndoLeftEntry[] = [];
  for (const row of rest) {
    if (dispositionOf(row) === 'repository' && row.state === 'recorded') {
      const id = String(row.resourceRef.id ?? '');
      const name = String(row.resourceRef.name ?? id);
      const still =
        id === ''
          ? null
          : await lookupEarlier(ctx, world, connection, id, name, recordedEndpoint(row));
      if (still !== null) {
        stay.push(leftRepository(still.slug));
        continue;
      }
    }
    gone.push(row.id);
  }
  await markUndone(ctx, gone);
  if (stay.length > 0) throw await leftInPlace(ctx, stay);
  await settleLeftInPlaceTasks(ctx, null);
  return { status: 'succeeded', detail: { ...tally, undone: tally.undone + gone.length } };
}

/** The provider id of the team a `teams` record names (a team, or a membership of one). */
function teamIdOf(row: LedgerRow): string | undefined {
  if (row.facetKey !== 'teams') return undefined;
  const { kind } = row.resourceRef;
  if (kind !== 'team' && kind !== 'team-membership') return undefined;
  const id = kind === 'team' ? row.resourceRef.id : row.resourceRef.teamId;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * Step 1. See the file comment. Everything here tolerates being repeated: a record is marked
 * undone only after its revert, and every revert accepts state that is already gone.
 */
export function rollbackTargetStep(): StepDefinition<MigrationServices> {
  return {
    key: ROLLBACK_TARGET_STEP,
    severity: 'fatal',
    async run(ctx): Promise<StepResult> {
      const { db, connector } = ctx.services;
      const world = await loadWorld(ctx);
      const connection = await connector.connect(world.targetEndpointId, {
        pool: 'interactive',
        signal: ctx.signal,
      });
      const driver: DriverContext = {
        http: connection.http,
        git: noGitClient,
        logger: ctx.log as never,
        pool: 'interactive',
        signal: ctx.signal,
      };
      const todo = undoableOf(await ledgerRows(db, world.migrationId, 'target'));
      const tally = { undone: 0, left: 0, deleted: 0 };

      // -- the repository -------------------------------------------------------------------
      let deletedWhole = false;
      if (world.scope === 'repository') {
        deletedWhole = await deleteCreatedRepository(ctx, world, connection, todo, tally);
      }
      if (deletedWhole && world.targetRepository) {
        // Everything else recorded for the repository went with it, except a repository an
        // earlier Run created that still exists (a Route retargeted between the Runs, ADR-0504),
        // and what was written to it: those are left and reported.
        const rest = undoableOf(await ledgerRows(db, world.migrationId, 'target'));
        const kept = await earlierRepositoriesLeft(
          ctx,
          world,
          connection,
          world.targetRepository.providerId,
          rest,
        );
        const gone = rest.filter((r) => !kept.ids.has(r.id)).map((r) => r.id);
        await markUndone(ctx, gone);
        tally.undone += gone.length;
        if (kept.lefts.length > 0) throw await leftInPlace(ctx, kept.lefts);
        await settleLeftInPlaceTasks(ctx, null);
        return { status: 'succeeded', detail: tally };
      }

      // -- an adopted target: revert the framework's writes, newest first -------------------
      const rest = undoableOf(await ledgerRows(db, world.migrationId, 'target'));
      if (rest.length === 0) {
        await settleLeftInPlaceTasks(ctx, null);
        return { status: 'succeeded', detail: tally };
      }
      let facetTarget: FacetTarget;
      let repoRef: RepositoryRef | undefined;
      if (world.scope === 'endpoint') {
        if (!world.namespace) {
          throw new StepFailure('rollback.target_missing', 'The target namespace is not resolved');
        }
        facetTarget = { scope: 'endpoint', namespace: world.namespace };
      } else {
        if (!world.targetRepository || !world.namespace) {
          throw new StepFailure(
            'rollback.target_missing',
            'The Migration has no target repository to revert, and its ledger holds writes to it',
          );
        }
        const live = await lookupById(
          ctx,
          connection,
          world.targetRepository.providerId,
          world.targetRepository.fullPath,
        );
        if (live === null) {
          return settleGoneTarget(ctx, world, connection, world.targetRepository.fullPath, tally);
        }
        repoRef = { providerId: live.providerId, namespace: world.namespace, slug: live.slug };
        facetTarget = { scope: 'repository', repository: repoRef, namespace: world.namespace };
      }

      const lefts: UndoLeftEntry[] = [];
      const target = world.targetRepository;
      /**
       * The repository moved after the lookup (renamed, transferred, deleted, or replaced by
       * another on its name). It is looked up again: gone from the organization, the rest went
       * with it; still there, the Run fails `target-unreadable` and nothing more is written.
       */
      const moved = async (): Promise<never> => {
        if (!target) throw new Error('moved() needs the target repository');
        const now = await lookupById(ctx, connection, target.providerId, target.fullPath);
        if (now === null) throw new TargetGone();
        return failUnreadable(
          ctx,
          target.fullPath,
          'The repository moved while the rollback reverted it',
        );
      };
      /**
       * Every write to an adopted target is preceded by a read of the name it goes to: the same
       * provider id in the organization, or the lookup again. A write that is still answered with
       * a redirect or `not_found` takes the same path, so it never ends in a bare `invalid` or
       * `not_found` (ADR-0465 rounds 4 and 5).
       */
      const writeToTarget = async <T>(write: () => Promise<T>): Promise<T> => {
        if (target && repoRef) {
          const now = await connection.inventory.getRepository(repoRef);
          if (now === null || now.providerId !== repoRef.providerId) return moved();
        }
        try {
          return await write();
        } catch (error) {
          if (!target || !(isRedirect(error) || isNotFound(error))) throw error;
          return moved();
        }
      };
      try {
        for (const row of rest) {
          ctx.checkpoint();
          const how = dispositionOf(row);
          if (how === 'left') {
            await markUndone(ctx, [row.id]);
            tally.left += 1;
          } else if (how === 'change-request') {
            const purpose = row.resourceRef.purpose;
            const writer = connection.changeRequests;
            if (!writer || !repoRef || typeof purpose !== 'string') {
              throw new StepFailure(
                'rollback.undo-unsupported',
                'A Change Request the framework opened cannot be closed by this provider',
              );
            }
            const ref = repoRef;
            await noteChanging(ctx);
            await writeToTarget(() => writer.close(ref, purpose));
            await markUndone(ctx, [row.id]);
            tally.undone += 1;
          } else if (how === 'driver') {
            const facet = connection.facets[row.facetKey as keyof typeof connection.facets];
            if (!facet?.undo) {
              throw new StepFailure(
                'rollback.undo-unsupported',
                `The ${row.facetKey} driver of this provider cannot revert what the framework wrote`,
                { facetKey: row.facetKey, kind: String(row.resourceRef.kind) },
              );
            }
            // The guard at admission is not enough: a grant may have been written since. A team in
            // use is left, and so are its memberships, which go before it (ADR-0465 rounds 3, 4).
            const teamId = teamIdOf(row);
            if (
              teamId !== undefined &&
              (await teamsInUse(db, { id: world.migrationId, routeId: world.routeId }, teamId))
            ) {
              const team = String(
                row.resourceRef.kind === 'team' ? row.resourceRef.slug : row.resourceRef.team,
              );
              lefts.push({
                kind: row.resourceRef.kind === 'team' ? 'group-in-use' : 'group-membership-in-use',
                name: team,
              });
              continue;
            }
            const undo = facet.undo.bind(facet);
            await noteChanging(ctx);
            const outcome = await writeToTarget(() => undo(driver, facetTarget, toRecord(row)));
            if (outcome && typeof outcome === 'object' && 'left' in outcome) {
              // Not provably the resource the record names any more: it stays recorded and undoable.
              lefts.push(outcome.left);
              continue;
            }
            await markUndone(ctx, [row.id]);
            tally.undone += 1;
          } else if (how === 'repository') {
            if (row.state === 'intended') {
              // An unconfirmed creation that was not proven ours (checked above): left standing.
              await ctx.runLog('warn', 'A repository creation could not be proven; it is left', {});
              await settleNotApplied(ctx, row.id);
            } else {
              // A repository an earlier Run created, while the target now is another one (adopted).
              // It is undone once the provider says it is gone; if it exists, it is left and reported.
              const id = String(row.resourceRef.id ?? '');
              const name = String(row.resourceRef.name ?? id);
              const still =
                id === ''
                  ? null
                  : await lookupEarlier(ctx, world, connection, id, name, recordedEndpoint(row));
              if (still === null) {
                await markUndone(ctx, [row.id]);
                tally.undone += 1;
              } else {
                lefts.push(leftRepository(still.slug));
              }
            }
          }
          // 'unrecoverable' is not touched: the settle Step fails the Run for it, honestly.
        }
      } catch (error) {
        if (!(error instanceof TargetGone) || !target) throw error;
        return settleGoneTarget(ctx, world, connection, target.fullPath, tally);
      }
      if (lefts.length > 0) throw await leftInPlace(ctx, lefts);
      await settleLeftInPlaceTasks(ctx, null);
      return { status: 'succeeded', detail: tally };
    },
  };
}

/**
 * Deletes the target repository when the framework created it and the ledger proves that, and
 * settles open create intents (a create whose response was lost). Returns true when the Migration's
 * own target repository was deleted (or was already gone).
 */
async function deleteCreatedRepository(
  ctx: MigrationContext,
  world: RollbackWorld,
  connection: EndpointConnection,
  todo: readonly LedgerRow[],
  tally: { undone: number; left: number; deleted: number },
): Promise<boolean> {
  const { db } = ctx.services;
  const { namespace } = world;
  // An open create intent: the repository may exist without a link to this Migration.
  const intents = todo.filter((r) => dispositionOf(r) === 'repository' && r.state === 'intended');
  const linked = world.targetRepository;
  for (const intent of intents) {
    ctx.checkpoint();
    const name = String(intent.resourceRef.name ?? '');
    const found =
      namespace && name !== '' ? await connection.inventory.findRepository(namespace, name) : null;
    if (!found || !namespace) {
      await settleNotApplied(ctx, intent.id);
      continue;
    }
    if (linked && found.providerId === linked.providerId) continue; // handled as the linked one
    // Another Migration's repository is never this Migration's to delete, however empty it is.
    if (
      await repositoryHeldElsewhere(db, world.migrationId, world.targetEndpointId, found.providerId)
    ) {
      await ctx.runLog(
        'warn',
        'A repository with the name of an unconfirmed creation belongs to another Migration; it is left',
        { repository: found.slug },
      );
      await settleNotApplied(ctx, intent.id);
      continue;
    }
    const empty = await connection.repositories.isEmpty({
      providerId: found.providerId,
      namespace,
      slug: found.slug,
    });
    if (!(await ledgerShowsCreation(db, world.migrationId, found, empty))) {
      await ctx.runLog(
        'warn',
        'A repository with the name of an unconfirmed creation is not provably the framework’s; it is left',
        { repository: found.slug },
      );
      await settleNotApplied(ctx, intent.id);
      continue;
    }
    const result = await deleteRepository(
      ctx,
      connection,
      { providerId: found.providerId, namespace, slug: found.slug },
      `${namespace.slug}/${found.slug}`,
    );
    await markUndone(ctx, [intent.id]);
    tally.deleted += result === 'deleted' ? 1 : 0;
  }

  if (!world.createdByFramework || !linked || !namespace) return false;
  // The ledger must say the framework created exactly this repository (by provider id).
  if (!(await creationRecorded(db, world.migrationId, { providerId: linked.providerId }))) {
    await ctx.findings.addTask({
      code: DELETION_UNPROVEN,
      facetKey: 'repository-settings',
      phase: 'post',
      params: { repository: linked.fullPath },
    });
    throw new StepFailure(
      'rollback.deletion-unproven',
      `The ledger does not show that the framework created ${linked.fullPath}, so it is not deleted`,
    );
  }
  const result = await deleteRepository(
    ctx,
    connection,
    { providerId: linked.providerId, namespace, slug: linked.slug },
    linked.fullPath,
  );
  tally.deleted += result === 'deleted' ? 1 : 0;
  await ctx.runLog(
    'info',
    result === 'deleted'
      ? 'Deleted the target repository the framework created'
      : 'The target repository the framework created was already gone',
    { repository: linked.fullPath },
  );
  return true;
}

/** Step 2 of an endpoint Run: the mappings of undone teams are open again (T-086 follow-up). */
export function groupMappingsStep(): StepDefinition<MigrationServices> {
  return {
    key: ROLLBACK_GROUP_MAPPINGS_STEP,
    facetKey: 'teams',
    severity: 'independent',
    async run(ctx): Promise<StepResult> {
      const world = await loadWorld(ctx);
      const unmapped = await unmapUndoneTeams(ctx, world.migrationId, world.routeId);
      return { status: 'succeeded', detail: { unmapped } };
    },
  };
}

/** Step 3. See the file comment. */
export function rollbackSettleStep(): StepDefinition<MigrationServices> {
  return {
    key: ROLLBACK_SETTLE_STEP,
    severity: 'fatal',
    async run(ctx): Promise<StepResult> {
      const world = await loadWorld(ctx);
      await ctx.transaction(
        async (tx) => {
          // The Migration row lock (and the Run's) serialize this against a late ledger write of an
          // earlier Run (ADR-0342): what is read now is what the Migration will have.
          const left = await remainingTargetRecords(tx, world.migrationId);
          if (left.count > 0) {
            throw new StepFailure(
              'rollback.incomplete',
              `${left.count} change(s) the framework made could not be reverted and are still recorded`,
              { records: left.sample },
            );
          }
          if (world.scope === 'repository' && world.createdByFramework && world.targetRepository) {
            // The repository is gone: the Migration no longer points at it, and its Analysis,
            // parity and drift history describe something that does not exist (LIF-077).
            await tx.migration.update({
              where: { id: world.migrationId },
              data: { targetRepositoryId: null },
            });
            await tx.repository.update({
              where: { id: world.targetRepository.id },
              data: { presence: 'missing' },
            });
          } else if (world.scope === 'repository' && world.targetRepository && world.outsideRoute) {
            // An adopted target the Route no longer points at: nothing of the framework's is left
            // in it, so the Migration lets it go and plans its target in the Route's new place.
            await tx.migration.update({
              where: { id: world.migrationId },
              data: { targetRepositoryId: null },
            });
          }
          // Nothing the framework wrote is left on the target: the place is no longer pinned.
          await tx.migration.update({
            where: { id: world.migrationId },
            data: {
              targetPlacedEndpointId: null,
              targetPlacedNamespaceId: null,
              targetPlacementUnknown: false,
            },
          });
          await tx.parityResult.deleteMany({ where: { migrationId: world.migrationId } });
          await markAnalysesStale(tx, { ids: [world.migrationId] });
        },
        { migration: true },
      );
      return { status: 'succeeded' };
    },
  };
}

/** The planner of the `rollback` Run kind (LIF-077). */
export function createRollbackPlanner(): RunPlanner<MigrationServices> {
  return {
    steps: ({ migration }) => [
      rollbackTargetStep(),
      ...(migration.scope === 'endpoint' ? [groupMappingsStep()] : []),
      rollbackSettleStep(),
    ],
  };
}
