import type { OrgVariables } from '@git-migrator/canonical';
import { compareFacet, FacetRegistry, translateFacet } from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import { envOf } from '../endpoint-test-support.ts';
import { orgVariablesDefinition } from './index.ts';

const registry = new FacetRegistry().register(orgVariablesDefinition);
const variable = (name: string, value = 'v') => ({ name, value, visibility: 'all' as const });
const translate = (variables: OrgVariables['variables'], acceptLossy?: string[]) =>
  translateFacet(
    registry,
    'org-variables',
    { variables },
    {
      env: envOf({}, { policies: acceptLossy === undefined ? {} : { acceptLossy } }),
    },
  );
const desiredOf = (t: { desired: unknown }) => (t.desired as OrgVariables).variables;

describe('org-variables facet', () => {
  it('[FAC-001] declares the endpoint scope, the name collection and its policy key', () => {
    expect(orgVariablesDefinition.scope).toBe('endpoint');
    expect(orgVariablesDefinition.dependsOn).toEqual([]);
    expect(orgVariablesDefinition.collections).toEqual([{ path: '/variables', key: 'name' }]);
    expect(orgVariablesDefinition.policyKeys).toEqual(['org-variables.uppercase-names']);
  });

  it('[FAC-VAR-003] valid upper-case names are carried over with value and visibility all', () => {
    const t = translate([variable('API_URL', 'https://x'), variable('_PRIVATE', '1')]);
    expect(desiredOf(t)).toEqual([variable('API_URL', 'https://x'), variable('_PRIVATE', '1')]);
    expect(t.decisions).toEqual([]);
    expect(t.preTasks).toEqual([]);
  });

  it('[FAC-VAR-003] a lower-case name is upper-cased: lossy org-variables.uppercase-names', () => {
    const t = translate([variable('api_url'), variable('KEEP')]);
    expect(desiredOf(t).map((v) => v.name)).toEqual(['API_URL', 'KEEP']);
    expect(t.decisions).toEqual([
      {
        path: '/variables[name=API_URL]/name',
        fidelity: 'lossy',
        policyKey: 'org-variables.uppercase-names',
        accepted: false,
      },
    ]);
    expect(t.preTasks).toEqual([
      expect.objectContaining({
        code: 'org-variables.accept-lossy',
        params: {
          policyKey: 'org-variables.uppercase-names',
          paths: ['/variables[name=API_URL]/name'],
        },
      }),
    ]);
  });

  it('[FAC-005] an accepted policy key produces no task', () => {
    const t = translate([variable('api_url')], ['org-variables.uppercase-names']);
    expect(t.preTasks).toEqual([]);
    expect(t.expectedDifferences).toEqual([
      expect.objectContaining({ reason: 'lossy_accepted', note: 'org-variables.uppercase-names' }),
    ]);
  });

  it('[FAC-VAR-003] a name with a GITHUB_ prefix raises name-invalid and is omitted', () => {
    const t = translate([variable('GITHUB_TOKEN'), variable('github_x'), variable('OK')]);
    expect(desiredOf(t).map((v) => v.name)).toEqual(['OK']);
    expect(t.preTasks).toEqual([
      expect.objectContaining({
        code: 'org-variables.name-invalid',
        paths: ['/variables[name=GITHUB_TOKEN]', '/variables[name=github_x]'],
        params: { names: ['GITHUB_TOKEN', 'github_x'] },
      }),
    ]);
  });

  it('[FAC-VAR-003] names that are not identifiers raise name-invalid', () => {
    const t = translate([
      variable('1ST'),
      variable('has-dash'),
      variable('has space'),
      variable('OK'),
    ]);
    expect(desiredOf(t).map((v) => v.name)).toEqual(['OK']);
    expect(t.preTasks[0]?.params).toEqual({ names: ['1ST', 'has space', 'has-dash'] });
  });

  it('[FAC-VAR-003] names that collide after upper-casing are all rejected, none kept silently', () => {
    const t = translate([variable('token', 'a'), variable('TOKEN', 'b'), variable('OTHER')]);
    expect(desiredOf(t).map((v) => v.name)).toEqual(['OTHER']);
    expect(t.preTasks).toEqual([
      expect.objectContaining({
        code: 'org-variables.name-invalid',
        params: { names: ['TOKEN', 'token'] },
      }),
    ]);
    // Neither colliding value reaches the desired document.
    expect(JSON.stringify(t.desired)).not.toContain('"a"');
  });

  it('[FAC-VAR-003] a value is carried over byte for byte, including empty and multi-line text', () => {
    const t = translate([variable('A', ''), variable('B', 'line1\nline2 ')]);
    expect(desiredOf(t).map((v) => v.value)).toEqual(['', 'line1\nline2 ']);
  });

  describe('compare', () => {
    const cmp = (desired: OrgVariables['variables'], actual: OrgVariables['variables'] | null) =>
      compareFacet(
        registry,
        'org-variables',
        { variables: desired },
        actual === null ? null : { variables: actual },
      );

    it('[LIF-060] equal regardless of order', () => {
      expect(cmp([variable('A'), variable('B')], [variable('B'), variable('A')])?.status).toBe(
        'equal',
      );
    });

    it('[LIF-060] a missing variable and a different value are reported by path', () => {
      const result = cmp([variable('A', '1'), variable('B')], [variable('A', '2')]);
      expect(result?.status).toBe('different');
      expect(result?.diffs.map((d) => d.path)).toEqual([
        '/variables[name=A]/value',
        '/variables[name=B]/name',
        '/variables[name=B]/value',
        '/variables[name=B]/visibility',
      ]);
    });

    it('[AUTH-061] variables that exist only on the target are not a difference', () => {
      expect(cmp([variable('A')], [variable('A'), variable('LEGACY')])?.status).toBe('equal');
    });

    it('[LIF-060] an unreadable target is unverifiable', () => {
      expect(cmp([], null)?.status).toBe('unverifiable');
    });
  });

  it('[FAC-005] declares the accept task for its policy key', () => {
    expect(orgVariablesDefinition.findingCodes['org-variables.accept-lossy']).toEqual({
      kind: 'pre',
      completion: 'accept',
    });
  });
});
