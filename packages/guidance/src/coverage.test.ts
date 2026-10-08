import { describe, expect, it } from 'vitest';
import { FINDING_CODES, FINDING_SPECS, PRINCIPAL_FACETS } from './codes.ts';
import { assertGuidanceCoverage, findMissingGuidance, GuidanceCoverageError } from './coverage.ts';
import { GUIDANCE } from './entries.ts';

describe('guidance coverage (FAC-002)', () => {
  it('[FAC-002] every finding code listed in the facets spec has guidance', () => {
    expect(() => assertGuidanceCoverage(FINDING_CODES)).not.toThrow();
    expect(findMissingGuidance(FINDING_CODES)).toEqual([]);
  });

  it('[FAC-002] a facet that emits a code without guidance fails the coverage check', () => {
    const emitted = ['git-refs.blob-large', 'git-refs.not-yet-written'];
    expect(() => assertGuidanceCoverage(emitted)).toThrow(GuidanceCoverageError);
    try {
      assertGuidanceCoverage(emitted);
    } catch (error) {
      expect(error).toBeInstanceOf(GuidanceCoverageError);
      expect((error as GuidanceCoverageError).missing).toEqual(['git-refs.not-yet-written']);
      expect((error as Error).message).toContain('git-refs.not-yet-written');
    }
  });

  it('[FAC-002] missing codes are reported once each, sorted', () => {
    expect(findMissingGuidance(['z.code', 'a.code', 'z.code', 'pipelines.disabled'])).toEqual([
      'a.code',
      'z.code',
    ]);
  });

  it('[FAC-002] an empty emitted set is covered', () => {
    expect(() => assertGuidanceCoverage([])).not.toThrow();
  });

  it('[FAC-002] the guidance record has exactly one entry per finding code, with no extras', () => {
    expect(Object.keys(GUIDANCE).sort()).toEqual([...FINDING_CODES].sort());
  });

  it('[FAC-002] each entry carries the severity and verifiable flag of the source list', () => {
    for (const spec of FINDING_SPECS) {
      const entry = GUIDANCE[spec.code];
      expect(entry.severity, spec.code).toBe(spec.severity);
      expect(entry.verifiable, spec.code).toBe(spec.verifiable);
      if (spec.verifiable) expect(entry.verification, spec.code).toBeDefined();
    }
  });

  it('[FAC-002] finding codes are unique', () => {
    expect(new Set(FINDING_CODES).size).toBe(FINDING_CODES.length);
  });

  it('[FAC-002] principal-bearing facets have the FAC-006 unmapped and pending codes', () => {
    for (const facet of PRINCIPAL_FACETS) {
      expect(FINDING_CODES).toContain(`${facet}.unmapped-principal`);
      expect(FINDING_CODES).toContain(`${facet}.pending-invitation`);
    }
  });
});
