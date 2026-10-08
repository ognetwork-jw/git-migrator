import type { Environments } from '@git-migrator/canonical';
import {
  compareFacet,
  FacetRegistry,
  resolveRoutePolicies,
  type TranslateEnvironment,
  translateFacet,
} from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import { environmentsDefinition } from './index.ts';

const registry = new FacetRegistry().register(environmentsDefinition);
const unresolved = { resolve: () => ({ status: 'unmapped' as const }) };
const env = (acceptLossy?: string[]): TranslateEnvironment => ({
  identities: unresolved,
  groups: unresolved,
  policies: resolveRoutePolicies(acceptLossy === undefined ? {} : { acceptLossy }),
  route: {},
  routeIndex: {},
});
const translate = (source: Environments, acceptLossy?: string[]) =>
  translateFacet(registry, 'environments', source, { env: env(acceptLossy) });
const e = (
  name: string,
  category: Environments['environments'][number]['category'] = null,
  deploymentBranches: string[] | null = null,
) => ({ name, category, deploymentBranches });

describe('environments facet', () => {
  it('[FAC-ENV] a name with no category and no branch restriction is exact', () => {
    const t = translate({ environments: [e('qa')] });
    expect(t.desired).toEqual({ environments: [e('qa')] });
    expect(t.decisions).toEqual([]);
    expect([...t.preTasks, ...t.postTasks, ...t.blockers, ...t.warnings]).toEqual([]);
  });

  it('[FAC-ENV] every category is dropped as lossy environments.category-dropped', () => {
    for (const category of ['test', 'staging', 'production'] as const) {
      const t = translate({ environments: [e('x', category)] }, []);
      expect((t.desired as Environments).environments[0]?.category).toBeNull();
      expect(t.decisions).toEqual([
        expect.objectContaining({
          path: '/environments[name=x]/category',
          fidelity: 'lossy',
          policyKey: 'environments.category-dropped',
          accepted: false,
        }),
      ]);
      expect(t.preTasks).toEqual([
        expect.objectContaining({
          code: 'environments.accept-lossy',
          params: {
            policyKey: 'environments.category-dropped',
            paths: ['/environments[name=x]/category'],
          },
        }),
      ]);
    }
  });

  it('[FAC-005] environments.category-dropped is accepted by default and produces no task', () => {
    const t = translate({ environments: [e('prod', 'production')] });
    expect(t.preTasks).toEqual([]);
    expect(t.decisions[0]?.accepted).toBe('policy');
    expect(t.expectedDifferences).toEqual([
      expect.objectContaining({ reason: 'lossy_accepted', note: 'environments.category-dropped' }),
    ]);
  });

  it('[FAC-ENV] deployment branch restrictions are translated, as a sorted set', () => {
    const t = translate({ environments: [e('prod', null, ['release/*', 'main', 'main'])] });
    expect((t.desired as Environments).environments[0]?.deploymentBranches).toEqual([
      'main',
      'release/*',
    ]);
    expect(t.decisions).toEqual([
      expect.objectContaining({
        path: '/environments[name=prod]/deploymentBranches',
        fidelity: 'translated',
      }),
    ]);
    expect(t.preTasks).toEqual([]);
  });

  it('[FAC-ENV] null deployment branches (Standard) stay null', () => {
    const t = translate({ environments: [e('prod')] });
    expect((t.desired as Environments).environments[0]?.deploymentBranches).toBeNull();
  });

  it('[FAC-ENV] names that differ only by case raise a pre task and keep one environment', () => {
    const t = translate({ environments: [e('prod'), e('Prod'), e('qa')] });
    expect((t.desired as Environments).environments.map((x) => x.name).sort()).toEqual([
      'Prod',
      'qa',
    ]);
    expect(t.preTasks).toEqual([
      expect.objectContaining({
        code: 'environments.name-collision',
        paths: ['/environments[name=Prod]', '/environments[name=prod]'],
        params: { names: ['Prod', 'prod'] },
      }),
    ]);
    expect(t.decisions).toEqual([
      expect.objectContaining({ path: '/environments[name=prod]', fidelity: 'unsupported' }),
    ]);
  });

  it('[FAC-ENV] distinct names are not a collision', () => {
    const t = translate({ environments: [e('prod'), e('prod2')] });
    expect(t.preTasks).toEqual([]);
  });

  describe('compare', () => {
    const cmp = (desired: Environments, actual: Environments | null) =>
      compareFacet(registry, 'environments', desired, actual);

    it('[FAC-ENV] equal documents are equal, in any order', () => {
      const a = { environments: [e('a'), e('b', null, ['x', 'y'])] };
      const b = { environments: [e('b', null, ['y', 'x']), e('a')] };
      expect(cmp(a, b)?.status).toBe('equal');
    });

    it('[FAC-ENV] the case of an environment name on the target is not drift', () => {
      expect(cmp({ environments: [e('Prod')] }, { environments: [e('prod')] })?.status).toBe(
        'equal',
      );
    });

    it('[FAC-ENV] a missing environment and a different branch list are reported by path', () => {
      const r = cmp(
        { environments: [e('a', null, ['main']), e('b')] },
        { environments: [e('a', null, ['dev'])] },
      );
      expect(r?.status).toBe('different');
      expect(r?.diffs.map((d) => d.path)).toEqual([
        '/environments[name=a]/deploymentBranches',
        '/environments[name=b]/category',
        '/environments[name=b]/deploymentBranches',
        '/environments[name=b]/name',
      ]);
    });

    it('[LIF-060] an unreadable target is unverifiable', () => {
      expect(cmp({ environments: [] }, null)?.status).toBe('unverifiable');
    });
  });

  it('[FAC-005] declares its policy key, the accept task and the collision code', () => {
    expect(environmentsDefinition.policyKeys).toEqual(['environments.category-dropped']);
    expect(environmentsDefinition.findingCodes).toEqual({
      'environments.accept-lossy': { kind: 'pre', completion: 'accept' },
      'environments.name-collision': { kind: 'pre' },
    });
  });
});
