import { branchRulesDefinition } from '@git-migrator/facets';
import { assertGuidanceCoverage, FINDING_SPECS } from '@git-migrator/guidance';
import { describe, expect, it } from 'vitest';

describe('branch-rules guidance coverage', () => {
  it('[FAC-002] every declared finding code has guidance', () => {
    expect(() =>
      assertGuidanceCoverage(Object.keys(branchRulesDefinition.findingCodes)),
    ).not.toThrow();
  });

  it('[FAC-002] the declared codes are exactly the facet codes of the guidance source list', () => {
    const specs = FINDING_SPECS.filter((s) => s.facet === 'branch-rules');
    expect(Object.keys(branchRulesDefinition.findingCodes).sort()).toEqual(
      specs.map((s) => s.code).sort(),
    );
    for (const s of specs) {
      const declared = branchRulesDefinition.findingCodes[s.code];
      expect(declared?.kind, s.code).toBe(s.severity);
      expect(declared?.completion === 'parity', s.code).toBe(s.verifiable);
    }
  });
});
