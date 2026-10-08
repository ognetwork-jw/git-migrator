import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from './errors.ts';
import { resolveConfig } from './load.ts';

/** The DEP-040 YAML block, read from the spec as it is written. */
function dep040Example(): string {
  const spec = readFileSync(join(__dirname, '../../../docs/spec/13-deployment.md'), 'utf8');
  const section = spec.slice(spec.indexOf('## Runtime configuration file (DEP-040)'));
  return section.split('```yaml\n')[1]?.split('```')[0] ?? '';
}

function issuesOf(text: string): ConfigError['issues'] {
  try {
    resolveConfig({ text, env: {} });
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  return [];
}

describe('the DEP-040 example document (DEP-040)', () => {
  it('[DEP-040] as written it is rejected at the roleMappings placeholder, which is an ellipsis, not a value', () => {
    const issues = issuesOf(dep040Example());
    expect(issues).toEqual([expect.objectContaining({ path: 'auth.roleMappings[0]' })]);
  });

  it('[DEP-040] with that placeholder read as an empty list, the only failure is the empty Entra tenant of production', () => {
    const text = dep040Example().replace('roleMappings: [ ... ]', 'roleMappings: []');
    expect(text).not.toEqual(dep040Example());
    expect(issuesOf(text)).toEqual([
      { path: 'auth.entra.tenantId', message: 'is required when environment is production' },
    ]);
  });
});
