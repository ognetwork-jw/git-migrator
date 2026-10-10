/**
 * Storing a Parity Check (LIF-060, LIF-061): one ParityResult per Facet, and the auto-completion of
 * verifiable ManualTasks. The caller holds the Migration row lock (and, in a Run, the Run row lock
 * after it, ADR-0340). Decisions: docs/adr/0396-parity-engine-and-verified-status.md.
 */

import { type FacetLookup, satisfiedTasks } from '@git-migrator/core';
import { publishEventIn } from '@git-migrator/db';
import { joinSecretParams } from '@git-migrator/guidance';
import type { Logger } from '@git-migrator/observability';
import { recomputeReadiness } from '../run/findings.ts';
import { toJson } from '../run/store.ts';
import type { Tx } from '../run/types.ts';
import type { FacetParity, ParityComputation } from './compute.ts';

/** The note a task carries when parity completed it, and the audit event's action (LIF-061). */
export const PARITY_COMPLETION_NOTE = 'parity.auto-completed';
export const PARITY_COMPLETION_ACTION = 'task.auto_complete';

/** `task.updated` events per check (JOB-060 caps them like the Analysis does). */
const MAX_TASK_EVENTS = 25;

export interface StoreResult {
  /** Ids of the ManualTasks parity completed. */
  readonly completed: readonly string[];
  /**
   * Another check was stored after this one started (`Migration.parityGeneration` moved): its data
   * is older than what is stored, so nothing was written and no event may follow (ADR-0396).
   */
  readonly superseded?: true;
}

type Computed = Extract<ParityComputation, { skipped?: undefined }>;

/**
 * Writes the ParityResult of every Facet (one row per Migration and Facet, updated in place: DATA-020
 * keeps the latest per Facet), completes the verifiable tasks whose Facet reports them satisfied,
 * and stamps `Migration.lastParityAt`. Events are published in the same transaction.
 */
export async function storeParity(
  tx: Tx,
  input: {
    readonly computation: Computed;
    readonly registry: FacetLookup;
    readonly now: Date;
    readonly log: Logger;
    /** A scheduled drift check: also stamps `Migration.lastDriftCheckAt` (LIF-065). */
    readonly drift?: boolean;
  },
): Promise<StoreResult> {
  const { computation, now } = input;
  const migrationId = computation.migrationId;
  // The caller holds the Migration lock, so the generation cannot move while we look at it.
  const current = await tx.migration.findUniqueOrThrow({
    where: { id: migrationId },
    select: { parityGeneration: true },
  });
  if (current.parityGeneration !== computation.generation)
    return { completed: [], superseded: true };
  for (const facet of computation.facets) {
    await writeResult(tx, migrationId, facet, computation.checkedAt);
  }
  // A Facet this check did not produce (its Facet is gone, or the source no longer has it) must not
  // keep deciding the verdict with an old result.
  await tx.parityResult.deleteMany({
    where: { migrationId, facetKey: { notIn: computation.facets.map((f) => f.facetKey) } },
  });
  const completed = await completeVerifiableTasks(tx, input);
  await tx.migration.update({
    where: { id: migrationId },
    data: {
      lastParityAt: now,
      ...(input.drift ? { lastDriftCheckAt: now } : {}),
      parityGeneration: { increment: 1 },
    },
  });
  if (completed.length > 0) await recomputeReadiness(tx, migrationId);
  await publishEventIn(tx, {
    type: 'migration.updated',
    ids: { migration: migrationId },
    at: now.toISOString(),
  });
  for (const taskId of completed.slice(0, MAX_TASK_EVENTS)) {
    await publishEventIn(tx, {
      type: 'task.updated',
      ids: { migration: migrationId, task: taskId },
      at: now.toISOString(),
    });
  }
  return { completed };
}

async function writeResult(
  tx: Tx,
  migrationId: string,
  facet: FacetParity,
  checkedAt: Date,
): Promise<void> {
  const data = {
    status: facet.status,
    diffs: toJson(facet.diffs),
    excluded: toJson(facet.excluded),
    checkedAt,
  };
  const rows = await tx.parityResult.findMany({
    where: { migrationId, facetKey: facet.facetKey },
    orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  const [latest, ...older] = rows;
  if (latest) {
    // Never replace a result that was checked later than this one started.
    const stamp = await tx.parityResult.findUniqueOrThrow({
      where: { id: latest.id },
      select: { checkedAt: true },
    });
    if (stamp.checkedAt.getTime() > checkedAt.getTime()) return;
  }
  if (!latest) {
    await tx.parityResult.create({ data: { migrationId, facetKey: facet.facetKey, ...data } });
    return;
  }
  await tx.parityResult.update({ where: { id: latest.id }, data });
  if (older.length > 0) {
    await tx.parityResult.deleteMany({ where: { id: { in: older.map((r) => r.id) } } });
  }
}

/**
 * LIF-061 pre-step. An open task whose finding code has completion `parity` is completed when its
 * Facet's `isTaskSatisfied(task, target, parity)` returns true. It becomes `done` with
 * `completedById` null, note `parity.auto-completed` and an AuditEvent with no actor (system).
 * `done` is never reopened by an Analysis (LIF-020 step 6), and the null `completedById` is the
 * marker that no Actor did it (ADR-0396). A Facet that is `unverifiable` has no evidence and
 * completes nothing.
 */
async function completeVerifiableTasks(
  tx: Tx,
  input: {
    readonly computation: Computed;
    readonly registry: FacetLookup;
    readonly now: Date;
    readonly log: Logger;
  },
): Promise<string[]> {
  const migrationId = input.computation.migrationId;
  const open = await tx.manualTask.findMany({
    where: { migrationId, status: 'open', verifiable: true },
    orderBy: { id: 'asc' },
  });
  if (open.length === 0) return [];
  const completed: string[] = [];
  for (const facet of input.computation.facets) {
    const evidence = facet.evidence;
    if (!evidence) continue;
    const tasks = open.filter((t) => t.facetKey === facet.facetKey);
    if (tasks.length === 0) continue;
    let satisfied: typeof tasks;
    try {
      // The Facet judges a task by all its parameters, the secret ones included (a webhook URL,
      // ADR-0503): a task row written before `key` was a parameter is found by its URL.
      const judged = tasks.map((t) => ({
        ...t,
        params: joinSecretParams(t.params, t.secretParams),
      }));
      const byId = new Map(tasks.map((t) => [t.id, t]));
      satisfied = satisfiedTasks(
        input.registry,
        facet.facetKey,
        judged,
        evidence.target,
        evidence.diffs,
      ).flatMap((t) => byId.get(t.id) ?? []);
    } catch (error) {
      // A Facet that cannot judge its tasks leaves them open; the check itself stands.
      input.log.warn(
        { facetKey: facet.facetKey, err: error },
        'isTaskSatisfied failed; tasks stay open',
      );
      continue;
    }
    for (const task of satisfied) {
      const done = await tx.manualTask.updateMany({
        where: { id: task.id, status: 'open' },
        data: {
          status: 'done',
          completedAt: input.now,
          completedById: null,
          note: PARITY_COMPLETION_NOTE,
        },
      });
      if (done.count !== 1) continue;
      await tx.auditEvent.create({
        data: {
          actorId: null,
          action: PARITY_COMPLETION_ACTION,
          subjectType: 'manual_task',
          subjectId: task.id,
          data: toJson({ migrationId, facetKey: task.facetKey, code: task.code }),
          at: input.now,
        },
      });
      completed.push(task.id);
    }
  }
  return completed;
}
