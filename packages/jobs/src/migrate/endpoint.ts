/**
 * The Steps of an endpoint-scope Run (LIF-080, LIF-081): `members`, `teams`, `org-variables` and
 * `org-webhooks` of the Route's target organization, in the order the Plan lists them. They apply
 * the Run's own Analysis through the same ledger path as the repository Facet Steps
 * (`applyWithLedger`), so every provider write is an intent then a confirm and goes through the
 * quota-aware client. `members` has no target driver `apply` (AUTH-061: people are invited only
 * through approved Invitation Batches), so that Step is skipped. After `teams` created teams, the
 * Group Mappings of the Route move to `confirmed` and the repository Migrations of the Route are
 * marked stale, so their next Analysis no longer blocks on `access-control.team-missing`
 * (FAC-ACL-004, AUTH-050). Decisions: docs/adr/0435-endpoint-migration-steps.md.
 */
import type { FacetTarget, GroupRecord, NamespaceRef } from '@git-migrator/adapter-sdk';
import {
  advisoryXactLock,
  invitationTargetLockKey,
  markAnalysesStale,
  publishEvent,
  routeMappingLockKey,
} from '@git-migrator/db';
import { StepFailure } from '../run/errors.ts';
import { addRunTask } from '../run/findings.ts';
import type { StepDefinition, StepResult } from '../run/types.ts';
import { applyWithLedger, recoverOpenIntents } from './facets.ts';
import { connectSide, type MigrationContext, type MigrationServices } from './services.ts';
import { type FacetPlan, facetPlansOf } from './world.ts';

/** What an endpoint Step reads about its Run: the Route, the target organization and the Analysis. */
export interface EndpointWorld {
  readonly migrationId: string;
  readonly routeId: string;
  readonly analysisId: string;
  readonly targetEndpointId: string;
  readonly targetType: string;
  readonly targetNamespace: NamespaceRef;
  readonly facets: ReadonlyMap<string, FacetPlan>;
}

export async function loadEndpointWorld(ctx: MigrationContext): Promise<EndpointWorld> {
  const { db } = ctx.services;
  if (ctx.migration.scope !== 'endpoint') {
    throw new StepFailure('run.scope_unsupported', 'Only an endpoint Migration has these Steps');
  }
  if (ctx.run.analysisId === null) {
    throw new StepFailure('run.analysis_missing', 'The Run has no Analysis to apply');
  }
  const migration = await db.migration.findUniqueOrThrow({
    where: { id: ctx.migration.id },
    include: { route: { include: { targetEndpoint: true } } },
  });
  const route = migration.route;
  if (!route.targetNamespaceId) {
    throw new StepFailure('run.target_namespace_missing', 'The target namespace is not resolved');
  }
  const namespace = await db.namespace.findUniqueOrThrow({
    where: { id: route.targetNamespaceId },
  });
  const analysis = await db.analysis.findUniqueOrThrow({
    where: { id: ctx.run.analysisId },
    select: { translation: true },
  });
  return {
    migrationId: migration.id,
    routeId: route.id,
    analysisId: ctx.run.analysisId,
    targetEndpointId: route.targetEndpointId,
    targetType: route.targetEndpoint.providerType,
    targetNamespace: { providerId: namespace.providerId, slug: namespace.slug },
    facets: facetPlansOf(analysis.translation),
  };
}

const endpointTarget = (world: EndpointWorld): FacetTarget => ({
  scope: 'endpoint',
  namespace: world.targetNamespace,
});

/** LIF-081 Steps: applies one endpoint Facet's desired document to the target organization. */
export function endpointFacetStep(facetKey: string): StepDefinition<MigrationServices> {
  return {
    key: `facet.${facetKey}.apply`,
    facetKey,
    severity: 'independent',
    async run(ctx): Promise<StepResult> {
      const world = await loadEndpointWorld(ctx);
      const plan = world.facets.get(facetKey);
      if (!plan) {
        return { status: 'skipped', reason: `the Analysis translated no ${facetKey} document` };
      }
      const target = await connectSide(ctx, world.targetEndpointId, world.targetType);
      const driver = target.connection.facets[facetKey as keyof typeof target.connection.facets];
      if (!driver?.apply) {
        return { status: 'skipped', reason: 'the target does not write this Facet' };
      }
      const facetTarget = endpointTarget(world);
      await recoverOpenIntents(ctx, target, facetTarget);
      const current = (await driver.read(target.driver, facetTarget)).data;
      const records = await applyWithLedger(ctx, {
        facetKey,
        driver,
        side: target,
        target: facetTarget,
        desired: plan.desired,
        decisions: [...plan.decisions],
        current,
        umbrella: 'facet-apply',
      });
      if (facetKey === 'teams') await settleTeams(ctx, world, target);
      return { status: 'succeeded', detail: { changes: records.length } };
    },
  };
}

const TEAM_PATH = /^\/teams\[slug=([^\]]+)\]$/;
/** The `slug` or `name` leaf of a team element: only a whole new team has one in a diff. */
const TEAM_IDENTITY_PATH = /^\/teams\[slug=([^\]]+)\]\/(?:slug|name)$/;
const teamSlugsOf = (doc: unknown): Set<string> => {
  const teams = (doc as { teams?: { slug?: unknown }[] } | null)?.teams;
  return new Set(
    Array.isArray(teams)
      ? teams.flatMap((t) => (typeof t?.slug === 'string' ? [t.slug.toLowerCase()] : []))
      : [],
  );
};

/**
 * Slugs of the teams this Migration created and has not undone (the ledger is the proof): a
 * `create` record of a team, or a `recovered-write` of the teams Facet (a write whose own record
 * was lost in a crash, ADR-0380) that added the team: absent from the umbrella `before`, present in
 * what was read back. Recovery only records paths the write meant to make, so the team is ours.
 * A team that merely has the same slug is never counted.
 */
export async function createdTeamSlugs(
  db: MigrationServices['db'],
  migrationId: string,
): Promise<Set<string>> {
  const rows = await db.mutation.findMany({
    where: {
      migrationId,
      side: 'target',
      facetKey: 'teams',
      action: { in: ['create', 'update'] },
      undoneAt: null,
      state: 'recorded',
    },
    select: { action: true, resourceRef: true, paths: true, before: true, after: true },
  });
  const slugs = new Set<string>();
  for (const row of rows) {
    const ref = row.resourceRef as Record<string, unknown> | null;
    if (row.action === 'create') {
      if (ref?.kind === 'team' && typeof ref.slug === 'string') slugs.add(ref.slug.toLowerCase());
      for (const path of row.paths) {
        const hit = TEAM_PATH.exec(path)?.[1];
        if (hit) slugs.add(hit.toLowerCase());
      }
    } else if (ref?.kind === 'recovered-write') {
      // A team added by the write has a `slug` or `name` path in the recorded diff and is absent
      // from the umbrella `before`. A member-only change to a team that was already there records
      // only member paths, and a pre-existing team is in `before`: neither is ours.
      const before = teamSlugsOf(row.before);
      const after = teamSlugsOf(row.after);
      for (const path of row.paths) {
        const hit = TEAM_IDENTITY_PATH.exec(path)?.[1]?.toLowerCase();
        if (hit && !before.has(hit) && after.has(hit)) slugs.add(hit);
      }
    }
  }
  return slugs;
}

/** Every team of the target organization, as the inventory sees it. */
async function listTeams(
  side: Awaited<ReturnType<typeof connectSide>>,
): Promise<readonly GroupRecord[]> {
  const out: GroupRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await side.connection.inventory.listGroups(cursor);
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return out;
}

/**
 * FAC-ACL-004, AUTH-050: a team the endpoint Migration created is the target of its Group Mapping.
 * Records the target Group, moves the `unmapped` (or merely `suggested`) mapping of the Route
 * whose planned slug names a created team to `confirmed`, and marks the Analyses of the Route's
 * repository Migrations stale, so the next Analysis finds `access-control.team-missing` cleared.
 * Everything runs in one transaction (the ZenStack client has no interactive timeout, so the
 * `lock_timeout` and `statement_timeout` set inside bound it) under the same locks as the mapping and invitation endpoints,
 * in their order (ADR-0370): the target Endpoint's invitation lock, then the Route mapping lock.
 * A decision an operator made meanwhile is never overwritten (the update is conditional on the
 * status), and a mapping is skipped, with a task, when two mappings plan the same slug or another
 * mapping already holds the team (ADR-0435). A team is tied to its Group by provider id, so a
 * rename only refreshes `Group.slug`. A `confirmed` mapping is repointed only when its team was
 * deleted (its provider id is no longer live); that repoint writes an audit event and a Run log
 * warning naming the old and the new team. Tasks and audit events commit with the mapping, so a
 * retry cannot lose them. A team the framework did not create is never confirmed: an operator
 * decides (AUTH-050).
 */
export async function settleTeams(
  ctx: MigrationContext,
  world: EndpointWorld,
  target: Awaited<ReturnType<typeof connectSide>>,
): Promise<number> {
  const { db, pool } = ctx.services;
  const created = await createdTeamSlugs(db, world.migrationId);
  const live = await listTeams(target);
  const liveIds = new Set(live.map((t) => t.providerId));
  const teams = live.filter((t) => created.has(t.slug.toLowerCase()));
  if (created.size > 0 && teams.length === 0) {
    await ctx.runLog('warn', 'The created teams are not listed yet; mappings are left as they are');
  }
  ctx.checkpoint();
  let confirmed = 0;
  let repointed = 0;
  const repoints: { mapping: string; from: string; to: string }[] = [];
  const marked = await db.$transaction(async (raw) => {
    const tx = raw as unknown as typeof db;
    await tx.$executeRaw`SELECT set_config('lock_timeout', '15000', true), set_config('statement_timeout', '60000', true)`;
    await advisoryXactLock(tx, invitationTargetLockKey(world.targetEndpointId));
    await advisoryXactLock(tx, routeMappingLockKey(world.routeId));
    // The locks may have been waited for a long time: write only if this worker still has the Run.
    await ctx.assertLease(tx as never);
    // A renamed team keeps its provider id: refresh the stored slug and name (never the mapping).
    // Only teams whose stored slug or name differ are written, so the lock is held briefly.
    const stored = await tx.group.findMany({
      where: {
        endpointId: world.targetEndpointId,
        providerId: { in: live.map((t) => t.providerId) },
      },
      select: { id: true, providerId: true, slug: true, name: true },
    });
    const byProvider = new Map(live.map((t) => [t.providerId, t]));
    for (const row of stored) {
      const team = byProvider.get(row.providerId);
      if (team && (team.slug !== row.slug || team.name !== row.name)) {
        await tx.group.update({
          where: { id: row.id },
          data: { slug: team.slug, name: team.name },
        });
      }
    }
    const mappings = await tx.groupMapping.findMany({
      where: { routeId: world.routeId },
      include: { targetGroup: { select: { slug: true, providerId: true } } },
    });
    const task = (principal: string) =>
      addRunTask(tx as never, world.migrationId, {
        code: 'teams.unmapped-principal',
        facetKey: 'teams',
        phase: 'pre',
        params: { principal, facet: 'teams' },
      });
    for (const team of teams) {
      const slug = team.slug.toLowerCase();
      const row = await tx.group.upsert({
        where: {
          endpointId_providerId: {
            endpointId: world.targetEndpointId,
            providerId: team.providerId,
          },
        },
        create: {
          endpointId: world.targetEndpointId,
          providerId: team.providerId,
          slug: team.slug,
          name: team.name,
          memberIds: [],
        },
        update: { slug: team.slug, name: team.name },
      });
      const planned = mappings.filter((m) => m.plannedSlug.toLowerCase() === slug);
      const open = planned.filter(
        (m) =>
          m.status === 'unmapped' ||
          m.status === 'suggested' ||
          (m.status === 'confirmed' &&
            m.targetGroup !== null &&
            !liveIds.has(m.targetGroup.providerId)),
      );
      const holder = mappings.some((m) => m.targetGroupId === row.id && m.status === 'confirmed');
      if (open.length === 0) continue;
      if (open.length > 1 || holder) {
        await task(`group:${slug}`);
        continue;
      }
      const only = open[0];
      if (!only) continue;
      const written = await tx.groupMapping.updateMany({
        where: { id: only.id, status: only.status, targetGroupId: only.targetGroupId },
        data: { status: 'confirmed', targetGroupId: row.id },
      });
      if (written.count === 0) continue;
      confirmed += 1;
      const previous = only.status === 'confirmed' ? only.targetGroup : null;
      await tx.auditEvent.create({
        data: {
          actorId: null,
          action: 'group-mapping.confirm',
          subjectType: 'group_mapping',
          subjectId: only.id,
          data: {
            status: { from: only.status, to: 'confirmed' },
            origin: 'run',
            runId: ctx.run.id,
            targetGroupId: row.id,
            ...(previous ? { repointedFrom: previous.slug, repointedTo: team.slug } : {}),
          },
        },
      });
      if (previous) {
        repointed += 1;
        // Logged after the commit: the Run log write needs the Run row this transaction share-locks.
        repoints.push({ mapping: only.id, from: previous.slug, to: team.slug });
      }
    }
    if (confirmed === 0) return [] as string[];
    // The repository Migrations of the Route read their group principals through the mappings;
    // the endpoint Migration's own Analysis is refreshed by the last Step of the Run.
    const repositories = await tx.migration.findMany({
      where: { routeId: world.routeId, scope: 'repository' },
      select: { id: true },
    });
    return markAnalysesStale(tx, { ids: repositories.map((m) => m.id) });
  });
  for (const r of repoints) {
    await ctx.runLog('warn', `Group Mapping repointed: team ${r.from} was deleted`, r);
  }
  if (pool) {
    for (const id of [world.migrationId, ...marked]) {
      await publishEvent(pool, {
        type: 'migration.updated',
        ids: { migration: id },
        at: (ctx.services.now?.() ?? new Date()).toISOString(),
      });
    }
  }
  await ctx.runLog('info', `Confirmed ${confirmed} Group Mapping(s) for created teams`, {
    confirmed,
    repointed,
    staleMigrations: marked.length,
  });
  return confirmed;
}

/** Facet keys the endpoint Steps implement (LIF-081). */
export const ENDPOINT_FACET_KEYS: readonly string[] = [
  'members',
  'teams',
  'org-variables',
  'org-webhooks',
];
