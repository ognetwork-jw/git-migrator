import {
  membersDefinition,
  orgSecretsDefinition,
  orgVariablesDefinition,
  orgWebhooksDefinition,
  teamsDefinition,
} from '@git-migrator/facets';
import { assertGuidanceCoverage, findingSpec } from '@git-migrator/guidance';
import { describe, expect, it } from 'vitest';

// `facets` may not depend on `guidance` (ARC-012), so the FAC-002 check lives in this package,
// which may depend on anything (ADR-0103).
const DEFINITIONS = [
  membersDefinition,
  teamsDefinition,
  orgVariablesDefinition,
  orgSecretsDefinition,
  orgWebhooksDefinition,
];

describe('members, teams and org-* guidance coverage', () => {
  for (const def of DEFINITIONS) {
    it(`[FAC-002] every finding code of ${def.key} has guidance`, () => {
      expect(Object.keys(def.findingCodes).length).toBeGreaterThan(0);
      expect(() => assertGuidanceCoverage(Object.keys(def.findingCodes))).not.toThrow();
    });

    it(`[LIF-006] the kind and completion of each ${def.key} code match the guidance source list`, () => {
      for (const [code, spec] of Object.entries(def.findingCodes)) {
        const known = findingSpec(code);
        expect(known?.severity, code).toBe(spec.kind);
        expect(known?.verifiable, code).toBe(spec.completion === 'parity');
      }
    });

    it(`[FAC-002] every guidance code of ${def.key} in the source list is declared by the facet`, () => {
      const declared = new Set(Object.keys(def.findingCodes));
      for (const code of ['unmapped-principal', 'pending-invitation']) {
        const key = `${def.key}.${code}`;
        if (findingSpec(key) !== undefined) expect(declared.has(key), key).toBe(true);
      }
    });
  }

  it('[FAC-005] the policy keys are the ones the facets declare', () => {
    expect(orgVariablesDefinition.policyKeys).toEqual(['org-variables.uppercase-names']);
    expect(orgWebhooksDefinition.policyKeys).toEqual(['org-webhooks.event-dropped']);
    expect(membersDefinition.policyKeys).toEqual([]);
    expect(teamsDefinition.policyKeys).toEqual([]);
    expect(orgSecretsDefinition.policyKeys).toEqual([]);
  });
});
