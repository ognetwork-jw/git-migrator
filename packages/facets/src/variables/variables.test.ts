import type { Environments, Variables } from '@git-migrator/canonical';
import {
  compareFacet,
  FacetEngineError,
  FacetRegistry,
  resolveRoutePolicies,
  type TranslateEnvironment,
  translateAll,
} from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import { environmentsDefinition } from '../environments/index.ts';
import { variablesDefinition } from './index.ts';

const registry = new FacetRegistry().register(environmentsDefinition).register(variablesDefinition);
const unresolved = { resolve: () => ({ status: 'unmapped' as const }) };
const env = (acceptLossy: string[] = []): TranslateEnvironment => ({
  identities: unresolved,
  groups: unresolved,
  policies: resolveRoutePolicies({ acceptLossy }),
  route: {},
  routeIndex: {},
});
const v = (name: string, value = '1', scope = 'repository') => ({
  key: `${scope}/${name}`,
  scope,
  name,
  value,
});
const env1 = (name: string): Environments['environments'][number] => ({
  name,
  category: null,
  deploymentBranches: null,
});

function run(variables: Variables['variables'], environments: string[] = [], accept?: string[]) {
  const all = translateAll(registry, {
    env: env(accept),
    sources: {
      environments: { environments: environments.map(env1) },
      variables: { variables },
    },
  });
  const t = all.translations.find((x) => x.facetKey === 'variables');
  if (t === undefined) throw new Error('not translated');
  return t;
}

describe('variables facet', () => {
  it('[FAC-VAR-002] valid upper-case repository and environment variables are exact', () => {
    const t = run(
      [v('API_URL', 'https://example.test'), v('REGION', 'eu', 'environment:prod')],
      ['prod'],
    );
    expect((t.desired as Variables).variables.map((x) => [x.key, x.value])).toEqual([
      ['environment:prod/REGION', 'eu'],
      ['repository/API_URL', 'https://example.test'],
    ]);
    expect(t.decisions).toEqual([]);
    expect([...t.preTasks, ...t.postTasks, ...t.blockers]).toEqual([]);
  });

  it('[FAC-VAR-003] lowercase names are upper-cased: lossy variables.uppercase-names', () => {
    const t = run([v('api_url', 'x')]);
    expect((t.desired as Variables).variables).toEqual([v('API_URL', 'x')]);
    expect(t.decisions).toEqual([
      expect.objectContaining({
        path: '/variables[key=repository/API_URL]/name',
        fidelity: 'lossy',
        policyKey: 'variables.uppercase-names',
        accepted: false,
      }),
    ]);
    expect(t.preTasks).toEqual([
      expect.objectContaining({
        code: 'variables.accept-lossy',
        params: {
          policyKey: 'variables.uppercase-names',
          paths: ['/variables[key=repository/API_URL]/name'],
        },
      }),
    ]);
  });

  it('[FAC-005] an accepted variables.uppercase-names produces no task', () => {
    const t = run([v('api_url')], [], ['variables.uppercase-names']);
    expect(t.preTasks).toEqual([]);
    expect(t.decisions[0]?.accepted).toBe('policy');
  });

  it('[FAC-VAR-003] a GITHUB_ prefix raises variables.name-invalid and the variable is omitted', () => {
    for (const name of ['GITHUB_TOKEN', 'github_ref']) {
      const t = run([v(name), v('OK')]);
      expect((t.desired as Variables).variables.map((x) => x.name)).toEqual(['OK']);
      expect(t.preTasks).toEqual([
        expect.objectContaining({
          code: 'variables.name-invalid',
          paths: [`/variables[key=repository/${name}]`],
          params: { names: [name] },
        }),
      ]);
    }
  });

  it('[FAC-VAR-003] names that are not identifiers raise variables.name-invalid', () => {
    const t = run([v('1ST'), v('my-var'), v('a.b'), v('_OK')]);
    expect((t.desired as Variables).variables.map((x) => x.name)).toEqual(['_OK']);
    expect(t.preTasks[0]).toMatchObject({
      code: 'variables.name-invalid',
      params: { names: ['1ST', 'a.b', 'my-var'] },
    });
  });

  it('[FAC-VAR-003] a collision after normalization rejects every colliding variable', () => {
    const t = run([v('Token', 'a'), v('TOKEN', 'b'), v('Other')]);
    expect((t.desired as Variables).variables.map((x) => x.name)).toEqual(['OTHER']);
    expect(t.preTasks).toContainEqual(
      expect.objectContaining({
        code: 'variables.name-invalid',
        params: { names: ['TOKEN', 'Token'] },
      }),
    );
  });

  it('[FAC-VAR-003] the same name in different scopes is not a collision', () => {
    const t = run([v('X'), v('X', '2', 'environment:prod')], ['prod']);
    expect((t.desired as Variables).variables).toHaveLength(2);
    expect(t.preTasks).toEqual([]);
  });

  it('[FAC-VAR-001] an environment variable takes the casing of the target environment', () => {
    const t = run([v('X', '1', 'environment:Prod')], ['prod']);
    expect((t.desired as Variables).variables).toEqual([v('X', '1', 'environment:prod')]);
  });

  it('[FAC-VAR-003] variables of environments that differ only by case collide', () => {
    const t = run(
      [v('X', '1', 'environment:Prod'), v('X', '2', 'environment:prod')],
      ['Prod', 'prod'],
    );
    expect((t.desired as Variables).variables).toEqual([]);
    expect(t.preTasks).toContainEqual(
      expect.objectContaining({ code: 'variables.name-invalid', params: { names: ['X'] } }),
    );
  });

  it('[FAC-VAR-001] without the environments dependency the scope is left as it is', () => {
    const all = translateAll(registry, {
      env: env(),
      sources: { variables: { variables: [v('X', '1', 'environment:Prod')] } },
    });
    const desired = all.translations[0]?.desired as Variables;
    expect(desired.variables[0]?.scope).toBe('environment:Prod');
  });

  it('[FAC-VAR-003] the value is carried over exactly, including an empty one', () => {
    const t = run([v('A', ''), v('B', ' spaced  value ')]);
    expect((t.desired as Variables).variables.map((x) => x.value)).toEqual(['', ' spaced  value ']);
  });

  it('[FAC-001] a source variable with a key that is not scope/name is rejected', () => {
    expect(() =>
      run([{ key: 'repository/other', scope: 'repository', name: 'A', value: '' }]),
    ).toThrow(FacetEngineError);
  });

  describe('compare', () => {
    const cmp = (desired: Variables['variables'], actual: Variables['variables'] | null) =>
      compareFacet(
        registry,
        'variables',
        { variables: desired },
        actual === null ? null : { variables: actual },
      );

    it('[FAC-VAR-002] equal in any order', () => {
      expect(cmp([v('A'), v('B', '2')], [v('B', '2'), v('A')])?.status).toBe('equal');
    });

    it('[FAC-VAR-002] a different value, a missing and an extra variable are reported', () => {
      const r = cmp([v('A', '1'), v('B')], [v('A', '2'), v('C')]);
      const paths = r?.diffs.map((d) => d.path) ?? [];
      expect(paths).toContain('/variables[key=repository/A]/value');
      expect(paths.some((p) => p.startsWith('/variables[key=repository/B]'))).toBe(true);
      expect(paths.some((p) => p.startsWith('/variables[key=repository/C]'))).toBe(true);
      expect(r?.status).toBe('different');
    });

    it('[FAC-VAR-001] the case of an environment on the target is not drift', () => {
      expect(
        cmp([v('A', '1', 'environment:Prod')], [v('A', '1', 'environment:prod')])?.status,
      ).toBe('equal');
    });

    it('[LIF-060] an unreadable target is unverifiable', () => {
      expect(cmp([], null)?.status).toBe('unverifiable');
    });
  });

  it('[FAC-005] declares its policy key and finding codes', () => {
    expect(variablesDefinition.policyKeys).toEqual(['variables.uppercase-names']);
    expect(variablesDefinition.findingCodes).toEqual({
      'variables.accept-lossy': { kind: 'pre', completion: 'accept' },
      'variables.name-invalid': { kind: 'pre' },
    });
    expect(variablesDefinition.dependsOn).toEqual(['environments']);
  });
});
