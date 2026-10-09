import { describe, expect, it } from 'vitest';
import { diff, migration, run } from './fixtures.ts';
import { decisionsOf, entriesOf, jsonEqual, markEntry, scalarText } from './json-diff.ts';
import { availableActions, forceAdoptKind, hasActiveRun, targetFullName } from './rules.ts';

const names = (m: ReturnType<typeof migration>, runs = [run(1)]) =>
  availableActions(m, runs).map((a) => a.action);

describe('[UI-022] which actions the header offers', () => {
  it('[UI-022] a ready, analyzed repository offers Migrate and not Run anyway, and always Analyze and Mark complete', () => {
    expect(names(migration(), [])).toEqual(['analyze', 'migrate', 'mark_complete']);
  });

  it('[UI-022] a repository that needs attention offers Run anyway, not Migrate', () => {
    expect(names(migration({ readiness: 'needs_attention' }), [])).toEqual([
      'analyze',
      'run_anyway',
      'mark_complete',
    ]);
  });

  it('[UI-022] a blocked repository offers neither, and a non-empty target offers force adopt', () => {
    expect(names(migration({ readiness: 'blocked' }), [])).toEqual(['analyze', 'mark_complete']);
    expect(
      names(migration({ readiness: 'blocked', blockerCodes: ['target.exists-nonempty'] }), []),
    ).toEqual(['analyze', 'force_adopt', 'mark_complete']);
  });

  it('[UI-022] a migrated repository offers Resync, Verify, Rollback, source read-only and Mark complete', () => {
    const m = migration({
      status: 'migrated',
      targetRepository: { id: 't1', fullPath: 'acme-org/plat-api' },
    });
    expect(names(m)).toEqual([
      'analyze',
      'resync',
      'verify',
      'rollback',
      'source_read_only',
      'mark_complete',
    ]);
  });

  it('[UI-022] the source read-only action flips to its undo once it is applied', () => {
    const m = migration({
      status: 'verified',
      sourceReadOnlyApplied: true,
      targetRepository: { id: 't1', fullPath: 'acme-org/plat-api' },
    });
    expect(names(m)).toContain('undo_source_read_only');
    expect(names(m)).not.toContain('source_read_only');
  });

  it('[UI-022] a manually completed repository offers Revoke instead of Mark complete', () => {
    const m = migration({
      status: 'manually_completed',
      targetRepository: { id: 't1', fullPath: 'acme-org/plat-api' },
    });
    expect(names(m)).toContain('revoke_complete');
    expect(names(m)).not.toContain('mark_complete');
  });

  it('[LIF-077] rollback is not offered for rolled back, discovered, running or source-missing repositories', () => {
    for (const status of ['rolled_back', 'discovered', 'running', 'source_missing']) {
      const m = migration({
        status,
        targetRepository: { id: 't1', fullPath: 'acme-org/plat-api' },
      });
      expect(names(m), status).not.toContain('rollback');
    }
  });

  it('[LIF-077] rollback needs a target or Mutations to undo', () => {
    expect(names(migration({ status: 'failed' }), [run(1, { hasMutations: false })])).not.toContain(
      'rollback',
    );
    expect(names(migration({ status: 'failed' }), [run(1, { hasMutations: true })])).toContain(
      'rollback',
    );
  });

  it('[DOM-010] every action waits while a Run is queued or running', () => {
    const states = availableActions(migration({ status: 'running' }), [
      run(1, { status: 'running', finishedAt: null }),
    ]);
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((s) => s.disabled !== undefined)).toBe(true);
    expect(hasActiveRun([run(1, { status: 'queued' })])).toBe(true);
    expect(hasActiveRun([run(1)])).toBe(false);
  });

  it('[UI-022] a source-missing repository can only be analyzed', () => {
    expect(names(migration({ status: 'source_missing' }), [])).toEqual(['analyze']);
  });

  it('[UI-026] an endpoint-scope Migration offers Analyze only', () => {
    expect(names(migration({ scope: 'endpoint' }), [])).toEqual(['analyze']);
  });
});

describe('[LIF-043] the target name and the force-adopt kind', () => {
  it('[LIF-043] the target full name is the target repository, else the Route namespace and planned name', () => {
    expect(targetFullName(migration())).toBe('acme-org/plat-api');
    expect(
      targetFullName(migration({ targetRepository: { id: 't', fullPath: 'acme-org/other' } })),
    ).toBe('acme-org/other');
    expect(targetFullName(migration({ plannedTargetName: null }))).toBeNull();
  });

  it('[LIF-043] force adopt migrates when no pre task is open and runs anyway when one is', () => {
    expect(forceAdoptKind(migration())).toBe('migrate');
    expect(forceAdoptKind(migration({ readinessCounts: { preTasks: 2 } }))).toBe('run_anyway');
  });
});

describe('[UI-022] the JSON tree comparison', () => {
  it('[UI-022] compares values structurally regardless of key order', () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonEqual([1], [1, 2])).toBe(false);
  });

  it('[UI-022] marks an entry changed, only here, or the same', () => {
    expect(markEntry(1, { a: 2 }, 'a', true)).toBe('changed');
    expect(markEntry(1, { a: 1 }, 'a', true)).toBe('same');
    expect(markEntry(1, { b: 1 }, 'a', true)).toBe('only_here');
    expect(markEntry(1, [0, 1], 1, true)).toBe('same');
    expect(markEntry(1, [0], 1, true)).toBe('only_here');
    expect(markEntry(1, undefined, 'a', false)).toBe('same');
  });

  it('[UI-022] lists object entries sorted and array entries by index, and prints scalars', () => {
    expect(entriesOf({ b: 1, a: 2 })).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
    expect(entriesOf(['x'])).toEqual([[0, 'x']]);
    expect(entriesOf('s')).toEqual([]);
    expect(scalarText('s')).toBe('"s"');
    expect(scalarText(null)).toBe('null');
    expect(scalarText(3)).toBe('3');
  });

  it('[UI-022] keeps only well-formed fidelity decisions', () => {
    expect(
      decisionsOf([
        { path: '/a', fidelity: 'lossy', accepted: 'policy', policyKey: 'k' },
        { path: '/b' },
        'junk',
        { path: '/c', fidelity: 'exact' },
      ]),
    ).toEqual([
      { path: '/a', fidelity: 'lossy', accepted: 'policy', policyKey: 'k' },
      { path: '/c', fidelity: 'exact', accepted: false },
    ]);
    expect(decisionsOf(null)).toEqual([]);
    expect(diff().facets).toHaveLength(1);
  });
});
