/**
 * code-ownership (FAC-COD): the owners of path patterns. In the source these are the effective
 * default reviewers (one entry, pattern `*`); the target holds them as a code-owners file that the
 * framework delivers through a Change Request. Rendering and delivering the file is the adapter's
 * job; this module decides which principals can be owners, the lossiness and the findings.
 * Decisions: docs/adr/0106-code-ownership-facet.md.
 */
import {
  type AccessControl,
  type AccessRole,
  type CodeOwnership,
  codeOwnershipFacet,
  type PrincipalEntry,
  type PrincipalRef,
  type Teams,
} from '@git-migrator/canonical';
import {
  diffDocuments,
  type FacetDefinition,
  type FieldDecision,
  type Finding,
  type FindingCodeSpec,
  formatFieldPath,
  itemSeg,
  type TranslateContext,
} from '@git-migrator/core';
import { roleRank } from '../access-control/index.ts';
import {
  principalIsGranted,
  principalLabel,
  resolvePrincipal,
  samePrincipal,
} from '../access-control/principals.ts';

/** The Change Request branch that carries the generated file (LIF-047). */
export const CODEOWNERS_BRANCH = 'git-migrator/codeowners';

export const CODE_OWNERSHIP_FINDING_CODES = {
  'code-ownership.review-and-merge': { kind: 'post', completion: 'parity' },
  'code-ownership.accept-lossy': { kind: 'pre', completion: 'accept' },
  'code-ownership.unmapped-principal': { kind: 'pre', completion: 'resolution' },
  'code-ownership.pending-invitation': { kind: 'post', completion: 'parity' },
  'code-ownership.team-missing': { kind: 'blocker' },
  'code-ownership.team-membership-unknown': { kind: 'warning' },
} as const satisfies Record<string, FindingCodeSpec>;

export const CODE_OWNERSHIP_POLICY_KEYS = [
  'code-ownership.default-reviewers-as-codeowners',
  'code-ownership.owner-insufficient-access',
] as const;

type Owner = CodeOwnership['owners'][number];

/** The least role that lets a principal own code. */
const MIN_OWNER_ROLE = 'write';

function ownerPath(pattern: string): string {
  return formatFieldPath([itemSeg('owners', 'pattern', pattern)]);
}

function ownerPrincipalPath(pattern: string, principal: PrincipalEntry['principal']): string {
  return formatFieldPath([
    itemSeg('owners', 'pattern', pattern),
    itemSeg('principals', 'principal', principalLabel(principal)),
  ]);
}

/** Merges entries with the same pattern (union of principals); drops duplicate principals. */
function mergeOwners(owners: readonly Owner[]): Owner[] {
  const byPattern = new Map<string, Map<string, PrincipalEntry>>();
  for (const o of owners) {
    const principals = byPattern.get(o.pattern) ?? new Map<string, PrincipalEntry>();
    for (const e of o.principals) principals.set(principalLabel(e.principal), e);
    byPattern.set(o.pattern, principals);
  }
  return [...byPattern].map(([pattern, principals]) => ({
    pattern,
    principals: [...principals.values()],
  }));
}

type Access = 'sufficient' | 'insufficient' | 'unknown';

const hasOwnerRole = (role: AccessRole): boolean => roleRank(role) >= roleRank(MIN_OWNER_ROLE);

/** The translated and the source teams document; the engine hands both to a dependent. */
interface TeamsDeps {
  readonly source: Teams;
  readonly desired: Teams;
}

type Team = Teams['teams'][number];

const groupRef = (id: string): PrincipalRef => ({ kind: 'group', id });

/**
 * The source team whose group the Route maps to the target group `target` (the planned slug may
 * differ from the source slug after naming). `undefined` when no source team maps to it.
 */
function sourceTeamOf(
  target: PrincipalRef,
  source: Teams,
  ctx: TranslateContext,
): Team | undefined {
  return source.teams.find((t) => {
    const r = resolvePrincipal(groupRef(t.slug), ctx);
    return r.status === 'mapped' && samePrincipal(r.principal, target);
  });
}

/**
 * Whether the desired membership of a team can be trusted: a source team maps to it, the source
 * team has members, and every source member missing from `desired` is explained by its resolution
 * (excluded, pending invitation, unmapped or team missing), i.e. none was skipped. A source team
 * without members is indistinguishable from unreadable membership and is not trusted.
 */
function membershipKnown(desired: Team, source: Team | undefined, ctx: TranslateContext): boolean {
  if (source === undefined || source.members.length === 0) return false;
  return source.members.every((m) => {
    const r = resolvePrincipal(m.principal, ctx);
    return (
      r.status !== 'mapped' || desired.members.some((d) => samePrincipal(d.principal, r.principal))
    );
  });
}

/**
 * Whether `target` can own code: a direct grant of write or more, or (for an identity) membership
 * of a team with such a grant. `unknown` when a team that grants it might hold the owner but its
 * membership cannot be trusted (no teams document, the team is missing from it, or
 * `membershipKnown` fails). Group ids compare case-insensitively, identities exactly. Without the
 * access-control document nothing is judged (ADR-0106).
 */
function accessOf(
  target: PrincipalRef,
  acl: AccessControl | undefined,
  teams: TeamsDeps | undefined,
  ctx: TranslateContext,
): Access {
  if (acl === undefined) return 'sufficient';
  const direct = acl.grants.find((g) => samePrincipal(g.principal, target));
  if (direct !== undefined && hasOwnerRole(direct.role)) return 'sufficient';
  if (target.kind === 'group') return 'insufficient';
  const teamGrants = acl.grants.filter((g) => g.principal.kind === 'group' && hasOwnerRole(g.role));
  if (teamGrants.length === 0) return 'insufficient';
  if (teams === undefined) return 'unknown';
  let unknown = false;
  for (const g of teamGrants) {
    const team = teams.desired.teams.find((t) => samePrincipal(groupRef(t.slug), g.principal));
    if (team === undefined) {
      unknown = true;
      continue;
    }
    if (team.members.some((m) => samePrincipal(m.principal, target))) return 'sufficient';
    if (!membershipKnown(team, sourceTeamOf(g.principal, teams.source, ctx), ctx)) unknown = true;
  }
  return unknown ? 'unknown' : 'insufficient';
}

export const codeOwnership: FacetDefinition<CodeOwnership> = {
  key: codeOwnershipFacet.key,
  scope: codeOwnershipFacet.scope,
  schemaVersion: codeOwnershipFacet.schemaVersion,
  schema: codeOwnershipFacet.schema,
  compareMode: 'full',
  collections: codeOwnershipFacet.collections,
  sets: codeOwnershipFacet.sets,
  dependsOn: ['access-control', 'teams'],
  inScope: true,
  normalize: (data) => ({ owners: mergeOwners(data.owners) }),
  translate(source, ctx) {
    // Without the translated access-control document the access check cannot be made, and no
    // owner is dropped for it.
    const acl = ctx.deps['access-control']?.desired as AccessControl | undefined;
    const teams = ctx.deps.teams as TeamsDeps | undefined;
    const decisions: FieldDecision[] = [];
    const blockers: Finding[] = [];
    const preTasks: Finding[] = [];
    const postTasks: Finding[] = [];
    const warnings: Finding[] = [];
    const owners: Owner[] = [];

    for (const entry of source.owners) {
      const principals: PrincipalEntry[] = [];
      for (const { principal } of entry.principals) {
        const path = ownerPrincipalPath(entry.pattern, principal);
        const label = principalLabel(principal);
        const resolution = resolvePrincipal(principal, ctx);
        if (resolution.status === 'mapped') {
          const target = resolution.principal;
          const access = accessOf(target, acl, teams, ctx);
          if (access === 'insufficient') {
            decisions.push({
              path,
              fidelity: 'lossy',
              policyKey: 'code-ownership.owner-insufficient-access',
              accepted: false,
            });
          } else {
            if (access === 'unknown') {
              warnings.push({
                code: 'code-ownership.team-membership-unknown',
                paths: [path],
                params: { principal: label },
              });
            }
            if (!principals.some((p) => samePrincipal(p.principal, target))) {
              principals.push({ principal: target });
            }
          }
        } else if (resolution.status === 'pending_invite') {
          decisions.push({ path, fidelity: 'unsupported', accepted: false });
          postTasks.push({
            code: 'code-ownership.pending-invitation',
            paths: [path],
            params: { principal: label, facet: 'code-ownership' },
          });
        } else if (resolution.status === 'team_missing') {
          decisions.push({ path, fidelity: 'unsupported', accepted: false });
          blockers.push({
            code: 'code-ownership.team-missing',
            paths: [path],
            params: { team: principal.id },
          });
        } else if (resolution.status === 'unmapped') {
          decisions.push({ path, fidelity: 'unsupported', accepted: false });
          preTasks.push({
            code: 'code-ownership.unmapped-principal',
            paths: [path],
            params: { principal: label, facet: 'code-ownership' },
          });
        }
      }
      if (principals.length > 0) {
        // The lossy mapping only matters when an entry reaches the target. An entry without
        // owners is left out: in a code-owners file it would remove ownership.
        decisions.push({
          path: ownerPath(entry.pattern),
          fidelity: 'lossy',
          policyKey: 'code-ownership.default-reviewers-as-codeowners',
          accepted: false,
        });
        owners.push({ pattern: entry.pattern, principals });
      }
    }

    if (owners.length > 0) {
      postTasks.push({
        code: 'code-ownership.review-and-merge',
        paths: ['/owners'],
        params: { branch: CODEOWNERS_BRANCH },
      });
    }

    return { desired: { owners }, decisions, blockers, preTasks, postTasks, warnings };
  },
  compare: (desired, actual) => diffDocuments(desired, actual, codeOwnershipFacet.documentSchema),
  findingCodes: CODE_OWNERSHIP_FINDING_CODES,
  policyKeys: CODE_OWNERSHIP_POLICY_KEYS,
  isTaskSatisfied(task, target, parity) {
    if (task.code === 'code-ownership.review-and-merge') {
      // Merged when the target holds owners and nothing under /owners differs any more.
      return target.owners.length > 0 && !parity.some((d) => d.path.startsWith('/owners'));
    }
    if (task.code === 'code-ownership.pending-invitation') {
      return principalIsGranted(
        target.owners.flatMap((o) => o.principals.map((p) => p.principal)),
        task.params,
      );
    }
    return false;
  },
};
