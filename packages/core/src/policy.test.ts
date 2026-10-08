import { describe, expect, it } from 'vitest';
import { matchesPattern } from './pattern.ts';
import {
  applyLossyPolicies,
  DEFAULT_ROUTE_POLICIES,
  fidelityEffect,
  isPolicyKey,
  PolicyError,
  policyKeyFacet,
  type RoutePolicies,
  resolveRoutePolicies,
} from './policy.ts';
import { FIDELITIES, type FieldDecision } from './types.ts';

const policies = (acceptLossy: string[]): RoutePolicies => ({
  ...DEFAULT_ROUTE_POLICIES,
  acceptLossy,
  identityMatch: { autoConfirmEmail: true },
});
const lossy = (
  path: string,
  policyKey: string,
  extra: Partial<FieldDecision> = {},
): FieldDecision => ({
  path,
  fidelity: 'lossy',
  policyKey,
  accepted: false,
  ...extra,
});

describe('[ADP-040] fidelity semantics', () => {
  it('[ADP-040] exact and translated have no effect', () => {
    expect(fidelityEffect('exact')).toBe('none');
    expect(fidelityEffect('translated')).toBe('none');
  });
  it('[ADP-040] lossy needs acceptance; unsupported and unreadable are facet-defined findings', () => {
    expect(fidelityEffect('lossy')).toBe('accept-lossy');
    expect(fidelityEffect('unsupported')).toBe('facet-defined');
    expect(fidelityEffect('unreadable')).toBe('facet-defined');
  });
  it('[ADP-040] defines the five fidelities', () => {
    expect([...FIDELITIES]).toEqual(['exact', 'translated', 'lossy', 'unsupported', 'unreadable']);
    for (const f of FIDELITIES) expect(fidelityEffect(f)).toBeDefined();
  });
});

describe('[FAC-005] Route policies', () => {
  it('[FAC-005] defaults follow the spec', () => {
    expect(resolveRoutePolicies()).toEqual({
      acceptLossy: ['branch-rules.advisory-enforced', 'environments.category-dropped'],
      webhookAllowlistEnabled: true,
      identityMatch: { autoConfirmEmail: true },
    });
    expect(resolveRoutePolicies({})).toEqual(resolveRoutePolicies());
    expect(Object.isFrozen(DEFAULT_ROUTE_POLICIES)).toBe(true);
  });

  it('[FAC-005] an explicit empty acceptLossy is respected; lists are deduplicated and sorted', () => {
    expect(resolveRoutePolicies({ acceptLossy: [] }).acceptLossy).toEqual([]);
    expect(resolveRoutePolicies({ acceptLossy: ['b.x', 'a.y', 'b.x'] }).acceptLossy).toEqual([
      'a.y',
      'b.x',
    ]);
  });

  it('[FAC-005] reads booleans and does not alias the defaults', () => {
    const r = resolveRoutePolicies({
      webhookAllowlistEnabled: false,
      identityMatch: { autoConfirmEmail: false },
    });
    expect(r).toMatchObject({
      webhookAllowlistEnabled: false,
      identityMatch: { autoConfirmEmail: false },
    });
    expect(resolveRoutePolicies({ identityMatch: {} }).identityMatch.autoConfirmEmail).toBe(true);
    resolveRoutePolicies().acceptLossy.push('x.y');
    expect(DEFAULT_ROUTE_POLICIES.acceptLossy).toHaveLength(2);
  });

  it('[FAC-005] rejects unknown fields, wrong types and malformed policy keys', () => {
    const bad: unknown[] = [
      null,
      [],
      'x',
      { acceptlossy: [] },
      { acceptLossy: 'a.b' },
      { acceptLossy: ['nodot'] },
      { acceptLossy: ['A.b'] },
      { acceptLossy: ['a.b.c'] },
      { acceptLossy: [1] },
      { webhookAllowlistEnabled: 'true' },
      { identityMatch: 'x' },
      { identityMatch: [] },
      { identityMatch: { autoConfirmEmail: 1 } },
      { identityMatch: { other: true } },
    ];
    for (const b of bad)
      expect(() => resolveRoutePolicies(b), JSON.stringify(b)).toThrow(PolicyError);
  });

  it('[FAC-005] policy keys are <facet>.<name> in kebab case', () => {
    for (const k of [
      'branch-rules.advisory-enforced',
      'a.b',
      'environments.category-dropped',
      'x1.y2-z3',
    ]) {
      expect(isPolicyKey(k)).toBe(true);
    }
    for (const k of [
      '',
      'a',
      'a.',
      '.b',
      'a..b',
      'a.b.c',
      'A.b',
      'a.B',
      'a-.b',
      '1a.b',
      'a.b-',
      5,
      null,
    ]) {
      expect(isPolicyKey(k)).toBe(false);
    }
    expect(policyKeyFacet('branch-rules.advisory-enforced')).toBe('branch-rules');
    expect(policyKeyFacet('nope')).toBeUndefined();
  });

  it('[FAC-005] a lossy decision whose key is accepted produces no task and one lossy_accepted difference', () => {
    const r = applyLossyPolicies(
      'branch-rules',
      [lossy('/rules[pattern=main]/enforcement', 'branch-rules.advisory-enforced')],
      policies(['branch-rules.advisory-enforced']),
    );
    expect(r.acceptTasks).toEqual([]);
    expect(r.decisions[0]).toMatchObject({ accepted: 'policy' });
    expect(r.lossyAccepted).toEqual([
      {
        facetKey: 'branch-rules',
        path: '/rules[pattern=main]/enforcement',
        reason: 'lossy_accepted',
        note: 'branch-rules.advisory-enforced',
      },
    ]);
  });

  it('[FAC-005] unaccepted lossy decisions give one accept-lossy pre task per policy key with all paths', () => {
    const r = applyLossyPolicies(
      'branch-rules',
      [
        lossy('/rules[pattern=b]/x', 'branch-rules.k2'),
        lossy('/rules[pattern=a]/x', 'branch-rules.k1'),
        lossy('/rules[pattern=c]/x', 'branch-rules.k2'),
        lossy('/rules[pattern=c]/x', 'branch-rules.k2'),
      ],
      policies([]),
    );
    expect(r.acceptTasks).toEqual([
      {
        code: 'branch-rules.accept-lossy',
        paths: ['/rules[pattern=a]/x'],
        params: { policyKey: 'branch-rules.k1' },
      },
      {
        code: 'branch-rules.accept-lossy',
        paths: ['/rules[pattern=b]/x', '/rules[pattern=c]/x'],
        params: { policyKey: 'branch-rules.k2' },
      },
    ]);
    expect(r.decisions.every((d) => d.accepted === false)).toBe(true);
    expect(r.lossyAccepted).toEqual([]);
  });

  it('[FAC-005] differences are deduplicated by facet and path pattern', () => {
    const r = applyLossyPolicies(
      'f',
      [lossy('/a', 'f.one'), lossy('/a', 'f.one'), lossy('/a', 'f.two'), lossy('/b', 'f.one')],
      policies(['f.one', 'f.two']),
    );
    expect(r.lossyAccepted.map((d) => [d.path, d.note])).toEqual([
      ['/a', 'f.one'],
      ['/b', 'f.one'],
    ]);
  });

  it('[FAC-005] accepted is recomputed from the policies; only a migration acceptance is kept', () => {
    const r = applyLossyPolicies(
      'f',
      [
        lossy('/a', 'f.one', { accepted: 'policy' }), // stale: no longer in acceptLossy
        lossy('/b', 'f.one', { accepted: 'migration' }),
        lossy('/c', 'f.two', { accepted: false }),
      ],
      policies(['f.two']),
    );
    expect(r.decisions.map((d) => d.accepted)).toEqual([false, 'migration', 'policy']);
    expect(r.acceptTasks).toEqual([
      { code: 'f.accept-lossy', paths: ['/a'], params: { policyKey: 'f.one' } },
    ]);
    expect(r.lossyAccepted.map((d) => d.path)).toEqual(['/c']);
  });

  it('[FAC-005] non-lossy decisions pass through untouched', () => {
    const ds: FieldDecision[] = (['exact', 'translated', 'unsupported', 'unreadable'] as const).map(
      (fidelity, i) => ({
        path: `/p${i}`,
        fidelity,
        accepted: false,
        note: 'n',
      }),
    );
    const r = applyLossyPolicies('f', ds, policies(['f.one']));
    expect(r.decisions).toEqual(ds);
    expect(r.acceptTasks).toEqual([]);
    expect(r.lossyAccepted).toEqual([]);
  });

  it('[FAC-005] a literal star in a decision path is escaped so the stored difference never acts as a wildcard', () => {
    const r = applyLossyPolicies('f', [lossy('/rules[pattern=*]/x', 'f.one')], policies(['f.one']));
    const stored = r.lossyAccepted[0]?.path as string;
    expect(stored).toBe('/rules[pattern=\\*]/x');
    expect(r.decisions[0]?.path).toBe(stored);
    expect(matchesPattern(stored, '/rules[pattern=main]/x')).toBe(false);
    expect(matchesPattern(stored, '/rules[pattern=\\*]/x')).toBe(true);
  });

  it('[FAC-005] a facet bug (missing/foreign key, bad path) throws instead of being accepted', () => {
    const p = policies(['f.one']);
    expect(() =>
      applyLossyPolicies('f', [{ path: '/a', fidelity: 'lossy', accepted: false }], p),
    ).toThrow(PolicyError);
    expect(() => applyLossyPolicies('f', [lossy('/a', 'nodot')], p)).toThrow(/no valid policy key/);
    expect(() => applyLossyPolicies('f', [lossy('/a', 'g.one')], p)).toThrow(
      /does not belong to facet f/,
    );
    expect(() => applyLossyPolicies('f', [lossy('a', 'f.one')], p)).toThrow(/invalid path/);
    expect(() => applyLossyPolicies('f', [lossy('', 'f.one')], p)).toThrow(/invalid path/);
  });

  it('[FAC-005] an empty decision list produces nothing', () => {
    expect(applyLossyPolicies('f', [], policies([]))).toEqual({
      decisions: [],
      acceptTasks: [],
      lossyAccepted: [],
    });
  });
});
