import type { ProviderAdapter } from '@git-migrator/adapter-sdk';
import { type PairOverride, RegistryError } from '@git-migrator/core';
import { gitRefsDefinition, repositorySettingsDefinition } from '@git-migrator/facets';
import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from './builtin.ts';
import { ProviderRegistry } from './registry.ts';

const adapter = (type: string, facets: ProviderAdapter['capabilities']['facets']) =>
  ({ type, capabilities: { facets } }) as unknown as ProviderAdapter;

const A = adapter('a', { 'git-refs': { read: true, write: false, fields: {} } });
const B = adapter('b', {
  'git-refs': { read: true, write: true, fields: { '/defaultBranch': { kind: 'unsupported' } } },
});
const facets = [gitRefsDefinition, repositorySettingsDefinition] as never[];

const override: PairOverride<never> = {
  source: 'a',
  target: 'b',
  facet: 'git-refs',
  translate: () => {
    throw new Error('not called');
  },
};

describe('ProviderRegistry', () => {
  it('[ADP-032] composes facets, adapters and a pair override', () => {
    const reg = new ProviderRegistry({ facets, adapters: [B, A], overrides: [override] });
    expect(reg.adapterTypes()).toEqual(['a', 'b']);
    expect(reg.hasAdapter('a')).toBe(true);
    expect(reg.adapter('b')).toBe(B);
    expect(reg.override('a', 'b', 'git-refs')).toBe(override);
  });

  it('[ADP-032] the override is for one direction and one facet only', () => {
    const reg = new ProviderRegistry({ facets, adapters: [A, B], overrides: [override] });
    expect(reg.override('b', 'a', 'git-refs')).toBeUndefined();
    expect(reg.override('a', 'b', 'repository-settings')).toBeUndefined();
  });

  it('[ADP-032] rejects an override for an unknown adapter, an unknown facet or a duplicate', () => {
    expect(() => new ProviderRegistry({ facets, adapters: [A], overrides: [override] })).toThrow(
      /unregistered adapter b/,
    );
    expect(
      () =>
        new ProviderRegistry({
          facets,
          adapters: [A, B],
          overrides: [{ ...override, facet: 'pipelines' }],
        }),
    ).toThrow(RegistryError);
    expect(
      () => new ProviderRegistry({ facets, adapters: [A, B], overrides: [override, override] }),
    ).toThrow(/already registered/);
  });

  it('[LIF-047] a pipelines delivery is found by pair, and only for registered adapters', () => {
    const delivery = {
      source: 'a',
      target: 'b',
      sourcePath: 'ci.yml',
      render: () => ({ purpose: 'ci', title: 't', body: 'b', files: [] }),
    };
    const reg = new ProviderRegistry({ facets, adapters: [A, B], deliveries: [delivery] });
    expect(reg.pipelinesDelivery('a', 'b')).toBe(delivery);
    expect(reg.pipelinesDelivery('b', 'a')).toBeUndefined();
    expect(() => new ProviderRegistry({ facets, adapters: [A], deliveries: [delivery] })).toThrow(
      /unregistered adapter b/,
    );
    expect(
      () => new ProviderRegistry({ facets, adapters: [A, B], deliveries: [delivery, delivery] }),
    ).toThrow(/already registered/);
  });

  it('[LIF-047] the built-in registry delivers pipelines from Bitbucket Cloud to GitHub', () => {
    const delivery = createBuiltinRegistry().pipelinesDelivery('bitbucket-cloud', 'github');
    expect(
      delivery
        ?.render({
          text: 'pipelines:\n  default:\n    - step:\n        script:\n          - make\n',
        })
        .files.map((f) => f.path),
    ).toEqual(['.github/workflows/ci.yml', '.github/git-migrator/bitbucket-pipelines.yml']);
    // The lifecycle picks the source file the delivery names (GLO-002).
    expect(delivery?.sourcePath).toBe('bitbucket-pipelines.yml');
  });

  it('[ADP-032] rejects a duplicate adapter, capabilities for an unregistered facet and unknown lookups', () => {
    expect(() => new ProviderRegistry({ facets, adapters: [A, A] })).toThrow(/already registered/);
    expect(
      () =>
        new ProviderRegistry({
          facets,
          adapters: [adapter('c', { pipelines: { read: true, write: true, fields: {} } })],
        }),
    ).toThrow(/unregistered facet pipelines/);
    const reg = new ProviderRegistry({ facets, adapters: [A] });
    expect(reg.hasAdapter('zzz')).toBe(false);
    expect(() => reg.adapter('zzz')).toThrow(RegistryError);
  });

  it('[ADP-032] fails at composition when a facet dependency is missing', () => {
    const builtin = createBuiltinRegistry();
    const keys = builtin.facets.keys();
    expect(keys).toHaveLength(19);
    expect(
      () =>
        new ProviderRegistry({
          facets: [builtin.facets.get('branch-rules')] as never[],
          adapters: [],
        }),
    ).toThrow(/depends on unregistered facet/);
  });

  it('[API-020] the matrix has one row per facet and a cell per ordered pair of distinct adapters', () => {
    const reg = new ProviderRegistry({ facets, adapters: [A, B], overrides: [override] });
    const matrix = reg.capabilityMatrix();
    expect(matrix.adapters).toEqual(['a', 'b']);
    expect(matrix.rows.map((r) => r.facet)).toEqual(['git-refs', 'repository-settings']);
    const refs = matrix.rows[0]?.cells ?? [];
    expect(refs.map((c) => `${c.source}>${c.target}`)).toEqual(['a>b', 'b>a']);
    expect(refs[0]).toMatchObject({
      fidelity: 'unsupported',
      read: true,
      write: true,
      override: true,
    });
    expect(refs[1]).toMatchObject({
      fidelity: 'unsupported',
      read: true,
      write: false,
      override: false,
    });
    expect(
      matrix.rows[1]?.cells.every((c) => c.fidelity === 'unsupported' && c.fields.length === 0),
    ).toBe(true);
  });

  it('[ADP-032] rejects an override with the same source and target', () => {
    expect(
      () =>
        new ProviderRegistry({
          facets,
          adapters: [A, B],
          overrides: [{ ...override, target: 'a' }],
        }),
    ).toThrow(/same source and target/);
  });

  it('[ADP-032] rejects an override for a facet neither adapter declares', () => {
    expect(
      () =>
        new ProviderRegistry({
          facets,
          adapters: [A, B],
          overrides: [{ ...override, facet: 'repository-settings' }],
        }),
    ).toThrow(/neither a nor b declares/);
  });

  it('[ADP-032] fails at construction on a dependency cycle', () => {
    const cyclic = [
      { ...gitRefsDefinition, dependsOn: ['repository-settings'] },
      { ...repositorySettingsDefinition, dependsOn: ['git-refs'] },
    ] as never[];
    expect(() => new ProviderRegistry({ facets: cyclic, adapters: [] })).toThrow(/cycle/);
  });

  it('[ADP-032] exposes the facets read-only, so validation at construction cannot be bypassed', () => {
    const reg = new ProviderRegistry({ facets, adapters: [A] });
    expect('register' in reg.facets).toBe(false);
    expect('registerOverride' in reg.facets).toBe(false);
    expect(Object.isFrozen(reg.facets)).toBe(true);
    expect(reg.facets.keys()).toEqual(['git-refs', 'repository-settings']);
  });

  it('[API-020] the matrix uses capabilities as declared at construction and is a static ceiling', () => {
    const mutable = adapter('m', { 'git-refs': { read: true, write: true, fields: {} } });
    const reg = new ProviderRegistry({ facets, adapters: [mutable, A] });
    (mutable.capabilities.facets['git-refs'] as { fields: object }).fields = {
      '/x': { kind: 'unsupported' },
    };
    const matrix = reg.capabilityMatrix();
    expect(matrix.ceiling).toBe('static');
    expect(matrix.rows[0]?.cells.every((c) => c.fields.length === 0)).toBe(true);
    expect(reg.capabilities('m').facets['git-refs']?.fields).toEqual({});
  });

  it('[API-020] [ADP-032] what the registry returns cannot change its capabilities, matrix or facet order', () => {
    const reg = new ProviderRegistry({ facets, adapters: [A, B] });
    const before = reg.capabilityMatrix();
    const attempt = (fn: () => void) => {
      try {
        fn();
      } catch {
        // frozen: strict mode throws, which is the point
      }
    };
    const caps = reg.capabilities('b');
    attempt(() => {
      (caps.facets['git-refs']?.fields['/defaultBranch'] as { kind: string }).kind = 'supported';
    });
    attempt(() => {
      (caps.facets['git-refs'] as { write: boolean }).write = false;
    });
    const cells = reg.capabilityMatrix().rows[0]?.cells ?? [];
    for (const cell of cells) {
      for (const field of cell.fields) {
        attempt(() => {
          (field.source as { kind: string }).kind = 'unsupported';
        });
        attempt(() => {
          (field.target as { kind: string }).kind = 'unsupported';
        });
      }
    }
    const def = reg.facets.get('git-refs');
    const dependsOn = [...def.dependsOn];
    const policyKeys = [...def.policyKeys];
    attempt(() => {
      (def.dependsOn as string[]).push('repository-settings');
    });
    attempt(() => {
      (def.policyKeys as string[]).push('git-refs.x');
    });
    attempt(() => {
      (reg.facets.ordered()[0] as { dependsOn: unknown }).dependsOn = ['repository-settings'];
    });
    expect(reg.capabilityMatrix()).toEqual(before);
    expect(reg.capabilities('b').facets['git-refs']).toEqual(B.capabilities.facets['git-refs']);
    expect(reg.facets.get('git-refs').dependsOn).toEqual(dependsOn);
    expect(reg.facets.get('git-refs').policyKeys).toEqual(policyKeys);
    expect(gitRefsDefinition.dependsOn).toEqual(dependsOn);
    expect(reg.facets.ordered().map((d) => d.key)).toEqual(['git-refs', 'repository-settings']);
    // The caller's definitions are not frozen by registering them.
    expect(Object.isFrozen(gitRefsDefinition)).toBe(false);
  });

  it('[ADP-032] capabilities or limits that are not plain data fail as a RegistryError naming the adapter', () => {
    const odd = adapter('odd', {
      'git-refs': { read: true, write: true, fields: {}, note: () => 'x' } as never,
    });
    const error = (() => {
      try {
        new ProviderRegistry({ facets, adapters: [odd] });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(RegistryError);
    expect((error as Error).message).toMatch(/adapter odd/);
    expect(
      () =>
        new ProviderRegistry({
          facets,
          adapters: [A],
          limits: { a: { repositoryName: { check: () => true } } as never },
        }),
    ).toThrow(/limits of adapter a/);
  });
});
