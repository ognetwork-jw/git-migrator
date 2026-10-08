import {
  environmentsDefinition,
  secretsDefinition,
  variablesDefinition,
} from '@git-migrator/facets';
import { assertGuidanceCoverage, renderGuidance } from '@git-migrator/guidance';
import { describe, expect, it } from 'vitest';

describe('guidance coverage of the environments, variables and secrets facets', () => {
  it('[FAC-002] every declared finding code has guidance', () => {
    const codes = [environmentsDefinition, variablesDefinition, secretsDefinition].flatMap((d) =>
      Object.keys(d.findingCodes),
    );
    expect(codes.length).toBeGreaterThan(0);
    expect(() => assertGuidanceCoverage(codes)).not.toThrow();
  });

  it('[FAC-SEC-001] secrets.set-value renders a ready-to-run line per name from the task params', () => {
    const rendered = renderGuidance('secrets.set-value', {
      repository: 'acme/payments',
      scope: 'environment:prod',
      environment: 'prod',
      names: ['API_TOKEN', 'DB_PASSWORD'],
    });
    expect(rendered.steps.map((x) => x.copy).join('\n')).toBe(
      'gh secret set API_TOKEN --repo acme/payments --env prod\ngh secret set DB_PASSWORD --repo acme/payments --env prod',
    );
  });
});
