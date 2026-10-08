import type { RepositorySettings } from '@git-migrator/canonical';
import {
  compareFacet,
  type FacetCapability,
  FacetRegistry,
  resolveRoutePolicies,
  type TranslateEnvironment,
  translateFacet,
} from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import {
  MAX_DESCRIPTION_LENGTH,
  normalizeRepositorySettings,
  repositorySettingsDefinition,
  stripMigratedPrefix,
} from './index.ts';

const registry = new FacetRegistry().register(repositorySettingsDefinition);
const unresolved = { resolve: () => ({ status: 'unmapped' as const }) };
const envWith = (acceptLossy?: string[]): TranslateEnvironment => ({
  identities: unresolved,
  groups: unresolved,
  policies: resolveRoutePolicies(acceptLossy === undefined ? {} : { acceptLossy }),
  route: {},
  routeIndex: {},
});
const noForking: FacetCapability = {
  read: true,
  write: true,
  fields: { '/forking': { kind: 'unsupported', note: 'org setting' } },
};

const base: RepositorySettings = {
  description: 'Payments service',
  homepage: 'https://example.test/payments',
  visibility: 'private',
  features: { issues: true, wiki: false },
  forking: 'allowed',
};

const translate = (
  source: RepositorySettings,
  extra: { acceptLossy?: string[]; targetCaps?: FacetCapability } = {},
) =>
  translateFacet(registry, 'repository-settings', source, {
    env: envWith(extra.acceptLossy),
    targetCaps: extra.targetCaps,
  });

const desiredOf = (t: ReturnType<typeof translate>) => t.desired as RepositorySettings;

describe('repository-settings facet', () => {
  it('[FAC-SET] exact fields are carried over unchanged', () => {
    for (const visibility of ['private', 'public'] as const) {
      const source = { ...base, visibility };
      const t = translate(source);
      expect(t.desired).toEqual(source);
      expect(t.decisions).toEqual([]);
      expect([...t.blockers, ...t.preTasks, ...t.postTasks, ...t.warnings]).toEqual([]);
    }
  });

  it('[FAC-SET] homepage and features pass through, including null and disabled features', () => {
    const source = { ...base, homepage: null, features: { issues: false, wiki: true } };
    expect(translate(source).desired).toEqual(source);
  });

  describe('description', () => {
    it('[FAC-SET-003] normalize strips the framework prefix and trims', () => {
      expect(
        normalizeRepositorySettings({
          ...base,
          description: '  [MIGRATED → https://gh.example.test/acme/pay] Payments service  ',
        }).description,
      ).toBe('Payments service');
    });

    it('[FAC-SET-003] a prefix whose trailing space was trimmed is still stripped', () => {
      expect(stripMigratedPrefix('[MIGRATED → https://gh.example.test/a/b]')).toBe('');
    });

    it('[FAC-SET-003] text that only looks like the prefix is kept', () => {
      expect(stripMigratedPrefix('[MIGRATED → url]text')).toBe('[MIGRATED → url]text');
      expect(stripMigratedPrefix('notes [MIGRATED → url] x')).toBe('notes [MIGRATED → url] x');
    });

    it('[FAC-SET-003] the prefix never reaches desired and needs no Expected Difference', () => {
      const t = translate({
        ...base,
        description: '[MIGRATED → https://gh.example.test/a/b] Payments service',
      });
      expect(desiredOf(t).description).toBe('Payments service');
      expect(t.expectedDifferences).toEqual([]);
    });

    it('[FAC-SET] a description of exactly 350 characters is exact', () => {
      const description = 'x'.repeat(MAX_DESCRIPTION_LENGTH);
      const t = translate({ ...base, description });
      expect(desiredOf(t).description).toBe(description);
      expect(t.decisions).toEqual([]);
    });

    it('[FAC-SET] a longer description is truncated at 350 and is lossy', () => {
      const t = translate({ ...base, description: 'y'.repeat(400) });
      expect(desiredOf(t).description).toBe('y'.repeat(350));
      expect(t.decisions).toEqual([
        expect.objectContaining({
          path: '/description',
          fidelity: 'lossy',
          policyKey: 'repository-settings.description-truncated',
          accepted: false,
        }),
      ]);
      expect(t.preTasks.map((p) => p.code)).toEqual(['repository-settings.accept-lossy']);
    });

    it('[FAC-SET] truncation never splits a surrogate pair', () => {
      const description = `${'a'.repeat(349)}\u{1F600}${'b'.repeat(10)}`;
      expect(desiredOf(translate({ ...base, description })).description).toBe('a'.repeat(349));
    });

    it('[FAC-005] an accepted truncation policy raises no task', () => {
      const t = translate(
        { ...base, description: 'z'.repeat(351) },
        { acceptLossy: ['repository-settings.description-truncated'] },
      );
      expect(t.preTasks).toEqual([]);
      expect(t.decisions[0]?.accepted).toBe('policy');
    });
  });

  describe('normalize', () => {
    it('[FAC-SET] trims the homepage and treats an empty one as none', () => {
      expect(
        normalizeRepositorySettings({ ...base, homepage: '  https://a.test  ' }).homepage,
      ).toBe('https://a.test');
      expect(normalizeRepositorySettings({ ...base, homepage: '   ' }).homepage).toBeNull();
    });
  });

  describe('forking', () => {
    it('[FAC-SET] private: allowed and disallowed are exact', () => {
      for (const forking of ['allowed', 'disallowed'] as const) {
        const t = translate({ ...base, forking });
        expect(desiredOf(t).forking).toBe(forking);
        expect(t.decisions).toEqual([]);
      }
    });

    it('[FAC-SET] private: private-only is translated to allowed, with no task', () => {
      const t = translate({ ...base, forking: 'private-only' });
      expect(desiredOf(t).forking).toBe('allowed');
      expect(t.decisions).toEqual([
        expect.objectContaining({ path: '/forking', fidelity: 'translated' }),
      ]);
      expect(t.preTasks).toEqual([]);
    });

    it('[FAC-SET] public: allowed is exact', () => {
      const t = translate({ ...base, visibility: 'public', forking: 'allowed' });
      expect(t.decisions).toEqual([]);
    });

    it('[FAC-SET] public: private-only is lossy under repository-settings.public-fork-policy', () => {
      const t = translate({ ...base, visibility: 'public', forking: 'private-only' });
      expect(desiredOf(t).forking).toBe('allowed');
      expect(t.decisions).toEqual([
        expect.objectContaining({
          path: '/forking',
          fidelity: 'lossy',
          policyKey: 'repository-settings.public-fork-policy',
        }),
      ]);
      expect(t.preTasks).toEqual([
        expect.objectContaining({
          code: 'repository-settings.accept-lossy',
          params: { policyKey: 'repository-settings.public-fork-policy', paths: ['/forking'] },
        }),
      ]);
    });

    it('[FAC-SET] public: disallowed cannot be represented either and is lossy', () => {
      const t = translate({ ...base, visibility: 'public', forking: 'disallowed' });
      expect(desiredOf(t).forking).toBe('allowed');
      expect(t.decisions[0]).toMatchObject({
        fidelity: 'lossy',
        policyKey: 'repository-settings.public-fork-policy',
      });
    });

    it('[FAC-005] an accepted public-fork-policy raises no task', () => {
      const t = translate(
        { ...base, visibility: 'public', forking: 'private-only' },
        { acceptLossy: ['repository-settings.public-fork-policy'] },
      );
      expect(t.preTasks).toEqual([]);
      expect(t.expectedDifferences).toEqual([
        expect.objectContaining({
          reason: 'lossy_accepted',
          note: 'repository-settings.public-fork-policy',
        }),
      ]);
    });

    it('[FAC-SET-002] org forking disabled raises a post task on a private repository', () => {
      const t = translate(base, { targetCaps: noForking });
      expect(t.postTasks).toEqual([
        expect.objectContaining({
          code: 'repository-settings.org-forking-disabled',
          paths: ['/forking'],
          params: {},
        }),
      ]);
      expect(t.decisions).toEqual([
        expect.objectContaining({ path: '/forking', fidelity: 'unsupported' }),
      ]);
      expect(t.blockers).toEqual([]);
      expect(t.preTasks).toEqual([]);
    });

    it('[FAC-SET-002] the unsupported decision wins over the private-only translation', () => {
      const t = translate({ ...base, forking: 'private-only' }, { targetCaps: noForking });
      expect(t.decisions.map((d) => d.fidelity)).toEqual(['unsupported']);
      expect(t.postTasks).toHaveLength(1);
    });

    it('[FAC-SET-002] a public repository is unaffected by the organization setting', () => {
      const t = translate({ ...base, visibility: 'public' }, { targetCaps: noForking });
      expect(t.postTasks).toEqual([]);
    });

    it('[FAC-SET-002] a supported field raises nothing', () => {
      const caps: FacetCapability = {
        read: true,
        write: true,
        fields: { '/forking': { kind: 'supported' } },
      };
      expect(translate(base, { targetCaps: caps }).postTasks).toEqual([]);
    });
  });

  describe('compare', () => {
    const cmp = (desired: RepositorySettings, actual: RepositorySettings | null) =>
      compareFacet(registry, 'repository-settings', desired, actual);

    it('[FAC-SET] identical documents are equal', () => {
      expect(cmp(base, { ...base })?.status).toBe('equal');
    });

    it('[FAC-SET] every differing field is reported by path', () => {
      const result = cmp(base, {
        description: 'Other',
        homepage: null,
        visibility: 'public',
        features: { issues: false, wiki: true },
        forking: 'disallowed',
      });
      expect(result?.diffs.map((d) => d.path)).toEqual([
        '/description',
        '/features/issues',
        '/features/wiki',
        '/forking',
        '/homepage',
        '/visibility',
      ]);
    });

    it('[FAC-SET] private: private-only equals allowed', () => {
      expect(cmp(base, { ...base, forking: 'private-only' })?.status).toBe('equal');
      expect(cmp({ ...base, forking: 'private-only' }, base)?.status).toBe('equal');
    });

    it('[FAC-SET] public: private-only does not equal allowed', () => {
      const pub = { ...base, visibility: 'public' as const };
      expect(cmp(pub, { ...pub, forking: 'private-only' })?.status).toBe('different');
    });

    it('[FAC-SET-001] the repository name is not part of the facet', () => {
      expect(Object.keys(base)).not.toContain('name');
    });

    it('[LIF-060] an unreadable target is unverifiable', () => {
      expect(cmp(base, null)?.status).toBe('unverifiable');
    });
  });
});
