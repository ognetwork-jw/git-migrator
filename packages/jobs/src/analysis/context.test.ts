import { describe, expect, it } from 'vitest';
import {
  collectPrincipals,
  deployKeysOf,
  deployKeyUsage,
  groupResolver,
  identityResolver,
  namesOf,
  splitReadWarnings,
  withoutFrameworkCreated,
} from './context.ts';
import { needsReanalysis, readinessWorsened } from './fresh.ts';

const row = (status: string, source: string, target: string | null) => ({
  status,
  sourceProviderId: source,
  targetProviderId: target,
});

describe('principal resolution (FAC-006)', () => {
  it('[FAC-006] identities resolve by mapping status', () => {
    const r = identityResolver([
      row('confirmed', 'a', '10'),
      row('suggested', 'b', '11'),
      row('excluded', 'c', null),
      row('pending_invite', 'd', null),
      row('confirmed', 'e', null),
    ]);
    const at = (id: string) => r.resolve({ kind: 'identity', id });
    expect(at('a')).toEqual({ status: 'mapped', principal: { kind: 'identity', id: '10' } });
    expect(at('b')).toEqual({ status: 'unmapped' });
    expect(at('c')).toEqual({ status: 'excluded' });
    expect(at('d')).toEqual({ status: 'pending_invite' });
    expect(at('e')).toEqual({ status: 'unmapped' });
    expect(at('unknown')).toEqual({ status: 'unmapped' });
  });

  it('[FAC-ACL-004] groups: a created team maps, a suggested one needs an operator, none is team_missing, ids fold case', () => {
    const r = groupResolver([
      row('confirmed', 'Dev', '77'),
      row('suggested', 'ops', '78'),
      row('unmapped', 'qa', null),
      row('excluded', 'old', null),
    ]);
    const at = (id: string) => r.resolve({ kind: 'group', id });
    expect(at('dev')).toEqual({ status: 'mapped', principal: { kind: 'group', id: '77' } });
    expect(at('ops')).toEqual({ status: 'unmapped' });
    expect(at('qa')).toEqual({ status: 'team_missing' });
    expect(at('old')).toEqual({ status: 'excluded' });
    expect(at('none')).toEqual({ status: 'team_missing' });
  });

  it('[FAC-006] finds every principal reference at any depth', () => {
    const found = collectPrincipals({
      grants: [{ principal: { kind: 'identity', id: 'x' }, role: 'read' }],
      rules: [{ restrictPushes: [{ principal: { kind: 'group', id: 'g' } }] }],
      noise: { kind: 'other', id: 'y' },
    });
    expect([...found.keys()].sort()).toEqual(['group:g', 'identity:x']);
  });
});

describe('deploy key usage (FAC-DKY-003)', () => {
  it('[FAC-DKY-003] counts each key once per repository, the repository being analyzed included', () => {
    const usage = deployKeyUsage(
      new Map([
        ['r1', ['k1', 'k1', 'k2']],
        ['r2', ['k2']],
      ]),
      ['k2', 'k3'],
    );
    expect(usage).toEqual({ k1: 1, k2: 3, k3: 1 });
  });

  it('[FAC-DKY-003] reads keys defensively', () => {
    expect(deployKeysOf({ keys: [{ publicKey: 'a' }, { publicKey: 3 }, null] })).toEqual(['a']);
    expect(deployKeysOf(null)).toEqual([]);
  });
});

describe('LIF-045 source-side filtering', () => {
  const doc = {
    rules: [
      { pattern: '*', restrictPushes: [{ principal: { kind: 'identity', id: '1' } }] },
      { pattern: 'main', restrictPushes: [{ principal: { kind: 'identity', id: '2' } }] },
    ],
    description: 'x',
  };

  it('[LIF-045] removes a created collection element and leaves the rest', () => {
    const out = withoutFrameworkCreated(doc, ['/rules[pattern=\\*]']) as typeof doc;
    expect(out.rules.map((r) => r.pattern)).toEqual(['main']);
    expect(doc.rules).toHaveLength(2);
  });

  it('[LIF-045] removes a keyed element beneath a keyed element and a plain field', () => {
    const out = withoutFrameworkCreated(doc, [
      '/rules[pattern=main]/restrictPushes[principal=identity:2]',
      '/description',
    ]) as { rules: { restrictPushes: unknown[] }[]; description?: string };
    expect(out.rules[1]?.restrictPushes).toEqual([]);
    expect(out.description).toBeUndefined();
  });

  it('[LIF-045] a field of an element takes the unset value null, so the document stays valid (LIF-070)', () => {
    const out = withoutFrameworkCreated(doc, ['/rules[pattern=\\*]/restrictPushes']) as {
      rules: { pattern: string; restrictPushes: unknown }[];
    };
    expect(out.rules.map((r) => [r.pattern, r.restrictPushes === null])).toEqual([
      ['*', true],
      ['main', false],
    ]);
  });

  it('[LIF-045] ignores a malformed path or one that addresses nothing', () => {
    expect(withoutFrameworkCreated(doc, ['not a path', '/nothing[x=1]'])).toEqual(doc);
  });
});

describe('read warnings and names', () => {
  const def = {
    key: 'webhooks',
    findingCodes: { 'webhooks.duplicate-url': { kind: 'warning' as const } },
  };
  it('[JOB-020] only declared warning codes of the Facet become findings', () => {
    const w = (code: string) => ({ code, paths: ['/a'], params: { n: 1 } });
    const out = splitReadWarnings(def, [
      w('webhooks.duplicate-url'),
      w('webhooks.invalid-url'),
      w('other.duplicate-url'),
    ]);
    expect(out.findings.map((f) => f.code)).toEqual(['webhooks.duplicate-url']);
    expect(out.diagnostics.map((d) => d.code)).toEqual([
      'webhooks.invalid-url',
      'other.duplicate-url',
    ]);
  });

  it('[FAC-PIP-002] names come from a list-shaped document', () => {
    expect(namesOf({ variables: [{ name: 'A' }, { name: 'B' }, { other: 1 }] })).toEqual([
      'A',
      'B',
    ]);
    expect(namesOf('x')).toEqual([]);
  });
});

describe('freshness (LIF-021, LIF-022)', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const hour = 3_600_000;
  it('[LIF-021] no Analysis, a stale one and one older than the limit need a new one', () => {
    const within = 24 * hour;
    expect(needsReanalysis({ analyzedAt: null, staleAt: null }, now, within)).toBe(true);
    const recent = new Date(now.getTime() - hour);
    const later = new Date(now.getTime() + hour);
    expect(needsReanalysis({ analyzedAt: recent, staleAt: later }, now, within)).toBe(false);
    expect(needsReanalysis({ analyzedAt: recent, staleAt: now }, now, within)).toBe(true);
    const old = new Date(now.getTime() - 25 * hour);
    expect(needsReanalysis({ analyzedAt: old, staleAt: null }, now, within)).toBe(true);
  });

  it('[LIF-022] readiness is worse only when it allows less than before', () => {
    expect(readinessWorsened('ready', 'needs_attention')).toBe(true);
    expect(readinessWorsened('needs_attention', 'blocked')).toBe(true);
    expect(readinessWorsened('blocked', 'ready')).toBe(false);
    expect(readinessWorsened('ready', 'ready')).toBe(false);
    expect(readinessWorsened(null, 'blocked')).toBe(false);
    expect(readinessWorsened('ready', null)).toBe(true);
  });
});
