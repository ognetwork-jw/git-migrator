import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/** Every non-test source file of the package, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('[GLO-002] the lifecycle names no provider files', () => {
  it('[GLO-002] no source file of the jobs package names a provider pipeline file or workflow path', () => {
    // The pipelines delivery names its source file (`PipelinesDelivery.sourcePath`, registered by
    // the adapter): the lifecycle only picks that file out of the source read (T-097).
    const banned = /[a-z]+-pipelines\.ya?ml|\.github\/workflows/i;
    const files = sources(here);
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(banned);
    }
  });
});
