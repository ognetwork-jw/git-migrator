import { deployKeysDefinition, webhooksDefinition } from '@git-migrator/facets';
import { assertGuidanceCoverage } from '@git-migrator/guidance';
import { describe, expect, it } from 'vitest';

describe('guidance coverage of the webhooks and deploy-keys facets', () => {
  it('[FAC-002] every declared finding code has guidance', () => {
    const codes = [webhooksDefinition, deployKeysDefinition].flatMap((d) =>
      Object.keys(d.findingCodes),
    );
    expect(codes).toContain('webhooks.duplicate-url');
    expect(codes).toContain('deploy-keys.key-in-use');
    expect(() => assertGuidanceCoverage(codes)).not.toThrow();
  });
});
