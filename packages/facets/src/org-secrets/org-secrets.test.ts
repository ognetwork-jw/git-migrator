import type { OrgSecrets } from '@git-migrator/canonical';
import { compareFacet, FacetRegistry, satisfiedTasks, translateFacet } from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import { envOf } from '../endpoint-test-support.ts';
import { orgSecretsDefinition } from './index.ts';

const registry = new FacetRegistry().register(orgSecretsDefinition);
const secrets = (...names: string[]): OrgSecrets => ({ secrets: names.map((name) => ({ name })) });
const translate = (source: OrgSecrets) =>
  translateFacet(registry, 'org-secrets', source, { env: envOf() });
const namesOf = (t: { desired: unknown }) => (t.desired as OrgSecrets).secrets.map((s) => s.name);

describe('org-secrets facet', () => {
  it('[FAC-001] declares the endpoint scope, the name collection and no policy keys', () => {
    expect(orgSecretsDefinition.scope).toBe('endpoint');
    expect(orgSecretsDefinition.collections).toEqual([{ path: '/secrets', key: 'name' }]);
    expect(orgSecretsDefinition.policyKeys).toEqual([]);
  });

  it('[FAC-SEC-001] every secret raises one org-secrets.set-value task listing the names, with no value', () => {
    const t = translate(secrets('B_KEY', 'A_KEY'));
    expect(namesOf(t)).toEqual(['A_KEY', 'B_KEY']);
    expect(t.postTasks).toEqual([
      expect.objectContaining({
        code: 'org-secrets.set-value',
        paths: ['/secrets[name=A_KEY]', '/secrets[name=B_KEY]'],
        params: { names: ['A_KEY', 'B_KEY'] },
        verifiable: true,
      }),
    ]);
  });

  it('[FAC-SEC-001] no secrets means no task', () => {
    const t = translate(secrets());
    expect(t.postTasks).toEqual([]);
    expect(t.desired).toEqual({ secrets: [] });
  });

  it('[FAC-SEC-001] a secret that carries a value is rejected by the schema without echoing it', () => {
    const source = { secrets: [{ name: 'A', value: 'not-a-real-value-placeholder' }] };
    let message = '';
    try {
      translateFacet(registry, 'org-secrets', source, { env: envOf() });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('not-a-real-value-placeholder');
  });

  it('[FAC-VAR-003] a lower-case name is upper-cased as a translation, not a loss', () => {
    const t = translate(secrets('api_key', 'OK'));
    expect(namesOf(t)).toEqual(['API_KEY', 'OK']);
    expect(t.decisions).toEqual([
      { path: '/secrets[name=API_KEY]/name', fidelity: 'translated', accepted: false },
    ]);
    expect(t.preTasks).toEqual([]);
    expect(t.postTasks[0]?.params).toEqual({ names: ['API_KEY', 'OK'] });
  });

  it('[FAC-VAR-003] invalid and colliding names raise name-invalid and get no set-value entry', () => {
    const t = translate(secrets('GITHUB_X', 'key', 'KEY', 'bad-name', 'FINE'));
    expect(namesOf(t)).toEqual(['FINE']);
    expect(t.preTasks).toEqual([
      expect.objectContaining({
        code: 'org-secrets.name-invalid',
        params: { names: ['GITHUB_X', 'KEY', 'bad-name', 'key'] },
      }),
    ]);
    expect(t.postTasks[0]?.params).toEqual({ names: ['FINE'] });
  });

  describe('compare', () => {
    const cmp = (desired: OrgSecrets, actual: OrgSecrets | null) =>
      compareFacet(registry, 'org-secrets', desired, actual);

    it('[FAC-SEC-001] parity compares names, regardless of order', () => {
      expect(cmp(secrets('A', 'B'), secrets('B', 'A'))?.status).toBe('equal');
    });

    it('[FAC-SEC-001] a missing secret is reported by path', () => {
      const result = cmp(secrets('A', 'B'), secrets('A'));
      expect(result?.diffs.map((d) => d.path)).toEqual(['/secrets[name=B]/name']);
    });

    it('[AUTH-061] secrets that exist only on the target are not a difference', () => {
      expect(cmp(secrets('A'), secrets('A', 'LEGACY'))?.status).toBe('equal');
    });

    it('[LIF-060] an unreadable target is unverifiable', () => {
      expect(cmp(secrets(), null)?.status).toBe('unverifiable');
    });
  });

  describe('isTaskSatisfied', () => {
    const done = (params: unknown, target: OrgSecrets) =>
      satisfiedTasks(
        registry,
        'org-secrets',
        [{ code: 'org-secrets.set-value', params }],
        target,
        [],
      ).length === 1;

    it('[FAC-SEC-001] done once every listed name exists on the target, ignoring case', () => {
      expect(done({ names: ['A', 'B'] }, secrets('b', 'A', 'C'))).toBe(true);
      expect(done({ names: ['A', 'B'] }, secrets('A'))).toBe(false);
    });

    it('[FAC-SEC-001] malformed params are never satisfied', () => {
      expect(done({}, secrets('A'))).toBe(false);
      expect(done({ names: [] }, secrets('A'))).toBe(false);
      expect(done({ names: [1] }, secrets('A'))).toBe(false);
    });
  });
});
