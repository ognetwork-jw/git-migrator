/**
 * teams facet (FAC-END teams): the teams of the target organization and who is in them. Pure: no
 * I/O, no provider vocabulary (GLO-002).
 *
 * Contract with the facets that read `ctx.deps.teams` (code-ownership, access-control): a desired
 * team's slug equals the group's resolved target id, which is the planned slug from the naming
 * pipeline (`routes[].defaults.teamNaming`, LIF-030). Skipped members (excluded, pending, unmapped
 * or not org members) are left out of the desired membership; `teams.set-membership` is raised
 * only when source membership is unreadable.
 *
 * Decisions: docs/adr/0150-endpoint-facets-members-teams.md.
 */
import { type PrincipalRef, type Teams, teamsFacet } from '@git-migrator/canonical';
import {
  type FacetDefinition,
  type FacetTaskRef,
  type FieldDecision,
  type FieldDiff,
  type Finding,
  type FindingCodeSpec,
  formatFieldPath,
  itemSeg,
  type NamingPipeline,
  runNamingPipeline,
  seg,
  type TranslateContext,
  type TranslationResult,
} from '@git-migrator/core';
import {
  compareCodeUnits,
  diffDesiredOnly,
  paramString,
  principalLabel,
  principalSeg,
  resolvePrincipal,
  targetOrgMembers,
  uniqueSorted,
} from '../endpoint-support.ts';

export const TEAMS_FINDING_CODES = {
  'teams.slug-collision': { kind: 'blocker' },
  'teams.slug-invalid': { kind: 'blocker' },
  'teams.set-membership': { kind: 'post', completion: 'parity' },
  'teams.unmapped-principal': { kind: 'pre', completion: 'resolution' },
  'teams.pending-invitation': { kind: 'post', completion: 'parity' },
} as const satisfies Record<string, FindingCodeSpec>;

/** Capability path of the membership list (`unreadable` there means the source cannot list it). */
export const MEMBERSHIP_FIELD = '/teams/members';

type Team = Teams['teams'][number];
type TeamMember = Team['members'][number];

/** Default team naming: kebab-case of the group slug (FAC-END teams, docs/spec/13-deployment.md). */
export const DEFAULT_TEAM_NAMING: NamingPipeline = {
  steps: [
    { var: 'group', op: 'slug' },
    { var: 'group', op: 'kebab' },
  ],
  template: '{group}',
};

/** Unique members by principal, sorted by `kind:id`. */
function uniqueMembers(members: readonly TeamMember[]): TeamMember[] {
  const byKey = new Map(members.map((m) => [principalLabel(m.principal), m]));
  return [...byKey.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([, m]) => m);
}

export function normalizeTeams(data: Teams): Teams {
  return { teams: data.teams.map((t) => ({ ...t, members: uniqueMembers(t.members) })) };
}

/**
 * `ctx.route.defaults.teamNaming`, validated; the default pipeline when absent. A malformed
 * pipeline is a configuration error and throws.
 */
export function routeTeamNaming(route: TranslateContext['route']): NamingPipeline {
  const defaults = route.defaults;
  const configured =
    typeof defaults === 'object' && defaults !== null
      ? (defaults as Record<string, unknown>).teamNaming
      : undefined;
  if (configured === undefined) return DEFAULT_TEAM_NAMING;
  const p = configured as Partial<NamingPipeline> | null;
  if (
    typeof p !== 'object' ||
    p === null ||
    !Array.isArray(p.steps) ||
    typeof p.template !== 'string'
  ) {
    throw new TypeError('route.defaults.teamNaming must be a naming pipeline');
  }
  return p as NamingPipeline;
}

/** The target's team slug rules: lowercase letters, digits and single dashes inside. */
const TEAM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `ctx.routeIndex.plannedSlugs`: GroupMapping `plannedSlug` by source group slug. */
function plannedSlugs(
  routeIndex: TranslateContext['routeIndex'],
): Readonly<Record<string, string>> {
  const configured = routeIndex.plannedSlugs;
  if (configured === undefined) return {};
  if (
    typeof configured !== 'object' ||
    configured === null ||
    Array.isArray(configured) ||
    Object.values(configured).some((v) => typeof v !== 'string')
  ) {
    throw new TypeError('routeIndex.plannedSlugs must map source group slugs to slugs');
  }
  return configured as Record<string, string>;
}

/**
 * The target slug of a source team: the created team's id when the group is mapped, else the
 * GroupMapping `plannedSlug`, else the Route's team naming pipeline over the group (LIF-030).
 * `null` when the pipeline cannot produce a slug.
 */
export function plannedSlug(team: Team, ctx: TranslateContext): string | null {
  const resolved = ctx.groups.resolve({ kind: 'group', id: team.slug });
  if (resolved.status === 'mapped' && resolved.principal.kind === 'group') {
    return resolved.principal.id;
  }
  const planned = Object.hasOwn(plannedSlugs(ctx.routeIndex), team.slug)
    ? plannedSlugs(ctx.routeIndex)[team.slug]
    : undefined;
  if (planned !== undefined) return TEAM_SLUG.test(planned) ? planned : null;
  const run = runNamingPipeline(routeTeamNaming(ctx.route), {
    group: { slug: team.slug, name: team.name },
  });
  return run.ok && run.value !== '' ? run.value : null;
}

const teamPath = (slug: string, ...rest: string[]) =>
  formatFieldPath([itemSeg('teams', 'slug', slug), ...rest.map(seg)]);
const memberPath = (slug: string, p: PrincipalRef) =>
  formatFieldPath([itemSeg('teams', 'slug', slug), principalSeg('members', p)]);

export function translateTeams(source: Teams, ctx: TranslateContext): TranslationResult<Teams> {
  const decisions: FieldDecision[] = [];
  const blockers: Finding[] = [];
  const preTasks: Finding[] = [];
  const postTasks: Finding[] = [];

  // 1. Target slugs, and the teams that cannot be created.
  const planned = new Map<string, Team[]>(); // case-folded target slug -> source teams
  const slugOf = new Map<Team, string>();
  for (const team of source.teams) {
    const slug = plannedSlug(team, ctx);
    if (slug === null) {
      decisions.push({ path: teamPath(team.slug), fidelity: 'unsupported', accepted: false });
      blockers.push({
        code: 'teams.slug-invalid',
        paths: [teamPath(team.slug)],
        params: { team: team.slug },
      });
      continue;
    }
    slugOf.set(team, slug);
    const folded = slug.toLowerCase();
    planned.set(folded, [...(planned.get(folded) ?? []), team]);
  }

  // 2. Collisions: no team of a colliding group is created, so no choice is made silently.
  const kept: Team[] = [];
  for (const group of planned.values()) {
    const first = group[0] as Team;
    if (group.length > 1) {
      for (const t of group) {
        decisions.push({ path: teamPath(t.slug), fidelity: 'unsupported', accepted: false });
      }
      blockers.push({
        code: 'teams.slug-collision',
        paths: group.map((t) => teamPath(t.slug)),
        params: {
          team: slugOf.get(first) as string,
          groups: uniqueSorted(group.map((t) => t.slug)),
        },
      });
      continue;
    }
    kept.push(first);
  }

  // 3. Membership of the remaining teams (FAC-006). Only existing org members are added: a team
  // write would invite anybody else (AUTH-061), so a principal must be in `targetOrgMembers`.
  const orgMembers = targetOrgMembers(ctx.routeIndex);
  const unmapped = new Map<string, string[]>();
  const pending = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, path: string) =>
    map.set(key, [...(map.get(key) ?? []), path]);
  const membershipUnreadable = ctx.sourceCaps.fields[MEMBERSHIP_FIELD]?.kind === 'unreadable';

  const teams: Team[] = kept.map((team) => {
    const slug = slugOf.get(team) as string;
    if (slug !== team.slug) {
      decisions.push({
        path: teamPath(team.slug, 'slug'),
        fidelity: 'translated',
        accepted: false,
      });
    }
    if (membershipUnreadable) {
      const path = teamPath(team.slug, 'members');
      decisions.push({ path, fidelity: 'unreadable', accepted: false });
      postTasks.push({ code: 'teams.set-membership', paths: [path], params: { team: slug } });
      return { slug, name: team.name, members: [] };
    }
    const members: TeamMember[] = [];
    for (const member of team.members) {
      const path = memberPath(team.slug, member.principal);
      const label = principalLabel(member.principal);
      const resolution = resolvePrincipal(member.principal, ctx);
      switch (resolution.status) {
        case 'mapped': {
          const target = principalLabel(resolution.principal);
          // Not an org member: never invite through a team.
          if (
            resolution.principal.kind !== 'identity' ||
            !orgMembers.has(resolution.principal.id)
          ) {
            break;
          }
          members.push({ principal: resolution.principal });
          if (target !== label) decisions.push({ path, fidelity: 'translated', accepted: false });
          break;
        }
        case 'excluded':
          break; // the identity_excluded Expected Difference exists (AUTH-050)
        case 'pending_invite':
          decisions.push({ path, fidelity: 'unsupported', accepted: false });
          push(pending, label, path);
          break;
        case 'unmapped':
        case 'team_missing':
          decisions.push({ path, fidelity: 'unsupported', accepted: false });
          push(unmapped, label, path);
          break;
      }
    }
    return { slug, name: team.name, members: uniqueMembers(members) };
  });

  // One task per principal, however many teams it appears in (the task identity is code + params).
  for (const [label, paths] of [...unmapped].sort(([a], [b]) => compareCodeUnits(a, b))) {
    preTasks.push({
      code: 'teams.unmapped-principal',
      paths,
      params: { principal: label, facet: 'teams' },
    });
  }
  for (const [label, paths] of [...pending].sort(([a], [b]) => compareCodeUnits(a, b))) {
    postTasks.push({
      code: 'teams.pending-invitation',
      paths,
      params: { principal: label, facet: 'teams' },
    });
  }

  return {
    desired: normalizeTeams({ teams }),
    decisions,
    blockers,
    preTasks,
    postTasks,
    warnings: [],
  };
}

/** Parity ignores target-only teams and members: the organization keeps its own (ADR-0150). */
export function compareTeams(desired: Teams, actual: Teams): FieldDiff[] {
  return diffDesiredOnly(desired, actual, teamsFacet.documentSchema);
}

/**
 * `teams.set-membership` is done once the target team exists and has members: the expected members
 * are unknown, so that is the strongest check available. `teams.pending-invitation` follows
 * ADR-0105: `params.targetPrincipal` (`kind:id`) must be a member of some target team.
 */
export function isTeamsTaskSatisfied(task: FacetTaskRef, target: Teams): boolean {
  if (task.code === 'teams.set-membership') {
    const slug = paramString(task.params, 'team')?.toLowerCase();
    if (slug === undefined) return false;
    return target.teams.some((t) => t.slug.toLowerCase() === slug && t.members.length > 0);
  }
  if (task.code === 'teams.pending-invitation') {
    const wanted = paramString(task.params, 'targetPrincipal');
    return (
      wanted !== undefined &&
      target.teams.some((t) => t.members.some((m) => principalLabel(m.principal) === wanted))
    );
  }
  return false;
}

export const teamsDefinition: FacetDefinition<Teams> = {
  key: teamsFacet.key,
  scope: teamsFacet.scope,
  schemaVersion: teamsFacet.schemaVersion,
  schema: teamsFacet.schema,
  compareMode: 'full',
  collections: teamsFacet.collections,
  sets: teamsFacet.sets,
  dependsOn: ['members'],
  inScope: true,
  normalize: normalizeTeams,
  translate: translateTeams,
  compare: (desired, actual) => compareTeams(desired, actual),
  findingCodes: TEAMS_FINDING_CODES,
  policyKeys: [],
  isTaskSatisfied: (task, target) => isTeamsTaskSatisfied(task, target),
};
