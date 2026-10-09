import { describe, expect, it } from 'vitest';
import {
  deriveFrameworkMutationDifferences,
  isFilteredSourceMutation,
  isPossiblyApplied,
  isUndoable,
  type LedgerEntry,
  type LedgerRecord,
  mutationsToUndo,
  normalizeLedgerRecord,
} from './ledger.ts';

const rec = (over: Partial<LedgerRecord> = {}): LedgerRecord => ({
  facetKey: 'git-refs',
  action: 'create',
  resourceRef: { type: 'ref', name: 'refs/heads/git-migrator/pipelines' },
  paths: ['/refs[name=refs/heads/git-migrator/pipelines]'],
  before: null,
  after: { name: 'refs/heads/git-migrator/pipelines' },
  ...over,
});

describe('[LIF-045] adopted and no-op records', () => {
  it('[LIF-045] makes before equal to after for an adopted record the adapter sent unequal', () => {
    const r = normalizeLedgerRecord(
      rec({ resourceRef: { adopted: true }, before: { v: 1 }, after: { v: 2 } }),
    );
    expect(r.after).toEqual({ v: 1 });
  });

  it('[LIF-045] leaves a no-op record that already agrees, and an ordinary record, untouched', () => {
    const noop = rec({ resourceRef: { noop: true }, before: { v: 1 }, after: { v: 1 } });
    expect(normalizeLedgerRecord(noop)).toBe(noop);
    const normal = rec({ before: { v: 1 }, after: { v: 2 } });
    expect(normalizeLedgerRecord(normal)).toBe(normal);
  });

  it('[LIF-045] undo never reverts adopted, no-op or already undone records, and goes newest first', () => {
    const m = (
      name: string,
      resourceRef: Record<string, unknown>,
      undoneAt: Date | null = null,
    ) => ({ name, resourceRef, undoneAt });
    const recorded = [
      m('a', {}),
      m('b', { adopted: true }),
      m('c', { noop: true }),
      m('d', {}, new Date(0)),
      m('e', {}),
    ];
    expect(mutationsToUndo(recorded).map((x) => x.name)).toEqual(['e', 'a']);
    expect(isUndoable(m('x', { adopted: true }))).toBe(false);
  });

  it('[LIF-045] filters only active, undoable, source-side creations out of the source document', () => {
    const base = { side: 'source', action: 'create', resourceRef: {}, undoneAt: null };
    expect(isFilteredSourceMutation(base)).toBe(true);
    expect(isFilteredSourceMutation({ ...base, side: 'target' })).toBe(false);
    expect(isFilteredSourceMutation({ ...base, undoneAt: new Date(0) })).toBe(false);
    expect(isFilteredSourceMutation({ ...base, resourceRef: { adopted: true } })).toBe(false);
    expect(isFilteredSourceMutation({ ...base, action: 'update' })).toBe(false);
  });
});

describe('[LIF-045] Expected Difference derivation', () => {
  const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
    side: 'target',
    origin: 'framework',
    record: rec(),
    ...over,
  });

  it('[LIF-045] derives a framework_mutation difference per path for a target write outside the desired document', () => {
    expect(deriveFrameworkMutationDifferences([entry()])).toEqual([
      {
        facetKey: 'git-refs',
        path: '/refs[name=refs/heads/git-migrator/pipelines]',
        reason: 'framework_mutation',
        note: expect.any(String),
      },
    ]);
  });

  it('[LIF-045] derives nothing for writes in the desired document, source writes, deletions, adopted and no-op records', () => {
    expect(deriveFrameworkMutationDifferences([entry({ origin: 'desired' })])).toEqual([]);
    expect(deriveFrameworkMutationDifferences([entry({ side: 'source' })])).toEqual([]);
    expect(
      deriveFrameworkMutationDifferences([entry({ record: rec({ action: 'delete' }) })]),
    ).toEqual([]);
    expect(
      deriveFrameworkMutationDifferences([
        entry({ record: rec({ resourceRef: { adopted: true } }) }),
      ]),
    ).toEqual([]);
    expect(
      deriveFrameworkMutationDifferences([entry({ record: rec({ resourceRef: { noop: true } }) })]),
    ).toEqual([]);
  });

  it('[LIF-045] takes explicit paths for a repository-level record and deduplicates by facet and path', () => {
    const a = entry({
      record: rec({ facetKey: null }),
      differences: [{ facetKey: 'git-refs', path: '/refs[name=refs/heads/git-migrator/*]' }],
    });
    expect(deriveFrameworkMutationDifferences([a, a])).toHaveLength(1);
    expect(
      deriveFrameworkMutationDifferences([entry({ record: rec({ facetKey: null }) })]),
    ).toEqual([]);
  });
});

describe('[LIF-045] intents and ordering', () => {
  const m = (seq: number, state: string, extra: Record<string, unknown> = {}) => ({
    seq: BigInt(seq),
    state,
    resourceRef: extra,
    undoneAt: null,
  });

  it('[LIF-045] an unconfirmed intent is undone as possibly applied; a change known not to be applied is not', () => {
    const rows = [m(1, 'recorded'), m(2, 'intended'), m(3, 'not_applied')];
    const undo = mutationsToUndo(rows);
    expect(undo.map((x) => x.seq)).toEqual([2n, 1n]);
    expect(undo.filter(isPossiblyApplied).map((x) => x.seq)).toEqual([2n]);
  });

  it('[LIF-045] sorts by seq itself, whatever order the rows arrive in', () => {
    const rows = [m(3, 'recorded'), m(1, 'recorded'), m(10, 'recorded'), m(2, 'recorded')];
    expect(mutationsToUndo(rows).map((x) => x.seq)).toEqual([10n, 3n, 2n, 1n]);
  });
});
