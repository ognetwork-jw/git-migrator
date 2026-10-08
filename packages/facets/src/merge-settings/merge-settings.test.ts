import type { MergeSettings } from '@git-migrator/canonical';
import {
  compareFacet,
  type FacetCapability,
  FacetRegistry,
  resolveRoutePolicies,
  type TranslateEnvironment,
  translateFacet,
} from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import { mergeSettingsDefinition } from './index.ts';

const registry = new FacetRegistry().register(mergeSettingsDefinition);
const unresolved = { resolve: () => ({ status: 'unmapped' as const }) };
const envWith = (
  route: TranslateEnvironment['route'] = {},
  acceptLossy?: string[],
): TranslateEnvironment => ({
  identities: unresolved,
  groups: unresolved,
  policies: resolveRoutePolicies(acceptLossy === undefined ? {} : { acceptLossy }),
  route,
  routeIndex: {},
});

const unreadable = (...paths: string[]): FacetCapability => ({
  read: true,
  write: false,
  fields: Object.fromEntries(paths.map((p) => [p, { kind: 'unreadable' as const }])),
});

const all: MergeSettings = {
  allowed: ['merge-commit', 'rebase', 'squash'],
  deleteBranchOnMerge: false,
};

describe('merge-settings facet', () => {
  it('[FAC-MRG-001] merge-commit, squash and rebase map one to one', () => {
    for (const allowed of [['merge-commit'], ['squash'], ['rebase'], all.allowed] as const) {
      const t = translateFacet(
        registry,
        'merge-settings',
        { ...all, allowed: [...allowed] },
        { env: envWith() },
      );
      expect([...(t.desired as MergeSettings).allowed].sort()).toEqual([...allowed].sort());
      expect(t.decisions).toEqual([]);
      expect(t.preTasks).toEqual([]);
    }
  });

  it('[FAC-MRG-001] deleteBranchOnMerge is carried over exactly', () => {
    for (const value of [true, false]) {
      const t = translateFacet(
        registry,
        'merge-settings',
        { ...all, deleteBranchOnMerge: value },
        { env: envWith() },
      );
      expect((t.desired as MergeSettings).deleteBranchOnMerge).toBe(value);
    }
  });

  it('[FAC-MRG-001] fast-forward-only becomes rebase and needs the policy key accepted', () => {
    const t = translateFacet(
      registry,
      'merge-settings',
      { allowed: ['fast-forward-only', 'squash'], deleteBranchOnMerge: true },
      { env: envWith() },
    );
    expect([...(t.desired as MergeSettings).allowed].sort()).toEqual(['rebase', 'squash']);
    expect(t.decisions).toEqual([
      expect.objectContaining({
        path: '/allowed',
        fidelity: 'lossy',
        policyKey: 'merge-settings.ff-only-as-rebase',
        accepted: false,
      }),
    ]);
    expect(t.preTasks).toEqual([
      expect.objectContaining({
        code: 'merge-settings.accept-lossy',
        paths: ['/allowed'],
        params: { policyKey: 'merge-settings.ff-only-as-rebase', paths: ['/allowed'] },
      }),
    ]);
  });

  it('[FAC-005] an accepted policy key produces no task and one Expected Difference', () => {
    const t = translateFacet(
      registry,
      'merge-settings',
      { allowed: ['fast-forward-only'], deleteBranchOnMerge: true },
      { env: envWith({}, ['merge-settings.ff-only-as-rebase']) },
    );
    expect(t.preTasks).toEqual([]);
    expect(t.decisions[0]?.accepted).toBe('policy');
    expect(t.expectedDifferences).toEqual([
      expect.objectContaining({
        reason: 'lossy_accepted',
        note: 'merge-settings.ff-only-as-rebase',
      }),
    ]);
  });

  it('[FAC-MRG-001] fast-forward-only alongside rebase collapses to one rebase', () => {
    const t = translateFacet(
      registry,
      'merge-settings',
      { allowed: ['fast-forward-only', 'rebase'], deleteBranchOnMerge: true },
      { env: envWith() },
    );
    expect((t.desired as MergeSettings).allowed).toEqual(['rebase']);
  });

  it('[FAC-MRG-002] unreadable fields take the Route defaults and record unreadable_defaulted', () => {
    const route = {
      defaults: { mergeSettings: { allowed: ['squash'], deleteBranchOnMerge: false } },
    };
    const t = translateFacet(registry, 'merge-settings', all, {
      env: envWith(route),
      sourceCaps: unreadable('/allowed', '/deleteBranchOnMerge'),
    });
    expect(t.desired).toEqual({ allowed: ['squash'], deleteBranchOnMerge: false });
    expect(t.decisions.map((d) => [d.path, d.fidelity, d.defaulted])).toEqual([
      ['/allowed', 'unreadable', true],
      ['/deleteBranchOnMerge', 'unreadable', true],
    ]);
    expect(t.expectedDifferences.map((e) => [e.path, e.reason])).toEqual([
      ['/allowed', 'unreadable_defaulted'],
      ['/deleteBranchOnMerge', 'unreadable_defaulted'],
    ]);
    expect([...t.blockers, ...t.preTasks, ...t.postTasks]).toEqual([]);
  });

  it('[FAC-MRG-002] without Route configuration the default is all three strategies and delete on merge', () => {
    const t = translateFacet(
      registry,
      'merge-settings',
      { allowed: [], deleteBranchOnMerge: false },
      { env: envWith(), sourceCaps: unreadable('/allowed', '/deleteBranchOnMerge') },
    );
    expect(t.desired).toEqual({
      allowed: ['merge-commit', 'rebase', 'squash'],
      deleteBranchOnMerge: true,
    });
  });

  it('[FAC-MRG-002] only the unreadable field is defaulted', () => {
    const t = translateFacet(registry, 'merge-settings', all, {
      env: envWith(),
      sourceCaps: unreadable('/deleteBranchOnMerge'),
    });
    expect(t.desired).toEqual({ allowed: [...all.allowed].sort(), deleteBranchOnMerge: true });
    expect(t.decisions.map((d) => d.path)).toEqual(['/deleteBranchOnMerge']);
  });

  it('[FAC-MRG-002] a Route default with fast-forward-only is mapped to rebase without a task', () => {
    const route = {
      defaults: { mergeSettings: { allowed: ['fast-forward-only'], deleteBranchOnMerge: true } },
    };
    const t = translateFacet(registry, 'merge-settings', all, {
      env: envWith(route),
      sourceCaps: unreadable('/allowed'),
    });
    expect((t.desired as MergeSettings).allowed).toEqual(['rebase']);
    expect(t.preTasks).toEqual([]);
  });

  it('[FAC-MRG-002] an invalid Route default is an error, not a silent fallback', () => {
    expect(() =>
      translateFacet(registry, 'merge-settings', all, {
        env: envWith({ defaults: { mergeSettings: { allowed: ['yolo'] } } }),
        sourceCaps: unreadable('/allowed'),
      }),
    ).toThrow(/translate/);
  });

  describe('compare', () => {
    const cmp = (desired: MergeSettings, actual: MergeSettings | null) =>
      compareFacet(registry, 'merge-settings', desired, actual);

    it('[FAC-MRG-001] the allowed set is compared without regard to order', () => {
      expect(cmp(all, { ...all, allowed: ['rebase', 'merge-commit', 'squash'] })?.status).toBe(
        'equal',
      );
    });

    it('[FAC-MRG-001] a different set or flag is reported by path', () => {
      const result = cmp(all, { allowed: ['squash'], deleteBranchOnMerge: true });
      expect(result?.status).toBe('different');
      expect(result?.diffs.map((d) => d.path)).toEqual(['/allowed', '/deleteBranchOnMerge']);
    });

    it('[LIF-060] an unreadable target is unverifiable', () => {
      expect(cmp(all, null)?.status).toBe('unverifiable');
    });
  });

  it('[FAC-005] declares its policy key and the accept task', () => {
    expect(mergeSettingsDefinition.policyKeys).toEqual(['merge-settings.ff-only-as-rebase']);
    expect(mergeSettingsDefinition.findingCodes['merge-settings.accept-lossy']).toEqual({
      kind: 'pre',
      completion: 'accept',
    });
  });
});
