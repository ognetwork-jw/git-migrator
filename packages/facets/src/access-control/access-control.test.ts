import type { AccessControl } from '@git-migrator/canonical';
import { compareFacet, FacetRegistry, satisfiedTasks, translateFacet } from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
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
import { ACCESS_CONTROL_FINDING_CODES, accessControl, maxRole, roleRank } from './index.ts';
import { principalIsGranted, principalPath, resolvePrincipal } from './principals.ts';

const registry = new FacetRegistry().register(accessControl);

function run(source: AccessControl, table: ResolutionTable) {
  const r = translateFacet(registry, 'access-control', source, { env: envOf(table) });
  return { ...r, desired: r.desired as AccessControl };
}

describe('access-control facet', () => {
  it('[FAC-001] is declared from the canonical schema and passes registry validation', () => {
    expect(registry.get('access-control').schemaVersion).toBe(1);
    expect(registry.get('access-control').dependsOn).toEqual(['members', 'teams']);
    expect(Object.keys(ACCESS_CONTROL_FINDING_CODES).sort()).toEqual([
      'access-control.pending-invitation',
      'access-control.team-missing',
      'access-control.unmapped-principal',
    ]);
  });

  it('[FAC-ACL-001] merges a principal that appears more than once to the maximum role', () => {
    const r = run(
      {
        grants: [
          { principal: identity('1'), role: 'read' },
          { principal: identity('1'), role: 'admin' },
          { principal: identity('1'), role: 'write' },
        ],
      },
      { 'identity:1': mapped(identity('A')) },
    );
    expect(r.source).toEqual({ grants: [{ principal: identity('1'), role: 'admin' }] });
    expect(r.desired).toEqual({ grants: [{ principal: identity('A'), role: 'admin' }] });
    expect(maxRole('read', 'maintain')).toBe('maintain');
    expect(maxRole('admin', 'triage')).toBe('admin');
    expect(roleRank('read')).toBeLessThan(roleRank('write'));
  });

  it('[FAC-ACL-001] maps the roles read, write and admin to themselves', () => {
    const r = run(
      {
        grants: [
          { principal: identity('1'), role: 'read' },
          { principal: identity('2'), role: 'write' },
          { principal: group('g'), role: 'admin' },
        ],
      },
      {
        'identity:1': mapped(identity('A')),
        'identity:2': mapped(identity('B')),
        'group:g': mapped(group('T')),
      },
    );
    expect(r.desired).toEqual({
      grants: [
        { principal: group('T'), role: 'admin' },
        { principal: identity('A'), role: 'read' },
        { principal: identity('B'), role: 'write' },
      ],
    });
    expect([...r.blockers, ...r.preTasks, ...r.postTasks]).toEqual([]);
  });

  it('[FAC-006] a confirmed identity and a group with a created team become target principals', () => {
    const r = run(
      {
        grants: [
          { principal: identity('1'), role: 'write' },
          { principal: group('devs'), role: 'read' },
        ],
      },
      { 'identity:1': mapped(identity('42')), 'group:devs': mapped(group('team-7')) },
    );
    expect(r.desired.grants).toHaveLength(2);
    expect(r.decisions.map((d) => [d.path, d.fidelity])).toEqual([
      ['/grants[principal=group:devs]', 'translated'],
      ['/grants[principal=identity:1]', 'translated'],
    ]);
  });

  it('[FAC-006] two sources mapped to one target principal keep the higher role', () => {
    const r = run(
      {
        grants: [
          { principal: group('a'), role: 'read' },
          { principal: group('b'), role: 'maintain' },
        ],
      },
      { 'group:a': mapped(group('T')), 'group:b': mapped(group('T')) },
    );
    expect(r.desired.grants).toEqual([{ principal: group('T'), role: 'maintain' }]);
  });

  it('[FAC-006] a mapped and an unmapped grant never share a decision path', () => {
    // group:a maps onto group:b while group:b itself is unmapped: both decisions live at source paths.
    const r = run(
      {
        grants: [
          { principal: group('a'), role: 'read' },
          { principal: group('b'), role: 'write' },
        ],
      },
      { 'group:a': mapped(group('b')) },
    );
    expect(r.desired.grants).toEqual([{ principal: group('b'), role: 'read' }]);
    expect(r.decisions.map((d) => [d.path, d.fidelity])).toEqual([
      ['/grants[principal=group:a]', 'translated'],
      ['/grants[principal=group:b]', 'unsupported'],
    ]);
  });

  it('[FAC-006] any resolution table translates without throwing, deterministically and independent of order', () => {
    const principals = [identity('a'), identity('x'), group('a'), group('b'), group('x')];
    const roles = ['read', 'triage', 'write', 'maintain', 'admin'] as const;
    const next = prng(20261008);
    for (let i = 0; i < 300; i++) {
      const table = randomTable(next, principals, SAMPLE_STATUSES);
      const grants = principals.map((principal) => ({
        principal,
        role: roles[next(roles.length)] as (typeof roles)[number],
      }));
      const shuffled = shuffle(next, grants);
      const first = run({ grants }, table);
      const second = run({ grants: shuffled }, table);
      expect(second.desired).toEqual(first.desired);
      expect(second.decisions).toEqual(first.decisions);
      expect(run({ grants }, table).desired).toEqual(first.desired);
    }
  });

  it('[FAC-006] a mapping to the same principal records no decision', () => {
    const r = run(
      { grants: [{ principal: identity('1'), role: 'read' }] },
      { 'identity:1': mapped(identity('1')) },
    );
    expect(r.decisions).toEqual([]);
  });

  it('[FAC-ACL-003] an excluded identity is omitted without a finding', () => {
    const r = run(
      { grants: [{ principal: identity('1'), role: 'admin' }] },
      { 'identity:1': { status: 'excluded' } },
    );
    expect(r.desired.grants).toEqual([]);
    expect([...r.blockers, ...r.preTasks, ...r.postTasks, ...r.warnings]).toEqual([]);
    expect(r.decisions).toEqual([]);
  });

  it('[FAC-ACL-003] a pending invitation omits the grant and raises a verifiable post task', () => {
    const r = run(
      { grants: [{ principal: identity('1'), role: 'write' }] },
      { 'identity:1': { status: 'pending_invite' } },
    );
    expect(r.desired.grants).toEqual([]);
    expect(r.postTasks).toEqual([
      {
        code: 'access-control.pending-invitation',
        paths: ['/grants[principal=identity:1]'],
        params: { principal: 'identity:1', facet: 'access-control' },
        kind: 'post',
        verifiable: true,
      },
    ]);
    expect(r.decisions[0]?.fidelity).toBe('unsupported');
  });

  it('[FAC-ACL-003] a suggested or unmapped identity omits the grant and raises a pre task', () => {
    const r = run(
      { grants: [{ principal: identity('9'), role: 'read' }] },
      { 'identity:9': { status: 'unmapped' } },
    );
    expect(r.desired.grants).toEqual([]);
    expect(r.preTasks).toEqual([
      {
        code: 'access-control.unmapped-principal',
        paths: ['/grants[principal=identity:9]'],
        params: { principal: 'identity:9', facet: 'access-control' },
        kind: 'pre',
        verifiable: false,
      },
    ]);
  });

  it('[FAC-ACL-004] a group without a created team blocks with access-control.team-missing', () => {
    const r = run(
      { grants: [{ principal: group('devs'), role: 'write' }] },
      { 'group:devs': { status: 'team_missing' } },
    );
    expect(r.desired.grants).toEqual([]);
    expect(r.blockers).toEqual([
      {
        code: 'access-control.team-missing',
        paths: ['/grants[principal=group:devs]'],
        params: { team: 'devs' },
        kind: 'blocker',
        verifiable: false,
      },
    ]);
  });

  it('[FAC-006] an unmapped group is an unmapped-principal task, not a team blocker', () => {
    const r = run({ grants: [{ principal: group('x'), role: 'read' }] }, {});
    expect(r.blockers).toEqual([]);
    expect(r.preTasks.map((t) => t.code)).toEqual(['access-control.unmapped-principal']);
  });

  it('[FAC-006] team_missing for an identity cannot apply and is treated as unmapped', () => {
    const r = run(
      { grants: [{ principal: identity('1'), role: 'read' }] },
      { 'identity:1': { status: 'team_missing' } },
    );
    expect(r.blockers).toEqual([]);
    expect(r.preTasks.map((t) => t.code)).toEqual(['access-control.unmapped-principal']);
  });

  it('[FAC-006] resolves groups through the group resolver and identities through the identity resolver', () => {
    const calls: string[] = [];
    const ctx = {
      identities: {
        resolve: () => {
          calls.push('identity');
          return { status: 'excluded' as const };
        },
      },
      groups: {
        resolve: () => {
          calls.push('group');
          return { status: 'excluded' as const };
        },
      },
    };
    resolvePrincipal(identity('1'), ctx as never);
    resolvePrincipal(group('1'), ctx as never);
    expect(calls).toEqual(['identity', 'group']);
    expect(principalPath('grants', group('a/b'))).toBe('/grants[principal=group:a/b]');
  });

  it('[ADP-021] normalizes grants by key regardless of source order', () => {
    const table = { 'identity:1': mapped(identity('1')), 'identity:2': mapped(identity('2')) };
    const a = run(
      {
        grants: [
          { principal: identity('2'), role: 'read' },
          { principal: identity('1'), role: 'read' },
        ],
      },
      table,
    );
    const b = run(
      {
        grants: [
          { principal: identity('1'), role: 'read' },
          { principal: identity('2'), role: 'read' },
        ],
      },
      table,
    );
    expect(a.desired).toEqual(b.desired);
  });

  it('[FAC-ACL-002] compares grants by principal and role, ignoring order', () => {
    const desired: AccessControl = {
      grants: [
        { principal: identity('1'), role: 'read' },
        { principal: group('t'), role: 'write' },
      ],
    };
    const same = compareFacet(registry, 'access-control', desired, {
      grants: [
        { principal: group('t'), role: 'write' },
        { principal: identity('1'), role: 'read' },
      ],
    });
    expect(same?.status).toBe('equal');

    const diff = compareFacet(registry, 'access-control', desired, {
      grants: [
        { principal: identity('1'), role: 'admin' },
        { principal: identity('3'), role: 'read' },
      ],
    });
    expect(diff?.status).toBe('different');
    const byPath = new Map(diff?.diffs.map((d) => [d.path, d]));
    expect(byPath.get('/grants[principal=identity:1]/role')).toMatchObject({
      desired: 'read',
      actual: 'admin',
    });
    expect([...byPath.keys()].some((p) => p.startsWith('/grants[principal=group:t]'))).toBe(true);
    expect([...byPath.keys()].some((p) => p.startsWith('/grants[principal=identity:3]'))).toBe(
      true,
    );
  });

  it('[LIF-061] a pending-invitation task is satisfied only when the target holds its principal', () => {
    const task = {
      code: 'access-control.pending-invitation',
      params: { targetPrincipal: 'identity:42' },
    };
    const has: AccessControl = { grants: [{ principal: identity('42'), role: 'read' }] };
    const lacks: AccessControl = { grants: [{ principal: identity('7'), role: 'read' }] };
    expect(satisfiedTasks(registry, 'access-control', [task], has, [])).toEqual([task]);
    expect(satisfiedTasks(registry, 'access-control', [task], lacks, [])).toEqual([]);
    // Without a target principal in the params the task cannot be judged and stays open.
    const bare = { code: 'access-control.pending-invitation', params: {} };
    expect(satisfiedTasks(registry, 'access-control', [bare], has, [])).toEqual([]);
    expect(principalIsGranted([], null)).toBe(false);
    const other = { code: 'access-control.unmapped-principal', params: {} };
    expect(accessControl.isTaskSatisfied?.(other, has, [])).toBe(false);
  });
});
