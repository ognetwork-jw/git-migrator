/**
 * LIF-040 steps 1 and 2: `preflight` and `git.prepare`. Neither writes to a target; no target
 * write happens before `git.prepare` succeeds.
 */
import { markAnalysesStale } from '@git-migrator/db';
import { collectPrincipals, groupResolver } from '../analysis/context.ts';
import { StepFailure } from '../run/errors.ts';
import type { StepDefinition, StepResult } from '../run/types.ts';
import { classifySize } from '../scratch.ts';
import { buildMirror, formatSize, precheckScratch, scanMirror } from './mirror.ts';
import type { Side } from './services.ts';
import { connectSide, type MigrationContext, type MigrationServices } from './services.ts';
import { loadRunWorld, type RunWorld } from './world.ts';

/** Run-origin blocker codes that `git.prepare` guards (LIF-049). */
export const PREPARE_BLOCKERS = ['git-refs.blob-too-large'] as const;

const DEPENDENCY_FACETS = ['access-control', 'branch-rules', 'code-ownership'] as const;
/** Most blobs listed in one run-origin blocker's params, so the row stays small. */

interface NewBlocker {
  readonly code: string;
  readonly params: Record<string, unknown>;
}

/**
 * LIF-041: the dependency blockers of FAC-006, judged again with the mapping rows as they are now
 * (a team can have gone since the Analysis). Only principals in this repository's own documents
 * count.
 */
async function dependencyBlockers(ctx: MigrationContext, world: RunWorld): Promise<NewBlocker[]> {
  const { db } = ctx.services;
  const rows = await db.groupMapping.findMany({
    where: { routeId: world.routeId, sourceGroup: { endpointId: world.sourceEndpointId } },
    include: {
      sourceGroup: { select: { providerId: true } },
      targetGroup: { select: { providerId: true } },
    },
  });
  const resolver = groupResolver(
    rows.map((r) => ({
      status: r.status,
      sourceProviderId: r.sourceGroup.providerId,
      targetProviderId: r.targetGroup?.providerId ?? null,
    })),
  );
  const out: NewBlocker[] = [];
  for (const facetKey of DEPENDENCY_FACETS) {
    const snapshot = await db.facetSnapshot.findFirst({
      where: { side: 'source', repositoryId: world.sourceRepository.id, facetKey },
      orderBy: [{ fetchedAt: 'desc' }, { id: 'desc' }],
      select: { data: true },
    });
    if (!snapshot) continue;
    for (const principal of collectPrincipals(snapshot.data).values()) {
      if (principal.kind !== 'group') continue;
      if (resolver.resolve(principal).status === 'team_missing') {
        out.push({ code: `${facetKey}.team-missing`, params: { team: principal.id } });
      }
    }
  }
  return out;
}

/**
 * Step 1 (LIF-041): re-checks `change-requests` on the source (read live) and the dependency
 * blockers, plus quota availability. New blockers abort the Run before anything is written, and
 * the Analysis is marked stale so the next one shows them (Readiness, LIF-004).
 */
export function preflightStep(): StepDefinition<MigrationServices> {
  return {
    key: 'preflight',
    severity: 'fatal',
    async run(ctx): Promise<StepResult> {
      const world = await loadRunWorld(ctx);
      const source = await connectSide(ctx, world.sourceEndpointId, world.sourceType);
      const target = await connectSide(ctx, world.targetEndpointId, world.targetType);

      const blockers: NewBlocker[] = [];
      const crDriver = source.connection.facets['change-requests'];
      if (crDriver) {
        const read = await crDriver.read(source.driver, {
          scope: 'repository',
          repository: world.sourceRef,
          namespace: world.sourceRef.namespace,
        });
        const open = (read.data as { open?: { id?: string; title?: string; url?: string }[] }).open;
        if (open && open.length > 0) {
          blockers.push({
            code: 'change-requests.open',
            params: {
              count: open.length,
              ids: open.slice(0, 20).map((cr) => cr.id ?? cr.url ?? ''),
            },
          });
        }
      }
      blockers.push(...(await dependencyBlockers(ctx, world)));

      if (blockers.length > 0) {
        // The next Analysis raises the same findings as Analysis blockers; mark it due now.
        await markAnalysesStale(ctx.services.db, { ids: [world.migrationId] });
        throw new StepFailure(
          'preflight.blocked',
          'New blockers were found before anything was written',
          {
            blockers: blockers.map((b) => ({ code: b.code, params: b.params })),
          },
        );
      }

      // Quota availability: a blocked or exhausted git bucket delays the Run instead of failing it.
      for (const side of [source, target]) {
        const delay = await quotaDelay(ctx, side);
        if (delay) return { status: 'delay', delayMs: delay, reason: 'git quota is exhausted' };
      }
      return { status: 'succeeded' };
    },
  };
}

async function quotaDelay(ctx: MigrationContext, side: Side): Promise<number | undefined> {
  const spec = side.connection.git.quota;
  if (!spec) return undefined;
  const { free, blockedUntil } = await ctx.services.quota.freeCapacity(spec, 'interactive');
  const now = (ctx.services.now ?? (() => new Date()))();
  if (blockedUntil && blockedUntil > now)
    return Math.max(1_000, blockedUntil.getTime() - now.getTime());
  // A whole window of waiting is the most a missing estimate can cost; the git service itself
  // delays precisely when an acquire is denied (JOB-044).
  return free <= 0 ? 60_000 : undefined;
}

/**
 * Step 2: disk precheck (JOB-015), mirror clone into scratch, blob scan (FAC-GIT-004), LFS fetch
 * and LFS bytes. Blobs over the target limit become run-origin blockers `git-refs.blob-too-large`
 * and fail the Step; nothing was written to the target.
 */
export function gitPrepareStep(): StepDefinition<MigrationServices> {
  return {
    key: 'git.prepare',
    severity: 'fatal',
    clearsBlockers: PREPARE_BLOCKERS,
    async run(ctx): Promise<StepResult> {
      const world = await loadRunWorld(ctx);
      const stop = await precheckScratch(ctx, world);
      if (stop) return stop;

      const source = await connectSide(ctx, world.sourceEndpointId, world.sourceType);
      const target = await connectSide(ctx, world.targetEndpointId, world.targetType);
      ctx.checkpoint();
      const { dir, sizeBytes } = await buildMirror(ctx, world, source);
      ctx.checkpoint();

      const lfs = await source.git.listLfsObjects(dir, ctx.signal);
      const lfsBytes = lfs.reduce((sum, o) => sum + o.size, 0);
      await updateRepositorySize(ctx, world, lfsBytes);
      let blobsScanned = 0;
      try {
        blobsScanned = (await scanMirror(ctx, source, target, dir)).blobsScanned;
      } finally {
        await ctx.runLog('info', 'The source mirror is ready', {
          mirrorBytes: sizeBytes,
          lfsObjects: lfs.length,
          lfsBytes,
          blobsScanned,
        });
      }
      return { status: 'succeeded' };
    },
  };
}

/** Remembers the LFS bytes of this read and re-derives the size class (JOB-015). */
async function updateRepositorySize(
  ctx: MigrationContext,
  world: RunWorld,
  lfsBytes: number,
): Promise<void> {
  const threshold = ctx.services.config.sizeClass.largeThresholdBytes;
  await ctx.transaction(async (tx) => {
    await tx.repository.update({
      where: { id: world.sourceRepository.id },
      data: {
        lfsBytes: BigInt(lfsBytes),
        sizeClass: classifySize(world.sourceRepository.sizeBytes, lfsBytes, threshold),
      },
    });
  });
}

export { formatSize };
