/**
 * LIF-020 steps 6 and 7: persists an Analysis, its PlanItems and Snapshots, upserts ManualTasks,
 * records Expected Differences, recomputes readiness and applies `analysis_completed`, all in one
 * transaction. The Migration row is read inside the transaction and written with a guard, so a Run
 * that starts meanwhile is never overwritten (LIF-002). Decisions: docs/adr/0310-analysis-processor.md.
 */

import { randomUUID } from 'node:crypto';
import {
  deriveReadiness,
  type ExpectedDifferenceDraft,
  type LifecycleState,
  type MigrationStatus,
  type Plan,
  type PlanItem,
  type Readiness,
  transition,
} from '@git-migrator/core';
import { type Db, publishEventIn } from '@git-migrator/db';
import { splitSecretParams } from '@git-migrator/guidance';
import type { Logger } from '@git-migrator/observability';
import { databaseNow } from '../db-clock.ts';
import { moveLegacySecretParams } from '../run/findings.ts';

type Json = Record<string, unknown>;

export interface SnapshotInput {
  readonly side: 'source' | 'target';
  readonly endpointId: string;
  readonly repositoryId: string | null;
  readonly facetKey: string;
  readonly schemaVersion: number;
  readonly data: unknown;
  readonly unreadable: readonly string[];
  readonly hash: string;
  readonly fetchedAt: Date;
  readonly rawResponseIds: readonly string[];
}

export interface PersistInput {
  readonly migrationId: string;
  readonly routeId: string;
  /** Database clock when the Analysis started (ADR-0310); orders concurrent Analyses. */
  readonly startedAt: Date;
  /** `Migration.staleGeneration` as it was when the Analysis started (ADR-0310). */
  readonly staleGenerationAtStart: bigint;
  /** The worker clock (`deps.now`); only used for stored times, never compared to the database's. */
  readonly now: Date;
  readonly staleAfterMs: number;
  readonly snapshots: readonly SnapshotInput[];
  readonly plan: Plan;
  readonly translation: Json;
  readonly plannedTargetName: string | null | undefined;
}

export interface PersistedAnalysis {
  readonly analysisId: string;
  readonly readiness: Readiness | null;
  readonly changedTaskIds: string[];
  /** A newer-started Analysis was stored first, so this one was dropped (ADR-0310). */
  readonly superseded: boolean;
}

export interface PersistHooks {
  /** Test seam: runs just before the transaction that stores the Analysis. */
  readonly beforePersist?: (migrationId: string) => Promise<void>;
}

const OBSOLETE = 'obsolete';
const MAX_TASK_EVENTS = 25;
const WRITE_ATTEMPTS = 5;

/**
 * `params` and `secretParams` of a PlanItem or ManualTask: a parameter that may carry a credential
 * (a webhook URL) is stored apart, where viewers cannot read it (ADR-0503). The identity hash is
 * still computed over all of them, in the Plan.
 */
function secretSplit(all: Record<string, unknown>) {
  const { params, secretParams } = splitSecretParams(all);
  return {
    params: asJson(params),
    ...(secretParams ? { secretParams: asJson(secretParams) } : {}),
  };
}

/** Plan items need a facet key in the table; naming and target findings use their code prefix. */
export function planFacetKey(item: Pick<PlanItem, 'facetKey' | 'code'>): string {
  return item.facetKey ?? item.code.split('.')[0] ?? 'framework';
}

const asJson = (v: unknown): never => JSON.parse(JSON.stringify(v ?? null)) as never;

export async function persistAnalysis(
  db: Db,
  input: PersistInput,
  hooks: PersistHooks,
  log: Logger,
): Promise<PersistedAnalysis> {
  await hooks.beforePersist?.(input.migrationId);
  return db.$transaction(async (tx) => {
    // One Analysis of a Migration is stored at a time. A writer that waits here also sees what the
    // one before it committed, and a stale mark in a transaction that is still open (the staleness
    // triggers) is waited for, never missed.
    await tx.$queryRaw`SELECT id FROM app.migration WHERE id = ${input.migrationId} FOR UPDATE`;
    const current = await tx.migration.findUnique({
      where: { id: input.migrationId },
      select: { latestAnalysisId: true, latestAnalysis: { select: { startedAt: true } } },
    });
    const newer = current?.latestAnalysis?.startedAt;
    if (current?.latestAnalysisId && newer && newer > input.startedAt) {
      return {
        analysisId: current.latestAnalysisId,
        readiness: null,
        changedTaskIds: [],
        superseded: true,
      };
    }
    const sourceIds: string[] = [];
    const targetIds: string[] = [];
    for (const s of input.snapshots) {
      const row = await tx.facetSnapshot.create({
        data: {
          side: s.side,
          endpointId: s.endpointId,
          repositoryId: s.repositoryId,
          facetKey: s.facetKey,
          schemaVersion: s.schemaVersion,
          data: asJson(s.data),
          unreadable: [...s.unreadable],
          hash: s.hash,
          fetchedAt: s.fetchedAt,
          rawResponseIds: [...s.rawResponseIds],
        },
        select: { id: true },
      });
      (s.side === 'source' ? sourceIds : targetIds).push(row.id);
    }

    const planReadiness = input.plan.readiness.readiness ?? 'ready';
    const analysis = await tx.analysis.create({
      data: {
        migrationId: input.migrationId,
        sourceSnapshotIds: sourceIds,
        targetSnapshotIds: targetIds,
        readiness: planReadiness,
        startedAt: input.startedAt,
        translation: asJson(input.translation),
      },
      select: { id: true },
    });

    const planItemIds = new Map<PlanItem, string>();
    for (const item of input.plan.items) {
      const row = await tx.planItem.create({
        data: {
          analysisId: analysis.id,
          facetKey: planFacetKey(item),
          kind: item.kind,
          code: item.code,
          fidelity: item.fidelity ?? null,
          fieldPaths: item.fieldPaths,
          ...secretSplit(item.params),
          order: item.order,
        },
        select: { id: true },
      });
      planItemIds.set(item, row.id);
    }

    // Rows a previous version wrote during a rolling upgrade keep no URL in params (ADR-0503).
    await moveLegacySecretParams(tx, input.migrationId);
    const changedTaskIds = await upsertTasks(tx, input, planItemIds);
    await recordExpectedDifferences(tx, input);

    const result = await writeMigration(tx, input, analysis.id, log);
    await publishEventIn(tx, {
      type: 'migration.updated',
      ids: { migration: input.migrationId },
      at: input.now.toISOString(),
    });
    for (const taskId of changedTaskIds.slice(0, MAX_TASK_EVENTS)) {
      await publishEventIn(tx, {
        type: 'task.updated',
        ids: { migration: input.migrationId, task: taskId },
        at: input.now.toISOString(),
      });
    }
    return {
      analysisId: analysis.id,
      readiness: result.readiness,
      changedTaskIds,
      superseded: false,
    };
  });
}

type Tx = Pick<
  Db,
  | 'facetSnapshot'
  | 'analysis'
  | 'planItem'
  | 'manualTask'
  | 'expectedDifference'
  | '$executeRaw'
  | 'migration'
  | '$queryRaw'
>;

/**
 * LIF-020 step 6: upsert by (code, facetKey, paramsHash). A done task stays done. A task the
 * Analysis itself dismissed as obsolete is reopened when the same finding comes back (T-012); one
 * an operator dismissed stays dismissed. Open analysis-origin tasks that are no longer produced
 * become dismissed with note `obsolete`. Run-origin tasks are never touched.
 */
async function upsertTasks(
  tx: Tx,
  input: PersistInput,
  planItemIds: ReadonlyMap<PlanItem, string>,
): Promise<string[]> {
  const changed: string[] = [];
  const existing = await tx.manualTask.findMany({ where: { migrationId: input.migrationId } });
  const key = (facetKey: string, code: string, hash: string) =>
    JSON.stringify([code, facetKey, hash]);
  const byKey = new Map(existing.map((t) => [key(t.facetKey, t.code, t.paramsHash), t]));
  const produced = new Set<string>();
  for (const item of input.plan.items) {
    if (item.kind !== 'pre_task' && item.kind !== 'post_task') continue;
    const facetKey = planFacetKey(item);
    const k = key(facetKey, item.code, item.paramsHash);
    produced.add(k);
    const sourcePlanItemId = planItemIds.get(item) ?? null;
    const task = byKey.get(k);
    if (!task) {
      const row = await tx.manualTask.create({
        data: {
          migrationId: input.migrationId,
          facetKey,
          code: item.code,
          phase: item.kind === 'pre_task' ? 'pre' : 'post',
          origin: 'analysis',
          ...secretSplit(item.params),
          verifiable: item.verifiable === true,
          paramsHash: item.paramsHash,
          sourcePlanItemId,
        },
        select: { id: true },
      });
      changed.push(row.id);
    } else if (task.origin !== 'analysis') {
      // A run-origin task with the same identity keeps its own lifecycle.
    } else if (task.status === 'dismissed' && task.completedById === null) {
      // Only the Analysis dismisses without an Actor, so this is its own `obsolete` dismissal. The
      // note is editable through RPC and must not decide (ADR-0310).
      await tx.manualTask.update({
        where: { id: task.id },
        data: { status: 'open', completedAt: null, note: null, sourcePlanItemId },
      });
      changed.push(task.id);
    } else if (task.status === 'open') {
      await tx.manualTask.update({ where: { id: task.id }, data: { sourcePlanItemId } });
    }
  }
  for (const task of existing) {
    if (task.origin !== 'analysis' || task.status !== 'open') continue;
    if (produced.has(key(task.facetKey, task.code, task.paramsHash))) continue;
    await tx.manualTask.update({
      where: { id: task.id },
      // `completedById: null` keeps the reopen invariant whatever the task did before: only the
      // Analysis dismisses without an Actor (ADR-0310).
      data: { status: 'dismissed', note: OBSOLETE, completedAt: input.now, completedById: null },
    });
    changed.push(task.id);
  }
  return changed;
}

/**
 * Drafts from the engine (FAC-005, ADR-0081): `lossy_accepted` once per Route, facet, path and
 * policy key; `unreadable_defaulted` once per Migration. A partial unique index over the active
 * records makes `ON CONFLICT DO NOTHING` the dedupe, so concurrent Analyses of different Migrations
 * of one Route cannot record a Route-wide record twice.
 */
async function recordExpectedDifferences(tx: Tx, input: PersistInput): Promise<void> {
  const drafts: readonly ExpectedDifferenceDraft[] = input.plan.expectedDifferences;
  for (const d of drafts) {
    const migrationId = d.reason === 'lossy_accepted' ? null : input.migrationId;
    await tx.$executeRaw`
      INSERT INTO app.expected_difference
        (id, route_id, migration_id, facet_key, path, reason, note, updated_at)
      VALUES
        (${randomUUID()}, ${input.routeId}, ${migrationId}, ${d.facetKey}, ${d.path},
         ${d.reason}::app.expected_difference_reason, ${d.note}, ${input.now})
      ON CONFLICT DO NOTHING`;
  }
}

async function writeMigration(
  tx: Tx,
  input: PersistInput,
  analysisId: string,
  log: Logger,
): Promise<{ readiness: Readiness | null }> {
  const tasks = await tx.manualTask.findMany({
    where: { migrationId: input.migrationId },
    select: { phase: true, status: true },
  });
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const cur = await tx.migration.findUniqueOrThrow({ where: { id: input.migrationId } });
    const runBlockers = Array.isArray(cur.runBlockers)
      ? (cur.runBlockers as { code: string }[]).filter((b) => typeof b?.code === 'string')
      : [];
    const derived = deriveReadiness({
      analysis: {
        blockers: input.plan.blockers,
        warnings: input.plan.warnings.length,
      },
      runBlockers,
      tasks: tasks.map((t) => ({
        phase: t.phase === 'pre' ? ('pre' as const) : ('post' as const),
        status: t.status,
      })),
    });
    const state: LifecycleState = {
      status: cur.status as MigrationStatus,
      statusBeforeRun: cur.statusBeforeRun as MigrationStatus | null,
      statusBeforeDrift: cur.statusBeforeDrift as MigrationStatus | null,
      statusBeforeManual: cur.statusBeforeManual as MigrationStatus | null,
      statusBeforeMissing: cur.statusBeforeMissing as MigrationStatus | null,
    };
    const next = transition(state, { type: 'analysis_completed' });
    if (!next.ok) throw new Error(`analysis_completed rejected: ${next.error.message}`);
    // Every stale marker bumps the generation, whatever the Migration's state. A different value
    // than at the start means something changed after the inputs were read, so the result is stale
    // from the start (the data may predate the change). We hold the row lock, so a marker in a
    // transaction that was still open has committed by now.
    const changedMeanwhile = cur.staleGeneration !== input.staleGenerationAtStart;
    const analysisStaleAt = changedMeanwhile
      ? await databaseNow(tx)
      : new Date(input.now.getTime() + input.staleAfterMs);
    const written = await tx.migration.updateMany({
      where: {
        id: input.migrationId,
        status: cur.status,
        statusBeforeRun: cur.statusBeforeRun,
        statusBeforeDrift: cur.statusBeforeDrift,
        statusBeforeManual: cur.statusBeforeManual,
        statusBeforeMissing: cur.statusBeforeMissing,
      },
      data: {
        status: next.state.status,
        statusBeforeRun: next.state.statusBeforeRun,
        statusBeforeDrift: next.state.statusBeforeDrift,
        statusBeforeManual: next.state.statusBeforeManual,
        statusBeforeMissing: next.state.statusBeforeMissing,
        readiness: derived.readiness,
        readinessCounts: { ...derived.counts },
        blockerCodes: derived.blockerCodes,
        latestAnalysisId: analysisId,
        analysisStaleAt,
        analysisFailedAt: null,
        analysisFailureCount: 0,
        analysisRetryAt: null,
        // The name a running Run was started with stays (ADR-0310).
        ...(input.plannedTargetName === undefined || cur.status === 'running'
          ? {}
          : { plannedTargetName: input.plannedTargetName }),
      },
    });
    if (written.count === 1) return { readiness: derived.readiness };
    log.info({ migrationId: input.migrationId, attempt }, 'migration changed meanwhile; retrying');
  }
  throw new Error(`Migration ${input.migrationId} kept changing while its Analysis was stored`);
}
