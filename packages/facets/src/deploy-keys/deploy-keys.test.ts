import type { DeployKeys } from '@git-migrator/canonical';
import {
  compareFacet,
  FacetEngineError,
  FacetRegistry,
  resolveRoutePolicies,
  satisfiedTasks,
  type TranslateEnvironment,
  translateFacet,
} from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import { deployKeysDefinition } from './index.ts';

const registry = new FacetRegistry().register(deployKeysDefinition);
const unresolved = { resolve: () => ({ status: 'unmapped' as const }) };
const envWith = (routeIndex: Record<string, unknown> = {}): TranslateEnvironment => ({
  identities: unresolved,
  groups: unresolved,
  policies: resolveRoutePolicies({}),
  route: {},
  routeIndex,
});

const KEY_A = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAA';
const KEY_B = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB';
const translate = (doc: DeployKeys, routeIndex?: Record<string, unknown>) =>
  translateFacet(registry, 'deploy-keys', doc, { env: envWith(routeIndex) });

describe('deploy-keys translation (FAC-DKY-001, FAC-DKY-002)', () => {
  it('[FAC-DKY-001] flattened read-only keys pass through unchanged and need nothing', () => {
    const doc = {
      keys: [
        { publicKey: KEY_A, title: 'ci', readOnly: true },
        { publicKey: KEY_B, title: 'project key', readOnly: true },
      ],
    };
    const t = translate(doc);
    expect((t.desired as DeployKeys).keys).toHaveLength(2);
    expect(t.decisions).toEqual([]);
    expect(t.postTasks).toEqual([]);
    expect(t.blockers).toEqual([]);
  });

  it('[FAC-DKY-002] keys are always created read-only on the target', () => {
    const t = translate({ keys: [{ publicKey: KEY_A, title: 'ci', readOnly: false }] });
    expect((t.desired as DeployKeys).keys[0]?.readOnly).toBe(true);
    expect(t.decisions).toHaveLength(1);
    expect(t.decisions[0]).toMatchObject({
      path: `/keys[publicKey=${KEY_A}]/readOnly`,
      fidelity: 'translated',
    });
  });

  it('[FAC-DKY-002] an empty document is valid', () => {
    expect((translate({ keys: [] }).desired as DeployKeys).keys).toEqual([]);
  });
});

describe('deploy-keys pre-detection (FAC-DKY-003)', () => {
  const doc = {
    keys: [
      { publicKey: KEY_A, title: 'shared', readOnly: true },
      { publicKey: KEY_B, title: 'unique', readOnly: true },
    ],
  };

  it('[FAC-DKY-003] a key on more than one source repository gets the key-in-use post task', () => {
    const t = translate(doc, { deployKeyUsage: { [KEY_A]: 3, [KEY_B]: 1 } });
    expect(t.postTasks).toHaveLength(1);
    expect(t.postTasks[0]).toMatchObject({
      code: 'deploy-keys.key-in-use',
      verifiable: true,
      paths: [`/keys[publicKey=${KEY_A}]`],
      params: { keyName: 'shared', publicKey: KEY_A },
    });
    // the key stays in desired: the apply step tries it and records the same task if rejected
    expect((t.desired as DeployKeys).keys).toHaveLength(2);
  });

  it('[FAC-DKY-003] no usage data or a count of one raises nothing', () => {
    expect(translate(doc).postTasks).toEqual([]);
    expect(translate(doc, { deployKeyUsage: { [KEY_A]: 1 } }).postTasks).toEqual([]);
  });

  it('[FAC-DKY-003] a blank title falls back to a generic key name', () => {
    const t = translate(
      { keys: [{ publicKey: KEY_A, title: '  ', readOnly: true }] },
      { deployKeyUsage: { [KEY_A]: 2 } },
    );
    expect(t.postTasks[0]?.params.keyName).toBe('deploy-key');
  });

  it('[FAC-DKY-003] malformed usage data fails instead of hiding a duplicate', () => {
    expect(() => translate(doc, { deployKeyUsage: [1] })).toThrow(FacetEngineError);
    expect(() => translate(doc, { deployKeyUsage: { [KEY_A]: 'two' } })).toThrow(/deployKeyUsage/);
  });

  it('[FAC-DKY-003] a Map as usage data is rejected by the engine, not silently emptied', () => {
    expect(() => translate(doc, { deployKeyUsage: new Map([[KEY_A, 2]]) })).toThrow(
      FacetEngineError,
    );
  });
});

describe('deploy-keys task completion and compare (FAC-DKY-002)', () => {
  const task = {
    code: 'deploy-keys.key-in-use',
    params: { keyName: 'shared', publicKey: KEY_A },
  };

  it('[FAC-DKY-002] key-in-use is satisfied once the target has the same public key', () => {
    const sat = (t: DeployKeys) => satisfiedTasks(registry, 'deploy-keys', [task], t, []).length;
    expect(sat({ keys: [{ publicKey: KEY_A, title: 'x', readOnly: true }] })).toBe(1);
    expect(sat({ keys: [{ publicKey: KEY_B, title: 'x', readOnly: true }] })).toBe(0);
    expect(sat({ keys: [] })).toBe(0);
    expect(
      satisfiedTasks(
        registry,
        'deploy-keys',
        [{ code: 'deploy-keys.key-in-use', params: {} }],
        { keys: [] },
        [],
      ),
    ).toEqual([]);
  });

  it('[FAC-DKY-002] parity compares the key set, titles and read-only flag', () => {
    const desired = { keys: [{ publicKey: KEY_A, title: 'ci', readOnly: true }] };
    expect(compareFacet(registry, 'deploy-keys', desired, desired)?.status).toBe('equal');
    const missing = compareFacet(registry, 'deploy-keys', desired, { keys: [] });
    expect(missing?.status).toBe('different');
    const writable = compareFacet(registry, 'deploy-keys', desired, {
      keys: [{ publicKey: KEY_A, title: 'ci', readOnly: false }],
    });
    expect(writable?.diffs.map((d) => d.path)).toEqual([`/keys[publicKey=${KEY_A}]/readOnly`]);
    const extra = compareFacet(registry, 'deploy-keys', { keys: [] }, desired);
    expect(extra?.status).toBe('different');
  });
});
