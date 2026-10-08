import type { FacetCapability, FieldSupport } from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import { computeCell, effectiveFieldSupport, fieldFidelity, worstFidelity } from './matrix.ts';

const S: FieldSupport = { kind: 'supported' };
const cap = (
  read: boolean,
  write: boolean,
  fields: FacetCapability['fields'] = {},
): FacetCapability => ({ read, write, fields });

describe('fieldFidelity', () => {
  it('[API-020] supported on both sides is exact', () => {
    expect(fieldFidelity(S, S)).toBe('exact');
  });

  it('[API-020] a constrained side is lossy', () => {
    const c: FieldSupport = { kind: 'constrained', constraint: 'max 6' };
    expect(fieldFidelity(S, c)).toBe('lossy');
    expect(fieldFidelity(c, S)).toBe('lossy');
  });

  it('[API-020] an unsupported side is unsupported, even beside an unreadable source', () => {
    const u: FieldSupport = { kind: 'unsupported' };
    expect(fieldFidelity(S, u)).toBe('unsupported');
    expect(fieldFidelity({ kind: 'unreadable' }, u)).toBe('unsupported');
    expect(fieldFidelity(u, S)).toBe('unsupported');
  });

  it('[API-020] an unreadable source is unreadable; an unreadable target is only write-only', () => {
    expect(fieldFidelity({ kind: 'unreadable' }, S)).toBe('unreadable');
    expect(fieldFidelity(S, { kind: 'unreadable' })).toBe('exact');
  });

  it('[API-020] a read-only target cannot hold the value, a read-only source is fine', () => {
    expect(fieldFidelity(S, { kind: 'readOnly' })).toBe('unsupported');
    expect(fieldFidelity({ kind: 'readOnly' }, S)).toBe('exact');
  });
});

describe('worstFidelity', () => {
  it('[API-020] orders exact < translated < lossy < unreadable < unsupported', () => {
    expect(worstFidelity([])).toBe('exact');
    expect(worstFidelity(['exact', 'lossy'])).toBe('lossy');
    expect(worstFidelity(['lossy', 'unreadable', 'translated'])).toBe('unreadable');
    expect(worstFidelity(['unreadable', 'unsupported', 'exact'])).toBe('unsupported');
  });
});

describe('computeCell', () => {
  const src = (caps: FacetCapability | undefined) => ({ type: 'a', caps });
  const tgt = (caps: FacetCapability | undefined) => ({ type: 'b', caps });

  it('[API-020] a Facet either side does not declare is unsupported with no fields', () => {
    const cell = computeCell(src(undefined), tgt(cap(true, true)), false);
    expect(cell).toMatchObject({ fidelity: 'unsupported', read: false, write: true, fields: [] });
    expect(computeCell(src(cap(true, false)), tgt(undefined), false).fidelity).toBe('unsupported');
  });

  it('[API-020] a source that cannot read the Facet is at best unreadable', () => {
    expect(computeCell(src(cap(false, false)), tgt(cap(true, true)), false).fidelity).toBe(
      'unreadable',
    );
  });

  it('[API-020] takes the worst field, lists fields sorted, and defaults an undeclared side to supported', () => {
    const cell = computeCell(
      src(cap(true, false, { '/z': S, '/m': { kind: 'unreadable' } })),
      tgt(cap(true, true, { '/a': { kind: 'constrained', constraint: 'x' }, '/m': S })),
      true,
    );
    expect(cell.fields.map((f) => [f.path, f.fidelity])).toEqual([
      ['/a', 'lossy'],
      ['/m', 'unreadable'],
      ['/z', 'exact'],
    ]);
    expect(cell.fidelity).toBe('unreadable');
    expect(cell).toMatchObject({ read: true, write: true, override: true });
  });
});

describe('effectiveFieldSupport', () => {
  it('[ADP-014] read-time facts that are worse replace static entries without mutating either input', () => {
    const staticFields = { '/forking': S, '/x': S } as const;
    const dynamic = { '/forking': { kind: 'unsupported', note: 'org forbids' } } as const;
    const merged = effectiveFieldSupport(staticFields, dynamic);
    expect(merged['/forking']).toEqual({ kind: 'unsupported', note: 'org forbids' });
    expect(merged['/x']).toEqual(S);
    expect(staticFields['/forking']).toEqual(S);
    expect(effectiveFieldSupport(staticFields)).toEqual(staticFields);
  });

  it('[ADP-014] a read cannot lift a static limit, only add one or a new path', () => {
    const limit: FieldSupport = { kind: 'constrained', constraint: 'max 6' };
    const merged = effectiveFieldSupport(
      { '/a': { kind: 'unsupported' }, '/b': limit },
      { '/a': S, '/b': S, '/c': { kind: 'unreadable' } },
    );
    expect(merged['/a']).toEqual({ kind: 'unsupported' });
    expect(merged['/b']).toEqual(limit);
    expect(merged['/c']).toEqual({ kind: 'unreadable' });
  });
});
