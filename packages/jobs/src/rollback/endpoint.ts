/**
 * Rollback of an endpoint Run (LIF-077, LIF-081): the teams the Run created are deleted by the
 * `teams` driver's `undo`; this returns the Group Mappings that pointed at them to `unmapped` and
 * marks the Route's repository Analyses stale, so `access-control.team-missing` appears again
 * (FAC-ACL-004) and an operator decides again (AUTH-050). The mirror image of `settleTeams`
 * (`migrate/endpoint.ts`), under the same locks in the same order (ADR-0370): the target
 * Endpoint's invitation lock, then the Route mapping lock. Decisions: docs/adr/0465-rollback.md.
 */
import type { GroupRecord } from '@git-migrator/adapter-sdk';
import {
  advisoryXactLock,
  invitationTargetLockKey,
  markAnalysesStale,
  publishEvent,
  routeMappingLockKey,
} from '@git-migrator/db';
import type { MigrationContext } from '../migrate/services.ts';

/** Slugs (lower case) of the teams a Migration created and rolled back. */
async function undoneTeamSlugs(
  db: MigrationContext['services']['db'],
  migrationId: string,
): Promise<Set<string>> {
  const rows = await db.mutation.findMany({
    where: {
      migrationId,
      side: 'target',
      facetKey: 'teams',
      action: 'create',
      undoneAt: { not: null },
      state: { not: 'not_applied' },
    },
    select: { resourceRef: true },
  });
  const slugs = new Set<string>();
  for (const row of rows) {
    const ref = row.resourceRef as { kind?: unknown; slug?: unknown };
    if (ref.kind === 'team' && typeof ref.slug === 'string') slugs.add(ref.slug.toLowerCase());
  }
  return slugs;
}

async function liveTeamIds(ctx: MigrationContext, targetEndpointId: string): Promise<Set<string>> {
  const connection = await ctx.services.connector.connect(targetEndpointId, {
    pool: 'interactive',
    signal: ctx.signal,
  });
  const out: GroupRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await connection.inventory.listGroups(cursor);
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return new Set(out.map((g) => g.providerId));
}

/**
 * Returns the `confirmed` Group Mappings of the Route whose target is a team this Migration
 * created and rolled back to `unmapped` (no target Group), one `group-mapping.unmap` AuditEvent
 * with no Actor each, and marks the Route's repository Migrations stale. A mapping whose team is
 * still live on the target (somebody made it again) is left to its operator, and a decision made
 * meanwhile is never overwritten (the update is conditional on the status and the Group). Returns
 * how many mappings moved.
 */
export async function unmapUndoneTeams(
  ctx: MigrationContext,
  migrationId: string,
  routeId: string,
): Promise<number> {
  const { db, pool } = ctx.services;
  const slugs = await undoneTeamSlugs(db, migrationId);
  if (slugs.size === 0) return 0;
  const route = await db.route.findUniqueOrThrow({
    where: { id: routeId },
    select: { targetEndpointId: true },
  });
  const live = await liveTeamIds(ctx, route.targetEndpointId);
  ctx.checkpoint();
  const moved: string[] = [];
  const marked = await db.$transaction(async (raw) => {
    const tx = raw as unknown as typeof db;
    await tx.$executeRaw`SELECT set_config('lock_timeout', '15000', true), set_config('statement_timeout', '60000', true)`;
    await advisoryXactLock(tx, invitationTargetLockKey(route.targetEndpointId));
    await advisoryXactLock(tx, routeMappingLockKey(routeId));
    await ctx.assertLease(tx as never);
    const mappings = await tx.groupMapping.findMany({
      where: { routeId, status: 'confirmed', targetGroupId: { not: null } },
      include: { targetGroup: { select: { slug: true, providerId: true } } },
    });
    for (const mapping of mappings) {
      const group = mapping.targetGroup;
      if (!group || !slugs.has(group.slug.toLowerCase()) || live.has(group.providerId)) continue;
      const written = await tx.groupMapping.updateMany({
        where: { id: mapping.id, status: 'confirmed', targetGroupId: mapping.targetGroupId },
        data: { status: 'unmapped', targetGroupId: null },
      });
      if (written.count === 0) continue;
      moved.push(mapping.id);
      await tx.auditEvent.create({
        data: {
          actorId: null,
          action: 'group-mapping.unmap',
          subjectType: 'group_mapping',
          subjectId: mapping.id,
          data: {
            status: { from: 'confirmed', to: 'unmapped' },
            origin: 'run',
            reason: 'rollback',
            runId: ctx.run.id,
            targetGroupId: mapping.targetGroupId,
          },
        },
      });
    }
    // The Analyses of the Route read the teams and their mappings. Marked even when no mapping
    // moved: the teams are gone, which is what the next Analysis reads.
    return markAnalysesStale(tx, { routeId });
  });
  if (pool) {
    for (const id of [migrationId, ...marked]) {
      await publishEvent(pool, {
        type: 'migration.updated',
        ids: { migration: id },
        at: (ctx.services.now?.() ?? new Date()).toISOString(),
      });
    }
  }
  await ctx.runLog('info', `Returned ${moved.length} Group Mapping(s) to unmapped`, {
    unmapped: moved.length,
    staleMigrations: marked.length,
  });
  return moved.length;
}
