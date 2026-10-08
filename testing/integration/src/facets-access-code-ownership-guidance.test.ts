import {
  ACCESS_CONTROL_FINDING_CODES,
  accessControl,
  CODE_OWNERSHIP_FINDING_CODES,
  CODE_OWNERSHIP_POLICY_KEYS,
  codeOwnership,
} from '@git-migrator/facets';
import { assertGuidanceCoverage, findingSpec } from '@git-migrator/guidance';
import { describe, expect, it } from 'vitest';

// `facets` may not depend on `guidance` (ARC-012), so the FAC-002 check lives in this package,
// which may depend on anything. ADR-0107.
describe('access-control and code-ownership guidance coverage', () => {
  for (const def of [accessControl, codeOwnership]) {
    it(`[FAC-002] every finding code of ${def.key} has guidance`, () => {
      expect(() => assertGuidanceCoverage(Object.keys(def.findingCodes))).not.toThrow();
    });

    it(`[LIF-006] the kind and completion of each ${def.key} code match the guidance source list`, () => {
      for (const [code, spec] of Object.entries(def.findingCodes)) {
        const known = findingSpec(code);
        expect(known?.severity, code).toBe(spec.kind);
        expect(known?.verifiable, code).toBe(spec.completion === 'parity');
      }
    });
  }

  it('[FAC-005] the declared policy keys are the ones the spec names', () => {
    expect(codeOwnership.policyKeys).toEqual([...CODE_OWNERSHIP_POLICY_KEYS]);
    expect(Object.keys(ACCESS_CONTROL_FINDING_CODES)).toHaveLength(3);
    expect(Object.keys(CODE_OWNERSHIP_FINDING_CODES)).toHaveLength(6);
  });
});
