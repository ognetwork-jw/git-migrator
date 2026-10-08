import type { Teams } from '@git-migrator/canonical';
import {
  compareFacet,
  type FacetCapability,
  FacetRegistry,
  satisfiedTasks,
  translateFacet,
} from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import {
  envOf,
  excluded,
  group,
  identity,
  mapped,
  pendingInvite,
  type ResolutionTable,
  unreadable,
} from '../endpoint-test-support.ts';
import { normalizeTeams, plannedSlug, teamsDefinition } from './index.ts';

const registry = new FacetRegistry().register(teamsDefinition);

const entry = (id: string) => ({ principal: identity(id) });
const team = (slug: string, name: string, ...members: string[]) => ({
  slug,
  name,
  members: members.map(entry),
});

interface Options {
  table?: ResolutionTable;
  members?: string[] | null;
  route?: Record<string, unknown>;
  routeIndex?: Record<string, unknown>;
  caps?: FacetCapability;
}
function translate(source: Teams, opts: Options = {}) {
  return translateFacet(registry, 'teams', source, {
    env: envOf(opts.table, {
      route: opts.route,
      routeIndex: {
        ...opts.routeIndex,
        ...(opts.members === null ? {} : { targetOrgMembers: opts.members ?? [] }),
      },
    }),
    sourceCaps: opts.caps,
  });
}
const teamsOf = (t: { desired: unknown }) => (t.desired as Teams).teams;
const tpath = (slug: string, rest = '') => `/teams[slug=${slug}]${rest}`;
const mpath = (slug: string, id: string) => `${tpath(slug)}/members[principal=identity:${id}]`;

describe('teams facet', () => {
  it('[FAC-001] declares the endpoint scope, its dependency and the collections', () => {
    expect(teamsDefinition.scope).toBe('endpoint');
    expect(teamsDefinition.dependsOn).toEqual(['members']);
    expect(teamsDefinition.collections).toEqual([
      { path: '/teams', key: 'slug' },
      { path: '/teams/members', key: 'principal' },
    ]);
    expect(teamsDefinition.policyKeys).toEqual([]);
  });

  describe('team slug (LIF-030)', () => {
    it('[LIF-030] defaults to the kebab-case of the group slug', () => {
      const t = translate({ teams: [team('Dev_Team', 'Dev Team'), team('ops', 'Ops')] });
      expect(teamsOf(t).map((x) => [x.slug, x.name])).toEqual([
        ['dev-team', 'Dev Team'],
        ['ops', 'Ops'],
      ]);
      // Only the renamed slug is a translated field.
      expect(t.decisions).toEqual([
        { path: tpath('Dev_Team', '/slug'), fidelity: 'translated', accepted: false },
      ]);
    });

    it('[LIF-030] uses the Route teamNaming pipeline when one is configured', () => {
      const route = {
        defaults: {
          teamNaming: {
            steps: [
              { var: 'group', op: 'slug' },
              { var: 'group', op: 'kebab' },
            ],
            template: 'bb-{group}',
          },
        },
      };
      const t = translate({ teams: [team('devs', 'Devs')] }, { route });
      expect(teamsOf(t)[0]?.slug).toBe('bb-devs');
    });

    it('[LIF-030] a created team (mapped group) keeps its resolved target id as slug', () => {
      const t = translate(
        { teams: [team('Devs', 'Devs')] },
        { table: { 'group:Devs': mapped(group('engineering')) } },
      );
      expect(teamsOf(t)[0]?.slug).toBe('engineering');
    });

    it('[LIF-030] a planned slug from the group mappings wins over the pipeline', () => {
      const t = translate(
        { teams: [team('devs', 'Devs')] },
        { routeIndex: { plannedSlugs: { devs: 'platform' } } },
      );
      expect(teamsOf(t)[0]?.slug).toBe('platform');
    });

    it('[LIF-030] a team without a created target resolves to team_missing and still gets its planned slug', () => {
      const t = translate(
        { teams: [team('devs', 'Devs')] },
        { table: { 'group:devs': { status: 'team_missing' } } },
      );
      expect(teamsOf(t)[0]?.slug).toBe('devs');
      expect(t.blockers).toEqual([]);
    });

    it('[LIF-030] a planned slug that breaks the target slug rules raises teams.slug-invalid', () => {
      for (const bad of ['Platform', 'a b', '-x', 'x--y', '']) {
        const t = translate(
          { teams: [team('devs', 'Devs')] },
          { routeIndex: { plannedSlugs: { devs: bad } } },
        );
        expect(teamsOf(t), bad).toEqual([]);
        expect(
          t.blockers.map((b) => b.code),
          bad,
        ).toEqual(['teams.slug-invalid']);
      }
    });

    it('[LIF-030] a malformed teamNaming or plannedSlugs is an error, not a silent fallback', () => {
      expect(() =>
        translate({ teams: [team('a', 'A')] }, { route: { defaults: { teamNaming: 'x' } } }),
      ).toThrow(/translate/);
      expect(() =>
        translate({ teams: [team('a', 'A')] }, { routeIndex: { plannedSlugs: { a: 1 } } }),
      ).toThrow(/translate/);
    });

    it('[FAC-END] the slug is exported as the contract other facets read: plannedSlug() equals the desired slug', () => {
      const source = team('Dev_Team', 'Dev Team');
      const t = translate({ teams: [source] });
      const ctx = {
        groups: { resolve: () => ({ status: 'unmapped' as const }) },
        routeIndex: {},
        route: {},
      };
      expect(plannedSlug(source, ctx as never)).toBe(teamsOf(t)[0]?.slug);
    });
  });

  describe('teams.slug-invalid', () => {
    it('[FAC-END] a pipeline that yields no slug blocks the team and leaves it out', () => {
      const t = translate({ teams: [team('---', 'Dashes'), team('ok', 'Ok')] });
      expect(teamsOf(t).map((x) => x.slug)).toEqual(['ok']);
      expect(t.blockers).toEqual([
        expect.objectContaining({
          code: 'teams.slug-invalid',
          paths: [tpath('---')],
          params: { team: '---' },
        }),
      ]);
      expect(t.decisions).toEqual([
        { path: tpath('---'), fidelity: 'unsupported', accepted: false },
      ]);
    });
  });

  describe('teams.slug-collision', () => {
    it('[FAC-END] groups whose slugs collide block, and none of them is created', () => {
      const t = translate({
        teams: [team('Dev_Team', 'A'), team('dev-team', 'B'), team('ops', 'Ops')],
      });
      expect(teamsOf(t).map((x) => x.slug)).toEqual(['ops']);
      expect(t.blockers).toEqual([
        expect.objectContaining({
          code: 'teams.slug-collision',
          paths: [tpath('Dev_Team'), tpath('dev-team')],
          params: { team: 'dev-team', groups: ['Dev_Team', 'dev-team'] },
        }),
      ]);
    });

    it('[FAC-END] collisions are judged case-insensitively', () => {
      const t = translate(
        { teams: [team('a', 'A'), team('b', 'B')] },
        { table: { 'group:a': mapped(group('Platform')), 'group:b': mapped(group('platform')) } },
      );
      expect(t.blockers.map((b) => b.code)).toEqual(['teams.slug-collision']);
      expect(teamsOf(t)).toEqual([]);
    });

    it('[FAC-END] distinct slugs do not collide', () => {
      const t = translate({ teams: [team('a', 'A'), team('b', 'B')] });
      expect(t.blockers).toEqual([]);
      expect(teamsOf(t)).toHaveLength(2);
    });
  });

  describe('membership (FAC-006)', () => {
    it('[FAC-006] a confirmed member of the org is translated into the team', () => {
      const t = translate(
        { teams: [team('devs', 'Devs', 'a', 'b')] },
        {
          table: { 'identity:a': mapped(identity('gh-a')), 'identity:b': mapped(identity('b')) },
          members: ['gh-a', 'b'],
        },
      );
      expect(teamsOf(t)[0]?.members).toEqual([entry('b'), entry('gh-a')]);
      expect(t.decisions).toEqual([
        { path: mpath('devs', 'a'), fidelity: 'translated', accepted: false },
      ]);
    });

    it('[AUTH-061] a principal that is mapped and in the members document but not in the org is not added', () => {
      const t = translateFacet(
        registry,
        'teams',
        { teams: [team('devs', 'Devs', 'a')] },
        {
          env: envOf(
            { 'identity:a': mapped(identity('a')) },
            { routeIndex: { targetOrgMembers: ['someone-else'] } },
          ),
          deps: {
            members: {
              source: { members: [] },
              desired: { members: [{ principal: identity('a'), role: 'member' }] },
            },
          },
        },
      );
      expect(teamsOf(t)[0]?.members).toEqual([]);
    });

    it('[AUTH-061] a malformed targetOrgMembers is an error', () => {
      expect(() =>
        translate(
          { teams: [team('devs', 'Devs', 'a')] },
          { members: null, routeIndex: { targetOrgMembers: 'a' } },
        ),
      ).toThrow(/translate/);
    });

    it('[AUTH-061] a mapped principal that is not an org member is skipped, never invited', () => {
      const t = translate(
        { teams: [team('devs', 'Devs', 'a')] },
        { table: { 'identity:a': mapped(identity('outsider')) }, members: ['someone-else'] },
      );
      expect(teamsOf(t)[0]?.members).toEqual([]);
      expect([...t.preTasks, ...t.postTasks, ...t.blockers]).toEqual([]);
    });

    it('[AUTH-061] without a known list of org members nobody is added', () => {
      const t = translate(
        { teams: [team('devs', 'Devs', 'a')] },
        { table: { 'identity:a': mapped(identity('a')) }, members: null },
      );
      expect(teamsOf(t)[0]?.members).toEqual([]);
    });

    it('[FAC-006] an excluded member is omitted without a finding', () => {
      const t = translate(
        { teams: [team('devs', 'Devs', 'a')] },
        { table: { 'identity:a': excluded }, members: ['a'] },
      );
      expect(teamsOf(t)[0]?.members).toEqual([]);
      expect(t.decisions).toEqual([]);
      expect([...t.preTasks, ...t.postTasks, ...t.blockers]).toEqual([]);
    });

    it('[FAC-006] a pending invitation is omitted and raises teams.pending-invitation once per principal', () => {
      const t = translate(
        { teams: [team('a-team', 'A', 'p'), team('b-team', 'B', 'p')] },
        { table: { 'identity:p': pendingInvite }, members: [] },
      );
      expect(teamsOf(t).map((x) => x.members)).toEqual([[], []]);
      expect(t.postTasks).toEqual([
        expect.objectContaining({
          code: 'teams.pending-invitation',
          paths: [mpath('a-team', 'p'), mpath('b-team', 'p')],
          params: { principal: 'identity:p', facet: 'teams' },
          verifiable: true,
        }),
      ]);
    });

    it('[FAC-006] an unmapped or suggested member is omitted and raises teams.unmapped-principal', () => {
      const t = translate(
        { teams: [team('devs', 'Devs', 'u', 'v')] },
        { table: { 'identity:v': mapped(identity('v')) }, members: ['v'] },
      );
      expect(teamsOf(t)[0]?.members).toEqual([entry('v')]);
      expect(t.preTasks).toEqual([
        expect.objectContaining({
          code: 'teams.unmapped-principal',
          paths: [mpath('devs', 'u')],
          params: { principal: 'identity:u', facet: 'teams' },
          verifiable: false,
        }),
      ]);
    });

    it('[FAC-006] a team_missing answer for a member is treated as unmapped', () => {
      const t = translate(
        { teams: [team('devs', 'Devs', 'u')] },
        { table: { 'identity:u': { status: 'team_missing' } }, members: [] },
      );
      expect(t.preTasks.map((p) => p.code)).toEqual(['teams.unmapped-principal']);
    });

    it('[FAC-END] skipped members never raise teams.set-membership', () => {
      const t = translate(
        { teams: [team('devs', 'Devs', 'e', 'p', 'u', 'n')] },
        {
          table: {
            'identity:e': excluded,
            'identity:p': pendingInvite,
            'identity:n': mapped(identity('not-in-org')),
          },
          members: [],
        },
      );
      expect(t.postTasks.map((p) => p.code)).toEqual(['teams.pending-invitation']);
    });

    it('[FAC-END] two source members mapped to one target member appear once', () => {
      const t = translate(
        { teams: [team('devs', 'Devs', 'a', 'b')] },
        {
          table: { 'identity:a': mapped(identity('gh')), 'identity:b': mapped(identity('gh')) },
          members: ['gh'],
        },
      );
      expect(teamsOf(t)[0]?.members).toEqual([entry('gh')]);
    });
  });

  describe('teams.set-membership', () => {
    const caps = unreadable('/teams/members');

    it('[FAC-END] raised for every team when the source membership is unreadable', () => {
      const t = translate(
        { teams: [team('a', 'A'), team('Dev_Team', 'Dev')] },
        { caps, table: {} },
      );
      expect(teamsOf(t).map((x) => x.members)).toEqual([[], []]);
      expect(t.postTasks).toEqual([
        expect.objectContaining({
          code: 'teams.set-membership',
          paths: [tpath('Dev_Team', '/members')],
          params: { team: 'dev-team' },
          verifiable: true,
        }),
        expect.objectContaining({
          code: 'teams.set-membership',
          paths: [tpath('a', '/members')],
          params: { team: 'a' },
        }),
      ]);
    });

    it('[FAC-END] not raised when the membership is readable, even for an empty team', () => {
      const t = translate({ teams: [team('empty', 'Empty')] });
      expect(t.postTasks).toEqual([]);
    });

    it('[FAC-END] done once the target team exists and has a member', () => {
      const task = { code: 'teams.set-membership', params: { team: 'dev-team' } };
      const done = (target: Teams) =>
        satisfiedTasks(registry, 'teams', [task], target, []).length === 1;
      expect(done({ teams: [team('Dev-Team', 'Dev', 'x')] })).toBe(true);
      expect(done({ teams: [team('dev-team', 'Dev')] })).toBe(false);
      expect(done({ teams: [team('other', 'Dev', 'x')] })).toBe(false);
      expect(
        satisfiedTasks(
          registry,
          'teams',
          [{ code: 'teams.set-membership', params: {} }],
          { teams: [team('dev-team', 'Dev', 'x')] },
          [],
        ),
      ).toEqual([]);
    });
  });

  it('[FAC-006] teams.pending-invitation is done once targetPrincipal is a member of a target team', () => {
    const task = (params: unknown) => ({ code: 'teams.pending-invitation', params });
    const target = { teams: [team('devs', 'Devs', 'gh-p')] };
    expect(
      satisfiedTasks(registry, 'teams', [task({ targetPrincipal: 'identity:gh-p' })], target, []),
    ).toHaveLength(1);
    expect(
      satisfiedTasks(registry, 'teams', [task({ principal: 'identity:p' })], target, []),
    ).toEqual([]);
  });

  it('[ADP-021] normalize sorts and de-duplicates members', () => {
    expect(
      normalizeTeams({
        teams: [{ slug: 's', name: 'S', members: [entry('b'), entry('a'), entry('b')] }],
      }),
    ).toEqual({ teams: [{ slug: 's', name: 'S', members: [entry('a'), entry('b')] }] });
  });

  describe('compare', () => {
    const cmp = (desired: Teams, actual: Teams | null) =>
      compareFacet(registry, 'teams', desired, actual);

    it('[LIF-060] equal documents are equal regardless of order', () => {
      expect(
        cmp(
          { teams: [team('a', 'A', 'x', 'y'), team('b', 'B')] },
          { teams: [team('b', 'B'), team('a', 'A', 'y', 'x')] },
        )?.status,
      ).toBe('equal');
    });

    it('[LIF-060] a missing team, a missing member and a different name are reported', () => {
      const result = cmp(
        { teams: [team('a', 'A', 'x', 'y'), team('b', 'B')] },
        { teams: [team('a', 'Renamed', 'x')] },
      );
      expect(result?.status).toBe('different');
      const paths = result?.diffs.map((d) => d.path) ?? [];
      expect(paths).toContain('/teams[slug=a]/name');
      expect(paths).toContain('/teams[slug=a]/members[principal=identity:y]/principal/id');
      expect(paths).toContain('/teams[slug=b]/name');
    });

    it('[AUTH-061] teams and members that exist only on the target are not a difference', () => {
      expect(
        cmp(
          { teams: [team('a', 'A', 'x')] },
          { teams: [team('a', 'A', 'x', 'extra'), team('legacy', 'Legacy', 'z')] },
        )?.status,
      ).toBe('equal');
    });

    it('[AUTH-050] an identity_excluded Expected Difference hides an excluded member', () => {
      const result = compareFacet(
        registry,
        'teams',
        { teams: [team('a', 'A', 'x')] },
        { teams: [team('a', 'A')] },
        {
          expectedDifferences: [
            {
              facetKey: 'teams',
              path: '/teams[slug=*]/members[principal=identity:x]/**',
              reason: 'identity_excluded',
            },
          ],
        },
      );
      expect(result?.status).toBe('equal');
    });

    it('[LIF-060] an unreadable target is unverifiable', () => {
      expect(cmp({ teams: [] }, null)?.status).toBe('unverifiable');
    });
  });

  it('[FAC-END] declares the finding codes with their kinds', () => {
    expect(teamsDefinition.findingCodes).toEqual({
      'teams.slug-collision': { kind: 'blocker' },
      'teams.slug-invalid': { kind: 'blocker' },
      'teams.set-membership': { kind: 'post', completion: 'parity' },
      'teams.unmapped-principal': { kind: 'pre', completion: 'resolution' },
      'teams.pending-invitation': { kind: 'post', completion: 'parity' },
    });
  });
});
