import type { Members } from '@git-migrator/canonical';
import { compareFacet, FacetRegistry, satisfiedTasks, translateFacet } from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import {
  envOf,
  excluded,
  identity,
  mapped,
  pendingInvite,
  teamMissing,
} from '../endpoint-test-support.ts';
import { membersDefinition, normalizeMembers } from './index.ts';

const registry = new FacetRegistry().register(membersDefinition);
const translate = (source: Members, table = {}, routeIndex: Record<string, unknown> = {}) =>
  translateFacet(registry, 'members', source, { env: envOf(table, { routeIndex }) });

const member = (id: string, role: 'member' | 'admin' = 'member') => ({
  principal: identity(id),
  role,
});
const inOrg = (...ids: string[]) => ({ targetOrgMembers: ids });
const path = (id: string) => `/members[principal=identity:${id}]`;

describe('members facet', () => {
  it('[FAC-001] declares the endpoint scope, the principal collection and no policy keys', () => {
    expect(membersDefinition.scope).toBe('endpoint');
    expect(membersDefinition.dependsOn).toEqual([]);
    expect(membersDefinition.collections).toEqual([{ path: '/members', key: 'principal' }]);
    expect(membersDefinition.policyKeys).toEqual([]);
  });

  it('[FAC-006] a confirmed member is translated to the target identity and keeps its role', () => {
    const t = translate(
      { members: [member('a', 'admin'), member('b')] },
      { 'identity:a': mapped(identity('gh-a')), 'identity:b': mapped(identity('b')) },
      inOrg('gh-a', 'b'),
    );
    expect(t.desired).toEqual({
      members: [
        { principal: identity('b'), role: 'member' },
        { principal: identity('gh-a'), role: 'admin' },
      ],
    });
    // Only the member whose principal changed is a translated field.
    expect(t.decisions).toEqual([{ path: path('a'), fidelity: 'translated', accepted: false }]);
    expect(t.preTasks).toEqual([]);
    expect(t.postTasks).toEqual([]);
  });

  it('[FAC-006] two source members mapped to one target member keep the higher role', () => {
    const t = translate(
      { members: [member('a'), member('b', 'admin')] },
      { 'identity:a': mapped(identity('gh')), 'identity:b': mapped(identity('gh')) },
      inOrg('gh'),
    );
    expect(t.desired).toEqual({ members: [{ principal: identity('gh'), role: 'admin' }] });
  });

  it('[FAC-006] an excluded member is omitted without a finding', () => {
    const t = translate({ members: [member('a')] }, { 'identity:a': excluded });
    expect(t.desired).toEqual({ members: [] });
    expect(t.decisions).toEqual([]);
    expect([...t.preTasks, ...t.postTasks, ...t.blockers, ...t.warnings]).toEqual([]);
  });

  it('[FAC-006] [FAC-END] a pending invitation is omitted and raises members.pending-acceptance', () => {
    const t = translate(
      { members: [member('a'), member('b')] },
      { 'identity:a': pendingInvite, 'identity:b': pendingInvite },
    );
    expect(t.desired).toEqual({ members: [] });
    expect(t.postTasks).toEqual([
      expect.objectContaining({
        code: 'members.pending-acceptance',
        paths: [path('a'), path('b')],
        params: { count: 2 },
        verifiable: true,
      }),
    ]);
    expect(t.preTasks).toEqual([]);
  });

  it('[FAC-END] suggested and unmapped members raise one members.review-identity-mapping task', () => {
    // The resolver folds `suggested` into `unmapped`; a missing table entry is unmapped too.
    const t = translate(
      { members: [member('a'), member('b'), member('c')] },
      {
        'identity:c': mapped(identity('c')),
      },
      inOrg('c'),
    );
    expect(t.desired).toEqual({ members: [{ principal: identity('c'), role: 'member' }] });
    expect(t.preTasks).toEqual([
      expect.objectContaining({
        code: 'members.review-identity-mapping',
        paths: [path('a'), path('b')],
        params: { count: 2 },
        verifiable: false,
      }),
    ]);
    expect(t.decisions.map((d) => d.fidelity)).toEqual(['unsupported', 'unsupported']);
  });

  it('[FAC-END] a team_missing answer for an identity is treated as unmapped, never dropped', () => {
    const t = translate({ members: [member('a')] }, { 'identity:a': teamMissing });
    expect(t.preTasks.map((p) => p.code)).toEqual(['members.review-identity-mapping']);
  });

  it('[FAC-END] unmapped candidates raise members.approve-invitations, and only those', () => {
    const t = translate(
      { members: [member('a'), member('b'), member('c')] },
      {},
      {
        invitationCandidates: ['a', 'c', 'not-a-member'],
      },
    );
    expect(t.postTasks).toEqual([
      expect.objectContaining({
        code: 'members.approve-invitations',
        paths: [path('a'), path('c')],
        params: { count: 2 },
      }),
    ]);
    expect(t.preTasks.map((p) => p.code)).toEqual(['members.review-identity-mapping']);
  });

  it('[FAC-END] a candidate that is already mapped or pending raises no approve-invitations', () => {
    const t = translate(
      { members: [member('a'), member('b')] },
      { 'identity:a': mapped(identity('a')), 'identity:b': pendingInvite },
      { invitationCandidates: ['a', 'b'], ...inOrg('a') },
    );
    expect(t.postTasks.map((p) => p.code)).toEqual(['members.pending-acceptance']);
  });

  it('[FAC-END] no candidate index means no approve-invitations task', () => {
    const t = translate({ members: [member('a')] });
    expect(t.postTasks).toEqual([]);
  });

  it('[FAC-END] a malformed candidate list is an error, not a silent fallback', () => {
    expect(() => translate({ members: [member('a')] }, {}, { invitationCandidates: 'a' })).toThrow(
      /translate/,
    );
  });

  it('[AUTH-061] a principal that is mapped but not yet in the organization is never written as a member', () => {
    const t = translate(
      { members: [member('a'), member('b')] },
      { 'identity:a': mapped(identity('gh-a')), 'identity:b': mapped(identity('gh-b')) },
      inOrg('gh-b'),
    );
    expect(t.desired).toEqual({ members: [{ principal: identity('gh-b'), role: 'member' }] });
    // It takes the invitation route: an approved batch, not a membership write.
    expect(t.postTasks).toEqual([
      expect.objectContaining({
        code: 'members.approve-invitations',
        paths: [path('a')],
        params: { count: 1 },
      }),
    ]);
    expect(t.decisions).toContainEqual({
      path: path('a'),
      fidelity: 'unsupported',
      accepted: false,
    });
  });

  it('[AUTH-061] without a known list of org members nobody is written as a member', () => {
    const t = translate({ members: [member('a')] }, { 'identity:a': mapped(identity('a')) });
    expect(t.desired).toEqual({ members: [] });
    expect(t.postTasks.map((p) => p.code)).toEqual(['members.approve-invitations']);
  });

  it('[AUTH-061] a malformed targetOrgMembers is an error', () => {
    expect(() => translate({ members: [member('a')] }, {}, { targetOrgMembers: 'a' })).toThrow(
      /translate/,
    );
    expect(() => translate({ members: [member('a')] }, {}, { targetOrgMembers: [1] })).toThrow(
      /translate/,
    );
  });

  it('[AUTH-061] translation never invents a member: desired holds only mapped sources', () => {
    const sources = [member('a'), member('b'), member('c'), member('d')];
    const t = translate(
      { members: sources },
      {
        'identity:a': mapped(identity('x')),
        'identity:b': excluded,
        'identity:c': pendingInvite,
      },
      inOrg('x'),
    );
    expect(t.desired).toEqual({ members: [{ principal: identity('x'), role: 'member' }] });
  });

  it('[ADP-021] normalize merges duplicate principals to the highest role and sorts', () => {
    expect(normalizeMembers({ members: [member('b'), member('a'), member('b', 'admin')] })).toEqual(
      { members: [member('a'), member('b', 'admin')] },
    );
  });

  describe('compare', () => {
    const cmp = (desired: Members, actual: Members | null) =>
      compareFacet(registry, 'members', desired, actual);

    it('[LIF-060] equal documents are equal regardless of order', () => {
      expect(
        cmp({ members: [member('a'), member('b')] }, { members: [member('b'), member('a')] })
          ?.status,
      ).toBe('equal');
    });

    it('[LIF-060] a missing member and a different role are reported by path', () => {
      const result = cmp(
        { members: [member('a', 'admin'), member('b')] },
        { members: [member('a')] },
      );
      expect(result?.status).toBe('different');
      expect(result?.diffs.map((d) => d.path)).toEqual([
        '/members[principal=identity:a]/role',
        '/members[principal=identity:b]/principal/id',
        '/members[principal=identity:b]/principal/kind',
        '/members[principal=identity:b]/role',
      ]);
    });

    it('[AUTH-061] members that exist only on the target are not a difference', () => {
      expect(
        cmp({ members: [member('a')] }, { members: [member('a'), member('staff')] })?.status,
      ).toBe('equal');
    });

    it('[AUTH-050] an identity_excluded Expected Difference masks the missing-member diff of an excluded identity', () => {
      const result = compareFacet(
        registry,
        'members',
        { members: [member('a')] },
        { members: [] },
        {
          expectedDifferences: [
            {
              facetKey: 'members',
              path: '/members[principal=identity:a]/**',
              reason: 'identity_excluded',
            },
          ],
        },
      );
      expect(result?.status).toBe('equal');
    });

    it('[LIF-060] an unreadable target is unverifiable', () => {
      expect(cmp({ members: [] }, null)?.status).toBe('unverifiable');
    });
  });

  describe('isTaskSatisfied', () => {
    const pendingTask = (params: unknown) => ({
      code: 'members.pending-acceptance',
      params,
    });
    const satisfied = (params: unknown, target: Members) =>
      satisfiedTasks(registry, 'members', [pendingTask(params)], target, []).length === 1;

    it('[FAC-END] pending-acceptance is done once the invitee is a member of the target', () => {
      const target = { members: [member('gh-a')] };
      expect(satisfied({ count: 1, targetPrincipals: ['identity:gh-a'] }, target)).toBe(true);
      expect(
        satisfied({ count: 1, targetPrincipals: ['identity:gh-a', 'identity:gh-b'] }, target),
      ).toBe(false);
    });

    it('[FAC-END] pending-acceptance without a known target principal stays open', () => {
      expect(satisfied({ count: 1 }, { members: [member('gh-a')] })).toBe(false);
      expect(satisfied({ count: 1, targetPrincipals: [] }, { members: [] })).toBe(false);
      expect(satisfied({ targetPrincipals: 'identity:x' }, { members: [member('x')] })).toBe(false);
    });
  });

  it('[FAC-END] declares the three finding codes of the spec with their kinds', () => {
    expect(membersDefinition.findingCodes).toEqual({
      'members.review-identity-mapping': { kind: 'pre', completion: 'resolution' },
      'members.approve-invitations': { kind: 'post', completion: 'resolution' },
      'members.pending-acceptance': { kind: 'post', completion: 'parity' },
    });
  });
});
