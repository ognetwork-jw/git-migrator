import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as core from './index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

describe('[ARC-012] @git-migrator/core stays pure', () => {
  it('[ARC-012] exports the documented API from the package entry', () => {
    expect(core.PACKAGE_NAME).toBe('@git-migrator/core');
    const fns = {
      parseFieldPath: core.parseFieldPath,
      formatFieldPath: core.formatFieldPath,
      parsePathPattern: core.parsePathPattern,
      matchesPattern: core.matchesPattern,
      normalizeDocument: core.normalizeDocument,
      canonicalize: core.canonicalize,
      hashCanonical: core.hashCanonical,
      sha256Hex: core.sha256Hex,
      transition: core.transition,
      deriveReadiness: core.deriveReadiness,
      applyLossyPolicies: core.applyLossyPolicies,
      resolveRoutePolicies: core.resolveRoutePolicies,
    };
    for (const [name, fn] of Object.entries(fns)) expect(typeof fn, name).toBe('function');
  });

  it('[ARC-012] imports nothing but its own files (no node:*, no packages, no internal packages)', () => {
    expect(sources.length).toBeGreaterThan(8);
    for (const file of sources) {
      const text = readFileSync(join(here, file), 'utf8');
      for (const m of text.matchAll(/^(?:import|export)\b[^'"]*?\bfrom\s+['"]([^'"]+)['"]/gm)) {
        expect(m[1], `${file} imports ${m[1]}`).toMatch(/^\.\/[a-z0-9-]+\.ts$/);
      }
    }
  });

  it('[GLO-002] uses no provider vocabulary', () => {
    const banned = /bitbucket|github|gitlab|\bworkspace\b|pull request|\bPR\b|merge request/i;
    for (const file of sources) {
      expect(readFileSync(join(here, file), 'utf8'), file).not.toMatch(banned);
    }
  });
});
