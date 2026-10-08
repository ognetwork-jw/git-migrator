import {
  gitRefsDefinition,
  mergeSettingsDefinition,
  repositorySettingsDefinition,
} from '@git-migrator/facets';
import { assertGuidanceCoverage } from '@git-migrator/guidance';
import { describe, expect, it } from 'vitest';

describe('guidance coverage of the git-refs, repository-settings and merge-settings facets', () => {
  it('[FAC-002] every declared finding code has guidance', () => {
    const codes = [
      gitRefsDefinition,
      repositorySettingsDefinition,
      mergeSettingsDefinition,
    ].flatMap((d) => Object.keys(d.findingCodes));
    expect(codes.length).toBeGreaterThan(0);
    expect(() => assertGuidanceCoverage(codes)).not.toThrow();
  });
});
