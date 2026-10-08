import type { Environments, Secrets } from '@git-migrator/canonical';
import {
  compareFacet,
  FacetEngineError,
  FacetRegistry,
  resolveRoutePolicies,
  satisfiedTasks,
  type TranslateEnvironment,
  translateAll,
} from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import { environmentsDefinition } from '../environments/index.ts';
import { secretsDefinition } from './index.ts';

const registry = new FacetRegistry().register(environmentsDefinition).register(secretsDefinition);
const unresolved = { resolve: () => ({ status: 'unmapped' as const }) };
const env: TranslateEnvironment = {
  identities: unresolved,
  groups: unresolved,
  policies: resolveRoutePolicies({}),
  route: {},
  routeIndex: {},
};
const s = (name: string, scope = 'repository') => ({ key: `${scope}/${name}`, scope, name });
const env1 = (name: string): Environments['environments'][number] => ({
  name,
  category: null,
  deploymentBranches: null,
});

function run(secrets: Secrets['secrets'], environments: string[] = []) {
  const all = translateAll(registry, {
    env,
    sources: { environments: { environments: environments.map(env1) }, secrets: { secrets } },
  });
  const t = all.translations.find((x) => x.facetKey === 'secrets');
  if (t === undefined) throw new Error('not translated');
  return t;
}

describe('secrets facet', () => {
  it('[FAC-VAR-001] secured variables become secrets that carry names only', () => {
    const t = run([s('API_TOKEN'), s('DB_PASSWORD', 'environment:prod')], ['prod']);
    expect(t.desired).toEqual({
      secrets: [s('DB_PASSWORD', 'environment:prod'), s('API_TOKEN')],
    });
    for (const secret of (t.desired as Secrets).secrets) {
      expect(Object.keys(secret).sort()).toEqual(['key', 'name', 'scope']);
    }
    expect(t.decisions).toEqual([]);
  });

  it('[FAC-SEC-001] a value in a source secret is rejected, never carried and never echoed', () => {
    const withValue = [{ ...s('API_TOKEN'), value: 'placeholder-not-a-secret' }];
    try {
      run(withValue as unknown as Secrets['secrets']);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(FacetEngineError);
      expect(String((e as Error).message)).not.toContain('placeholder-not-a-secret');
    }
  });

  it('[FAC-SEC-001] one post task per scope lists the names to set', () => {
    const t = run(
      [s('B'), s('A'), s('C', 'environment:prod'), s('D', 'environment:qa')],
      ['prod', 'qa'],
    );
    expect(t.postTasks).toEqual([
      expect.objectContaining({
        code: 'secrets.set-value',
        verifiable: true,
        params: { scope: 'environment:prod', names: ['C'], environment: 'prod' },
        paths: ['/secrets[key=environment:prod/C]'],
      }),
      expect.objectContaining({
        code: 'secrets.set-value',
        params: { scope: 'environment:qa', names: ['D'], environment: 'qa' },
      }),
      expect.objectContaining({
        code: 'secrets.set-value',
        params: { scope: 'repository', names: ['A', 'B'] },
      }),
    ]);
  });

  it('[FAC-SEC-001] no secrets means no task', () => {
    const t = run([]);
    expect([...t.postTasks, ...t.preTasks, ...t.blockers]).toEqual([]);
  });

  it('[FAC-SEC-001] the task params carry no value, only names and scope', () => {
    const t = run([s('API_TOKEN')]);
    expect(t.postTasks[0]?.params).toStrictEqual({ scope: 'repository', names: ['API_TOKEN'] });
  });

  it('[FAC-VAR-003] lowercase secret names are upper-cased as a translation', () => {
    const t = run([s('api_token')]);
    expect((t.desired as Secrets).secrets).toEqual([s('API_TOKEN')]);
    expect(t.decisions).toEqual([
      expect.objectContaining({
        path: '/secrets[key=repository/API_TOKEN]/name',
        fidelity: 'translated',
      }),
    ]);
    expect(t.preTasks).toEqual([]);
  });

  it('[FAC-VAR-003] an invalid or GITHUB_ secret name raises secrets.name-invalid', () => {
    const t = run([s('GITHUB_X'), s('has-dash'), s('GOOD')]);
    expect((t.desired as Secrets).secrets.map((x) => x.name)).toEqual(['GOOD']);
    expect(t.preTasks).toEqual([
      expect.objectContaining({
        code: 'secrets.name-invalid',
        params: { names: ['GITHUB_X', 'has-dash'] },
      }),
    ]);
  });

  it('[FAC-VAR-003] secrets that collide after upper-casing are all rejected', () => {
    const t = run([s('Token'), s('TOKEN')]);
    expect((t.desired as Secrets).secrets).toEqual([]);
    expect(t.preTasks[0]).toMatchObject({ code: 'secrets.name-invalid' });
    expect(t.postTasks).toEqual([]);
  });

  it('[FAC-SEC-001] an environment secret takes the casing of the target environment', () => {
    const t = run([s('X', 'environment:Prod')], ['prod']);
    expect((t.desired as Secrets).secrets).toEqual([s('X', 'environment:prod')]);
    expect(t.postTasks[0]?.params).toEqual({
      scope: 'environment:prod',
      names: ['X'],
      environment: 'prod',
    });
  });

  describe('compare and isTaskSatisfied', () => {
    const doc = (...secrets: Secrets['secrets']): Secrets => ({ secrets });
    const cmp = (desired: Secrets, actual: Secrets | null) =>
      compareFacet(registry, 'secrets', desired, actual);

    it('[FAC-SEC-001] parity compares names, in any order', () => {
      expect(cmp(doc(s('A'), s('B')), doc(s('B'), s('A')))?.status).toBe('equal');
    });

    it('[FAC-SEC-001] a missing secret is a difference; the case of the environment is not', () => {
      expect(cmp(doc(s('A'), s('B')), doc(s('A')))?.status).toBe('different');
      expect(cmp(doc(s('A', 'environment:Prod')), doc(s('A', 'environment:prod')))?.status).toBe(
        'equal',
      );
    });

    it('[LIF-060] an unreadable target is unverifiable', () => {
      expect(cmp(doc(), null)?.status).toBe('unverifiable');
    });

    const task = (names: string[], scope = 'repository') => ({
      code: 'secrets.set-value',
      params: { scope, names },
    });
    const satisfied = (t: ReturnType<typeof task>, target: Secrets) =>
      satisfiedTasks(registry, 'secrets', [t], target, []).length === 1;

    it('[FAC-SEC-001] the task is satisfied once every listed name exists in the scope', () => {
      expect(satisfied(task(['A', 'B']), doc(s('A'), s('B'), s('C')))).toBe(true);
      expect(satisfied(task(['A', 'B']), doc(s('A')))).toBe(false);
      expect(satisfied(task(['A']), doc(s('A', 'environment:prod')))).toBe(false);
      expect(satisfied(task(['A'], 'environment:Prod'), doc(s('A', 'environment:prod')))).toBe(
        true,
      );
    });

    it('[FAC-SEC-001] malformed task params are never satisfied', () => {
      const bad = [
        { code: 'secrets.set-value', params: {} },
        { code: 'secrets.set-value', params: { scope: 'repository', names: [] } },
        { code: 'secrets.set-value', params: { scope: 'repository', names: [1] } },
        { code: 'secrets.set-value', params: { scope: 3, names: ['A'] } },
      ];
      for (const t of bad) {
        expect(satisfiedTasks(registry, 'secrets', [t], doc(s('A')), [])).toEqual([]);
      }
    });
  });

  it('[FAC-005] declares its finding codes and no policy key', () => {
    expect(secretsDefinition.policyKeys).toEqual([]);
    expect(secretsDefinition.findingCodes).toEqual({
      'secrets.name-invalid': { kind: 'pre' },
      'secrets.set-value': { kind: 'post', completion: 'parity' },
    });
    expect(secretsDefinition.dependsOn).toEqual(['environments']);
  });
});
