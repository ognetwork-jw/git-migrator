import type { AccessControl, CodeOwnership, Teams } from '@git-migrator/canonical';
import { compareFacet, FacetRegistry, satisfiedTasks, translateFacet } from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import { accessControl } from '../access-control/index.ts';
import {
  envOf,
  group,
  identity,
  mapped,
  prng,
  type ResolutionTable,
  randomTable,
  SAMPLE_STATUSES,
  shuffle,
} from '../test-support.ts';
import {
  CODE_OWNERSHIP_FINDING_CODES,
  CODE_OWNERSHIP_POLICY_KEYS,
  CODEOWNERS_BRANCH,
  codeOwnership,
} from './index.ts';

const registry = new FacetRegistry().register(accessControl).register(codeOwnership);

const reviewers = (...ids: string[]): CodeOwnership => ({
  owners: [{ pattern: '*', principals: ids.map((id) => ({ principal: identity(id) })) }],
});

const aclOf = (...grants: [string, AccessControl['grants'][number]['role']][]): AccessControl => ({
  grants: grants.map(([id, role]) => ({ principal: identity(id), role })),
});

function run(
  source: CodeOwnership,
  table: ResolutionTable,
  acl?: AccessControl,
  acceptLossy: string[] = [],
  teams?: Teams,
  teamsSource: Teams | undefined = teams,
) {
  const r = translateFacet(registry, 'code-ownership', source, {
    env: envOf(table, acceptLossy),
    deps: {
      ...(acl === undefined ? {} : { 'access-control': { source: acl, desired: acl } }),
      ...(teams === undefined ? {} : { teams: { source: teamsSource ?? teams, desired: teams } }),
    },
  });
  return { ...r, desired: r.desired as CodeOwnership };
}

const table: ResolutionTable = {
  'identity:1': mapped(identity('A')),
  'identity:2': mapped(identity('B')),
};

describe('code-ownership facet', () => {
  it('[FAC-001] is declared from the canonical schema and passes registry validation', () => {
    expect(registry.get('code-ownership').dependsOn).toEqual(['access-control', 'teams']);
    expect(Object.keys(CODE_OWNERSHIP_FINDING_CODES).sort()).toEqual([
      'code-ownership.accept-lossy',
      'code-ownership.pending-invitation',
      'code-ownership.review-and-merge',
      'code-ownership.team-membership-unknown',
      'code-ownership.team-missing',
      'code-ownership.unmapped-principal',
    ]);
    expect(CODE_OWNERSHIP_POLICY_KEYS).toHaveLength(2);
  });

  it('[FAC-COD] default reviewers become one entry per pattern with target principals', () => {
    const r = run(reviewers('1', '2'), table, aclOf(['A', 'write'], ['B', 'admin']));
    expect(r.desired).toEqual({
      owners: [
        { pattern: '*', principals: [{ principal: identity('A') }, { principal: identity('B') }] },
      ],
    });
    expect(r.blockers).toEqual([]);
  });

  it('[FAC-COD] the default-reviewers mapping is lossy and needs acceptance', () => {
    const r = run(reviewers('1'), table, aclOf(['A', 'write']));
    expect(r.decisions).toEqual([
      {
        path: '/owners[pattern=\\*]',
        fidelity: 'lossy',
        policyKey: 'code-ownership.default-reviewers-as-codeowners',
        accepted: false,
      },
    ]);
    expect(r.preTasks).toEqual([
      {
        code: 'code-ownership.accept-lossy',
        paths: ['/owners[pattern=\\*]'],
        params: {
          policyKey: 'code-ownership.default-reviewers-as-codeowners',
          paths: ['/owners[pattern=\\*]'],
        },
        kind: 'pre',
        verifiable: false,
      },
    ]);
  });

  it('[FAC-005] a Route policy accepts the lossy mapping and records an Expected Difference', () => {
    const r = run(reviewers('1'), table, aclOf(['A', 'write']), [
      'code-ownership.default-reviewers-as-codeowners',
    ]);
    expect(r.preTasks).toEqual([]);
    expect(r.decisions[0]?.accepted).toBe('policy');
    expect(r.expectedDifferences).toEqual([
      {
        facetKey: 'code-ownership',
        path: '/owners[pattern=\\*]',
        reason: 'lossy_accepted',
        note: 'code-ownership.default-reviewers-as-codeowners',
      },
    ]);
  });

  it('[FAC-COD] an entry without principals is not lossy and is left out', () => {
    const r = run({ owners: [{ pattern: '*', principals: [] }] }, table, aclOf());
    expect(r.decisions).toEqual([]);
    expect(r.desired).toEqual({ owners: [] });
    expect(r.postTasks).toEqual([]);
  });

  it('[FAC-COD] emits the review-and-merge post task for the generated file', () => {
    const r = run(reviewers('1'), table, aclOf(['A', 'write']));
    expect(r.postTasks).toEqual([
      {
        code: 'code-ownership.review-and-merge',
        paths: ['/owners'],
        params: { branch: CODEOWNERS_BRANCH },
        kind: 'post',
        verifiable: true,
      },
    ]);
    expect(CODEOWNERS_BRANCH).toBe('git-migrator/codeowners');
  });

  it('[FAC-COD] an owner with less than write access is omitted, lossy owner-insufficient-access', () => {
    const r = run(reviewers('1', '2'), table, aclOf(['A', 'read'], ['B', 'maintain']));
    expect(r.desired.owners[0]?.principals).toEqual([{ principal: identity('B') }]);
    const d = r.decisions.find((x) => x.policyKey === 'code-ownership.owner-insufficient-access');
    expect(d).toMatchObject({
      path: '/owners[pattern=\\*]/principals[principal=identity:1]',
      fidelity: 'lossy',
    });
    expect(r.preTasks.map((t) => t.params.policyKey).sort()).toEqual([
      'code-ownership.default-reviewers-as-codeowners',
      'code-ownership.owner-insufficient-access',
    ]);
  });

  it('[FAC-COD] an owner without any grant is omitted; the entry goes when no owner remains', () => {
    const r = run(reviewers('1'), table, aclOf(['Z', 'admin']));
    expect(r.desired).toEqual({ owners: [] });
    expect(r.postTasks).toEqual([]);
    expect(
      r.decisions.some((d) => d.policyKey === 'code-ownership.owner-insufficient-access'),
    ).toBe(true);
  });

  it('[FAC-COD] without the access-control result no owner is dropped for access', () => {
    const r = run(reviewers('1'), table);
    expect(r.desired.owners[0]?.principals).toEqual([{ principal: identity('A') }]);
  });

  it('[FAC-006] an excluded owner is omitted without a finding', () => {
    const r = run(
      reviewers('1', '2'),
      { ...table, 'identity:1': { status: 'excluded' } },
      aclOf(['B', 'write']),
    );
    expect(r.desired.owners[0]?.principals).toEqual([{ principal: identity('B') }]);
    expect([...r.preTasks, ...r.postTasks].map((t) => t.code)).toEqual([
      'code-ownership.accept-lossy',
      'code-ownership.review-and-merge',
    ]);
  });

  it('[FAC-006] a pending invitation omits the owner and raises code-ownership.pending-invitation', () => {
    const r = run(
      reviewers('1', '2'),
      { ...table, 'identity:1': { status: 'pending_invite' } },
      aclOf(['B', 'write']),
    );
    const t = r.postTasks.find((x) => x.code === 'code-ownership.pending-invitation');
    expect(t).toEqual({
      code: 'code-ownership.pending-invitation',
      paths: ['/owners[pattern=\\*]/principals[principal=identity:1]'],
      params: { principal: 'identity:1', facet: 'code-ownership' },
      kind: 'post',
      verifiable: true,
    });
  });

  it('[FAC-006] an unmapped owner raises code-ownership.unmapped-principal', () => {
    const r = run(reviewers('9'), {}, aclOf());
    expect(r.preTasks.map((t) => t.code)).toContain('code-ownership.unmapped-principal');
    expect(r.desired).toEqual({ owners: [] });
  });

  it('[FAC-006] a group owner whose team is not created blocks with code-ownership.team-missing', () => {
    const source: CodeOwnership = {
      owners: [{ pattern: '*', principals: [{ principal: group('devs') }] }],
    };
    const r = run(source, { 'group:devs': { status: 'team_missing' } }, aclOf());
    expect(r.blockers).toEqual([
      {
        code: 'code-ownership.team-missing',
        paths: ['/owners[pattern=\\*]/principals[principal=group:devs]'],
        params: { team: 'devs' },
        kind: 'blocker',
        verifiable: false,
      },
    ]);
    expect(r.preTasks.map((t) => t.code)).not.toContain('code-ownership.unmapped-principal');
  });

  it('[FAC-COD] an owner with access only through a team is kept', () => {
    const acl: AccessControl = { grants: [{ principal: group('T'), role: 'write' }] };
    const teams: Teams = {
      teams: [{ slug: 'T', name: 'T', members: [{ principal: identity('A') }] }],
    };
    const r = run(reviewers('1'), table, acl, [], teams);
    expect(r.desired.owners[0]?.principals).toEqual([{ principal: identity('A') }]);
    expect(r.warnings).toEqual([]);
    expect(
      r.decisions.some((d) => d.policyKey === 'code-ownership.owner-insufficient-access'),
    ).toBe(false);
  });

  it('[FAC-COD] an owner who is not in the team that holds write is omitted', () => {
    const acl: AccessControl = { grants: [{ principal: group('T'), role: 'write' }] };
    const teams: Teams = {
      teams: [{ slug: 'T', name: 'T', members: [{ principal: identity('Z') }] }],
    };
    const known = {
      ...table,
      'group:T': mapped(group('T')),
      'identity:Z': mapped(identity('Z')),
    };
    const r = run(reviewers('1'), known, acl, [], teams);
    expect(r.desired).toEqual({ owners: [] });
    expect(r.warnings).toEqual([]);
  });

  it('[FAC-COD] without team data an owner who a team might cover is kept, with a warning', () => {
    const acl: AccessControl = { grants: [{ principal: group('T'), role: 'admin' }] };
    const r = run(reviewers('1'), table, acl);
    expect(r.desired.owners[0]?.principals).toEqual([{ principal: identity('A') }]);
    expect(r.warnings).toEqual([
      {
        code: 'code-ownership.team-membership-unknown',
        paths: ['/owners[pattern=\\*]/principals[principal=identity:1]'],
        params: { principal: 'identity:1' },
        kind: 'warning',
        verifiable: false,
      },
    ]);
  });

  it('[FAC-COD] a group owner needs its own grant; membership data does not help', () => {
    const source: CodeOwnership = {
      owners: [{ pattern: '*', principals: [{ principal: group('g') }] }],
    };
    const acl: AccessControl = { grants: [{ principal: group('T'), role: 'write' }] };
    const r = run(source, { 'group:g': mapped(group('T2')) }, acl);
    expect(r.desired).toEqual({ owners: [] });
  });

  it('[FAC-COD] the lossy default-reviewers decision is only recorded for an entry that reaches the target', () => {
    const r = run(reviewers('1'), table, aclOf(['A', 'read']));
    expect(r.decisions.map((d) => d.policyKey)).toEqual([
      'code-ownership.owner-insufficient-access',
    ]);
    expect(r.preTasks.map((t) => t.params.policyKey)).toEqual([
      'code-ownership.owner-insufficient-access',
    ]);
  });

  it('[ADP-021] merges duplicate patterns and principals and sorts by key', () => {
    const source: CodeOwnership = {
      owners: [
        { pattern: 'b', principals: [{ principal: identity('2') }] },
        { pattern: 'a', principals: [{ principal: identity('1') }, { principal: identity('1') }] },
        { pattern: 'b', principals: [{ principal: identity('1') }, { principal: identity('2') }] },
      ],
    };
    const r = run(source, table, aclOf(['A', 'write'], ['B', 'write']));
    expect(r.source).toEqual({
      owners: [
        { pattern: 'a', principals: [{ principal: identity('1') }] },
        { pattern: 'b', principals: [{ principal: identity('1') }, { principal: identity('2') }] },
      ],
    });
  });

  it('[FAC-COD] two sources mapping to one owner list it once', () => {
    const r = run(
      reviewers('1', '2'),
      { 'identity:1': mapped(identity('A')), 'identity:2': mapped(identity('A')) },
      aclOf(['A', 'write']),
    );
    expect(r.desired.owners[0]?.principals).toEqual([{ principal: identity('A') }]);
  });

  it('[FAC-COD] compares owners by pattern and principal, ignoring order', () => {
    const desired = reviewers('A', 'B');
    const same = compareFacet(registry, 'code-ownership', desired, reviewers('B', 'A'));
    expect(same?.status).toBe('equal');
    const diff = compareFacet(registry, 'code-ownership', desired, reviewers('A', 'C'));
    expect(diff?.status).toBe('different');
    expect(diff?.diffs.length).toBeGreaterThan(0);
  });

  it('[LIF-061] review-and-merge is satisfied once the target holds the owners with no diff', () => {
    const task = { code: 'code-ownership.review-and-merge', params: { branch: CODEOWNERS_BRANCH } };
    const merged = reviewers('A');
    expect(satisfiedTasks(registry, 'code-ownership', [task], merged, [])).toEqual([task]);
    expect(satisfiedTasks(registry, 'code-ownership', [task], { owners: [] }, [])).toEqual([]);
    const drift = [
      { path: '/owners[pattern=\\*]/principals[principal=identity:A]', desired: 1, actual: 2 },
    ];
    expect(satisfiedTasks(registry, 'code-ownership', [task], merged, drift)).toEqual([]);
  });

  it('[LIF-061] a pending-invitation task is satisfied only when the target owners hold its principal', () => {
    const task = {
      code: 'code-ownership.pending-invitation',
      params: { targetPrincipal: 'identity:A' },
    };
    expect(satisfiedTasks(registry, 'code-ownership', [task], reviewers('A'), [])).toEqual([task]);
    expect(satisfiedTasks(registry, 'code-ownership', [task], reviewers('B'), [])).toEqual([]);
    const other = { code: 'code-ownership.unmapped-principal', params: {} };
    expect(codeOwnership.isTaskSatisfied?.(other, reviewers('A'), [])).toBe(false);
  });

  const aclTeam: AccessControl = { grants: [{ principal: group('T'), role: 'write' }] };
  const teamOf = (slug: string, ...ids: string[]): Teams => ({
    teams: [{ slug, name: slug, members: ids.map((id) => ({ principal: identity(id) })) }],
  });

  it('[FAC-COD] a granting team present with no members keeps the owner and warns', () => {
    const r = run(reviewers('1'), table, aclTeam, [], teamOf('T'));
    expect(r.desired.owners[0]?.principals).toEqual([{ principal: identity('A') }]);
    expect(r.warnings.map((w) => w.code)).toEqual(['code-ownership.team-membership-unknown']);
  });

  it('[FAC-COD] a granting team missing from the teams document keeps the owner and warns', () => {
    const r = run(reviewers('1'), table, aclTeam, [], teamOf('Other', 'Z'));
    expect(r.desired.owners[0]?.principals).toEqual([{ principal: identity('A') }]);
    expect(r.warnings.map((w) => w.code)).toEqual(['code-ownership.team-membership-unknown']);
  });

  /** Maps the source team `T` to the target team `T` and the members Z and Y to themselves. */
  const teamTable: ResolutionTable = {
    ...table,
    'group:T': mapped(group('T')),
    'identity:Z': mapped(identity('Z')),
    'identity:Y': mapped(identity('Y')),
  };

  it('[FAC-COD] a team with fewer members than in the source (membership skipped) keeps the owner and warns', () => {
    const r = run(reviewers('1'), teamTable, aclTeam, [], teamOf('T', 'Z'), teamOf('T', 'Z', 'Y'));
    expect(r.desired.owners[0]?.principals).toEqual([{ principal: identity('A') }]);
    expect(r.warnings).toHaveLength(1);
  });

  it('[FAC-COD] a known non-empty team that lacks the owner makes it insufficient', () => {
    const r = run(reviewers('1'), teamTable, aclTeam, [], teamOf('T', 'Z'), teamOf('T', 'Z'));
    expect(r.desired).toEqual({ owners: [] });
    expect(r.warnings).toEqual([]);
  });

  it('[FAC-COD] source members missing from desired but explained by their resolution keep membership known', () => {
    for (const status of [
      { status: 'excluded' },
      { status: 'pending_invite' },
      { status: 'unmapped' },
    ] as const) {
      const tbl: ResolutionTable = { ...teamTable, 'identity:Y': status };
      const r = run(reviewers('1'), tbl, aclTeam, [], teamOf('T', 'Z'), teamOf('T', 'Z', 'Y'));
      expect(r.desired).toEqual({ owners: [] });
      expect(r.warnings).toEqual([]);
    }
  });

  it('[FAC-COD] a known source team whose members all resolve away makes an empty desired team known', () => {
    const tbl: ResolutionTable = { ...teamTable, 'identity:Z': { status: 'excluded' } };
    const r = run(reviewers('1'), tbl, aclTeam, [], teamOf('T'), teamOf('T', 'Z'));
    expect(r.desired).toEqual({ owners: [] });
    expect(r.warnings).toEqual([]);
  });

  it('[FAC-COD] no source team mapping to the granting team leaves membership unknown', () => {
    const r = run(reviewers('1'), table, aclTeam, [], teamOf('T', 'Z'), teamOf('T', 'Z'));
    expect(r.desired.owners[0]?.principals).toEqual([{ principal: identity('A') }]);
    expect(r.warnings.map((w) => w.code)).toEqual(['code-ownership.team-membership-unknown']);
  });

  describe('a team renamed by the naming pipeline', () => {
    const acl: AccessControl = { grants: [{ principal: group('dev-team'), role: 'write' }] };
    const renamed: ResolutionTable = {
      ...teamTable,
      'group:Dev_Team': mapped(group('dev-team')),
    };

    it('[FAC-COD] a partly skipped renamed team lacking the owner is unknown: owner kept with the warning', () => {
      const r = run(
        reviewers('1'),
        renamed,
        acl,
        [],
        teamOf('dev-team', 'Z'),
        teamOf('Dev_Team', 'Z', 'Y'),
      );
      expect(r.desired.owners[0]?.principals).toEqual([{ principal: identity('A') }]);
      expect(r.warnings).toEqual([
        {
          code: 'code-ownership.team-membership-unknown',
          paths: ['/owners[pattern=\\*]/principals[principal=identity:1]'],
          params: { principal: 'identity:1' },
          kind: 'warning',
          verifiable: false,
        },
      ]);
    });

    it('[FAC-COD] a complete renamed team lacking the owner is insufficient', () => {
      const r = run(
        reviewers('1'),
        renamed,
        acl,
        [],
        teamOf('dev-team', 'Z', 'Y'),
        teamOf('Dev_Team', 'Z', 'Y'),
      );
      expect(r.desired).toEqual({ owners: [] });
      expect(r.warnings).toEqual([]);
    });

    it('[FAC-COD] the source team is found through the mapping, ignoring case of the target id', () => {
      const tbl: ResolutionTable = { ...renamed, 'group:Dev_Team': mapped(group('Dev-Team')) };
      const r = run(
        reviewers('1'),
        tbl,
        acl,
        [],
        teamOf('dev-team', 'Z', 'Y'),
        teamOf('Dev_Team', 'Z', 'Y'),
      );
      expect(r.desired).toEqual({ owners: [] });
      expect(r.warnings).toEqual([]);
    });
  });

  it('[FAC-COD] a group owner matches its own grant ignoring case; duplicates differing in case are listed once', () => {
    const source: CodeOwnership = {
      owners: [
        { pattern: '*', principals: [{ principal: group('g') }, { principal: group('h') }] },
      ],
    };
    const acl: AccessControl = { grants: [{ principal: group('devs'), role: 'write' }] };
    const r = run(
      source,
      { 'group:g': mapped(group('Devs')), 'group:h': mapped(group('DEVS')) },
      acl,
    );
    expect(r.desired.owners[0]?.principals).toEqual([{ principal: group('Devs') }]);
    expect(r.warnings).toEqual([]);
  });

  it('[FAC-COD] identities compare exactly: a grant to another case does not count', () => {
    const r = run(reviewers('1'), table, aclOf(['a', 'write']));
    expect(r.desired).toEqual({ owners: [] });
  });

  it('[FAC-COD] team slugs match case-insensitively', () => {
    const r = run(reviewers('1'), table, aclTeam, [], teamOf('t', 'A'));
    expect(r.desired.owners[0]?.principals).toEqual([{ principal: identity('A') }]);
    expect(r.warnings).toEqual([]);
  });

  it('[FAC-COD] one team that holds the owner outweighs another with unknown membership', () => {
    const acl: AccessControl = {
      grants: [
        { principal: group('T'), role: 'write' },
        { principal: group('U'), role: 'write' },
      ],
    };
    const teams: Teams = {
      teams: [
        { slug: 'T', name: 'T', members: [] },
        { slug: 'U', name: 'U', members: [{ principal: identity('A') }] },
      ],
    };
    const r = run(reviewers('1'), table, acl, [], teams);
    expect(r.warnings).toEqual([]);
    expect(r.desired.owners[0]?.principals).toEqual([{ principal: identity('A') }]);
  });

  it('[FAC-006] any resolution table and teams document translates without throwing, deterministically and independent of order', () => {
    const ids = ['a', 'x', 'q'];
    const principals = [...ids.map(identity), group('a'), group('b'), group('x')];
    const roles = ['read', 'triage', 'write', 'maintain', 'admin'] as const;
    const next = prng(777);
    const pick = <T>(items: readonly T[]): T[] => items.filter(() => next(2) === 0);
    const membersOf = (memberIds: readonly string[]) =>
      memberIds.map((id) => ({ principal: identity(id) }));
    for (let i = 0; i < 300; i++) {
      const tbl = randomTable(next, principals, SAMPLE_STATUSES);
      const acl: AccessControl = {
        grants: pick(principals).map((principal) => ({
          principal,
          role: roles[next(roles.length)] as (typeof roles)[number],
        })),
      };
      // The teams dependency: missing, empty, renamed by naming (with a mapping) or mixed case.
      let teams: Teams | undefined;
      let teamsSource: Teams | undefined;
      const variant = next(4);
      if (variant === 1) {
        teams = { teams: [] };
      } else if (variant >= 2) {
        const sourceMembers = pick(['a', 'x', 'q', 'A', 'X']);
        const desiredMembers = pick(sourceMembers);
        const sourceSlug = variant === 2 ? 'Src_B' : 'b';
        const desiredSlug = variant === 2 ? 'b' : (['b', 'B', 'X', 'x'][next(4)] ?? 'b');
        if (variant === 2) tbl['group:Src_B'] = mapped(group(next(2) === 0 ? 'b' : 'B'));
        for (const id of sourceMembers) {
          if (next(2) === 0) tbl[`identity:${id}`] = mapped(identity(id));
        }
        teams = {
          teams: [{ slug: desiredSlug, name: desiredSlug, members: membersOf(desiredMembers) }],
        };
        teamsSource = {
          teams: [{ slug: sourceSlug, name: sourceSlug, members: membersOf(sourceMembers) }],
        };
      }
      const entries = principals.map((principal) => ({ principal }));
      const source: CodeOwnership = { owners: [{ pattern: '*', principals: entries }] };
      const shuffled: CodeOwnership = {
        owners: [{ pattern: '*', principals: shuffle(next, entries) }],
      };
      const a = run(source, tbl, acl, [], teams, teamsSource);
      const again = run(source, tbl, acl, [], teams, teamsSource);
      expect(again.desired).toEqual(a.desired);
      expect(again.decisions).toEqual(a.decisions);
      expect(again.warnings).toEqual(a.warnings);
      const b = run(shuffled, tbl, acl, [], teams, teamsSource);
      expect(b.desired).toEqual(a.desired);
      expect(b.decisions).toEqual(a.decisions);
    }
  });
});
