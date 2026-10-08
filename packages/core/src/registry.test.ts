import { describe, expect, it } from 'vitest';
import {
  acceptLossyCode,
  type FacetDefinition,
  FacetRegistry,
  isFacetKey,
  RegistryError,
} from './index.ts';

type Doc = Record<string, unknown>;

function def(key: string, over: Partial<FacetDefinition<Doc>> = {}): FacetDefinition<Doc> {
  return {
    key,
    scope: 'repository',
    schemaVersion: 1,
    schema: { parse: (d) => d as Doc },
    compareMode: 'full',
    collections: [],
    dependsOn: [],
    inScope: true,
    normalize: (d) => d,
    translate: (s) => ({
      desired: s,
      decisions: [],
      blockers: [],
      preTasks: [],
      postTasks: [],
      warnings: [],
    }),
    compare: () => [],
    findingCodes: {},
    policyKeys: [],
    ...over,
  };
}

const rejects = (d: FacetDefinition<Doc>, message: RegExp) =>
  expect(() => new FacetRegistry().register(d)).toThrow(message);

describe('[ADP-030] registry validation', () => {
  it('[ADP-030] accepts a minimal definition and rejects duplicates and unknown lookups', () => {
    const r = new FacetRegistry().register(def('alpha'));
    expect(r.has('alpha')).toBe(true);
    expect(r.get('alpha').key).toBe('alpha');
    expect(r.keys()).toEqual(['alpha']);
    expect(() => r.register(def('alpha'))).toThrow(/already registered/);
    expect(() => r.get('beta')).toThrow(RegistryError);
    expect(r.has('beta')).toBe(false);
  });

  it('[ADP-030] keys are kebab-case', () => {
    expect(isFacetKey('git-refs')).toBe(true);
    for (const bad of ['', 'Git', 'a_b', 'a--b', '-a', 'a-', '1a', 3 as never]) {
      expect(isFacetKey(bad), String(bad)).toBe(false);
    }
    rejects(def('Bad_Key'), /kebab-case/);
  });

  it('[ADP-030] structural fields are checked', () => {
    rejects(def('a', { scope: 'x' as never }), /scope/);
    rejects(def('a', { schemaVersion: 0 }), /schemaVersion/);
    rejects(def('a', { schemaVersion: 1.5 }), /schemaVersion/);
    rejects(def('a', { compareMode: 'x' as never }), /compareMode/);
    rejects(def('a', { inScope: undefined as never }), /inScope/);
    rejects(def('a', { normalize: undefined as never }), /normalize/);
    rejects(def('a', { schema: {} as never }), /schema/);
  });

  it('[ADP-030] dependencies must be well-formed and unique', () => {
    rejects(def('a', { dependsOn: ['A'] }), /invalid dependency/);
    rejects(def('a', { dependsOn: ['a'] }), /itself/);
    rejects(def('a', { dependsOn: ['b', 'b'] }), /duplicate dependency/);
  });

  it('[ADP-021] collection declarations are validated at registration', () => {
    rejects(def('a', { collections: [{ path: '/x[k=1]', key: 'k' }] }), /plain field names/);
    rejects(def('a', { sets: ['/x'], collections: [{ path: '/x', key: 'k' }] }), /both/);
  });

  it('[ADP-030] [LIF-006] finding codes are namespaced and carry a valid kind and completion', () => {
    rejects(def('a', { findingCodes: { 'b.thing': { kind: 'pre' } } }), /must be a\.<name>/);
    rejects(def('a', { findingCodes: { thing: { kind: 'pre' } } }), /must be a\.<name>/);
    rejects(def('a', { findingCodes: { 'a.thing': { kind: 'x' as never } } }), /invalid kind/);
    rejects(
      def('a', { findingCodes: { 'a.thing': { kind: 'blocker', completion: 'manual' } } }),
      /not a task/,
    );
    rejects(
      def('a', { findingCodes: { 'a.thing': { kind: 'pre', completion: 'x' as never } } }),
      /invalid completion/,
    );
    rejects(
      def('a', { findingCodes: { 'a.thing': { kind: 'post', completion: 'parity' } } }),
      /isTaskSatisfied/,
    );
    rejects(
      def('a', { findingCodes: { 'a.thing': { kind: 'pre', completion: 'accept' } } }),
      /only a\.accept-lossy/,
    );
    expect(() =>
      new FacetRegistry().register(
        def('a', {
          findingCodes: { 'a.thing': { kind: 'post', completion: 'parity' } },
          isTaskSatisfied: () => true,
        }),
      ),
    ).not.toThrow();
  });

  it('[FAC-005] policy keys belong to the facet, are not finding codes, and need an accept-lossy code', () => {
    const accept = {
      [acceptLossyCode('a')]: { kind: 'pre' as const, completion: 'accept' as const },
    };
    rejects(def('a', { policyKeys: ['b.x'], findingCodes: accept }), /policy key/);
    rejects(def('a', { policyKeys: ['a'], findingCodes: accept }), /policy key/);
    rejects(def('a', { policyKeys: ['a.x', 'a.x'], findingCodes: accept }), /duplicate policy key/);
    rejects(def('a', { policyKeys: ['a.x'] }), /must declare a\.accept-lossy/);
    rejects(
      def('a', {
        policyKeys: ['a.thing'],
        findingCodes: { ...accept, 'a.thing': { kind: 'warning' } },
      }),
      /both a policy key and a finding code/,
    );
    rejects(
      def('a', { findingCodes: { 'a.accept-lossy': { kind: 'post' } } }),
      /pre task with completion accept/,
    );
    expect(() =>
      new FacetRegistry().register(def('a', { policyKeys: ['a.x'], findingCodes: accept })),
    ).not.toThrow();
  });

  it('[FAC-005] policyOwner finds the declaring facet only', () => {
    const accept = {
      [acceptLossyCode('a')]: { kind: 'pre' as const, completion: 'accept' as const },
    };
    const r = new FacetRegistry().register(def('a', { policyKeys: ['a.x'], findingCodes: accept }));
    expect(r.policyOwner('a.x')).toBe('a');
    expect(r.policyOwner('a.y')).toBeUndefined();
    expect(r.policyOwner('b.x')).toBeUndefined();
    expect(r.policyOwner('nonsense')).toBeUndefined();
    expect(r.unknownPolicyKeys(['a.x', 'z.y', 'a.y', 'z.y'])).toEqual(['a.y', 'z.y']);
  });
});

describe('[ADP-030] dependency order', () => {
  const build = (order: string[]): FacetRegistry => {
    const defs: Record<string, string[]> = { c: ['a', 'b'], b: ['a'], a: [], d: [], e: ['d'] };
    const r = new FacetRegistry();
    for (const k of order) r.register(def(k, { dependsOn: defs[k] }));
    return r;
  };

  it('[ADP-030] orders dependencies first and ties by key, independent of registration order', () => {
    const expected = ['a', 'b', 'c', 'd', 'e'];
    for (const order of [
      ['a', 'b', 'c', 'd', 'e'],
      ['e', 'd', 'c', 'b', 'a'],
      ['c', 'e', 'a', 'd', 'b'],
    ]) {
      expect(
        build(order)
          .ordered()
          .map((d) => d.key),
      ).toEqual(expected);
    }
  });

  it('[ADP-030] a missing dependency, a cycle and an endpoint depending on a repository facet are errors', () => {
    expect(() => new FacetRegistry().register(def('a', { dependsOn: ['zz'] })).ordered()).toThrow(
      /unregistered facet zz/,
    );
    const cyc = new FacetRegistry()
      .register(def('a', { dependsOn: ['b'] }))
      .register(def('b', { dependsOn: ['a'] }))
      .register(def('c'));
    expect(() => cyc.ordered()).toThrow(/cycle among facets: a, b/);
    const bad = new FacetRegistry()
      .register(def('r'))
      .register(def('e', { scope: 'endpoint', dependsOn: ['r'] }));
    expect(() => bad.ordered()).toThrow(/endpoint facet e cannot depend on repository facet r/);
    const ok = new FacetRegistry()
      .register(def('e', { scope: 'endpoint' }))
      .register(def('r', { dependsOn: ['e'] }));
    expect(ok.ordered().map((d) => d.key)).toEqual(['e', 'r']);
  });
});

describe('[ADP-032] override registration', () => {
  const o = {
    source: 's',
    target: 't',
    facet: 'a',
    translate: (x: Doc) => ({
      desired: x,
      decisions: [],
      blockers: [],
      preTasks: [],
      postTasks: [],
      warnings: [],
    }),
  };
  it('[ADP-032] needs a registered facet, non-empty sides, a function, and is unique per triple', () => {
    const r = new FacetRegistry().register(def('a'));
    expect(() => r.registerOverride({ ...o, facet: 'nope' })).toThrow(/unregistered facet/);
    expect(() => r.registerOverride({ ...o, source: '' })).toThrow(/non-empty/);
    expect(() => r.registerOverride({ ...o, target: 3 as never })).toThrow(/non-empty/);
    expect(() => r.registerOverride({ ...o, translate: 1 as never })).toThrow(/function/);
    r.registerOverride(o);
    expect(() => r.registerOverride(o)).toThrow(/already registered/);
    r.registerOverride({ ...o, target: 'u' });
    expect(r.overrides().map((x) => x.target)).toEqual(['t', 'u']);
  });
});
