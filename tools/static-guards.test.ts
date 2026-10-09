import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.next', 'dist', 'coverage', '.turbo', '__fixtures__']);

function sourceFiles(dir: string, accept: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) out.push(...sourceFiles(rel, accept));
    } else if (accept(entry.name)) out.push(rel);
  }
  return out;
}

const isSource = (name: string) => /\.(?:ts|tsx|mts|mjs|js)$/.test(name);
const isTest = (name: string) => /\.(?:test|spec)\.(?:ts|tsx)$/.test(name);
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

describe('static guards on the web tier', () => {
  it('[API-002] apps/web has no server actions: no "use server" directive', () => {
    const files = sourceFiles('apps/web', isSource);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((f) => /^\s*['"]use server['"]/m.test(read(f)));
    expect(offenders).toEqual([]);
  });

  const webTier = [
    ...sourceFiles('packages/api/src', (n) => isSource(n) && !isTest(n)),
    ...sourceFiles('apps/web/src', (n) => isSource(n) && !isTest(n)),
    ...sourceFiles('apps/web/app', (n) => isSource(n) && !isTest(n)),
  ];

  it('[ARC-021] packages/api and apps/web never reach a provider: no adapter, SDK or git imports, no ProviderHttpClient', () => {
    expect(webTier.length).toBeGreaterThan(50);
    const forbiddenImport =
      /from\s+['"](?:@git-migrator\/(?:adapter-sdk|git)(?:\/[^'"]*)?|@git-migrator\/adapters?[^'"]*|[^'"]*\/adapters\/[^'"]*)['"]/;
    const offenders = webTier
      .filter((f) => forbiddenImport.test(read(f)) || /\bProviderHttpClient\b/.test(read(f)))
      .map((f) => relative('.', f));
    expect(offenders).toEqual([]);
  });

  it('[ARC-022] packages/api and apps/web never open a provider connection: no adapter connect calls', () => {
    const offenders = webTier.filter((f) => /\.connect\(|\bconnectAdapter\(/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('[ARC-021] the guard would catch a violation', () => {
    expect(/^\s*['"]use server['"]/m.test("'use server';\nexport async function f() {}")).toBe(
      true,
    );
    expect(/\.connect\(|\bconnectAdapter\(/.test('await adapter.connect(creds)')).toBe(true);
  });
});
