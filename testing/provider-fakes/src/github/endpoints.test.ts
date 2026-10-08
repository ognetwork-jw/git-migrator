import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createFakeGitHub } from './app.ts';
import { specPaths } from './spec-validation.ts';

const normalize = (path: string): string =>
  path
    .replace(/\{base\}\.\.\.\{head\}/g, '*')
    .replace(/:[A-Za-z_]+(\{[^}]*\})?/g, '*')
    .replace(/\{[^}]+\}/g, '*');

/** Walks up from this file to the repository root that holds the provider doc. */
function providerDoc(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'docs', 'providers', 'github.md');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('docs/providers/github.md not found');
    dir = parent;
  }
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function registered(): Set<string> {
  const { app } = createFakeGitHub();
  return new Set(app.routes.map((r) => `${r.method} ${normalize(r.path)}`));
}

describe('endpoint coverage', () => {
  it('[TST-011] every operation of the saved OpenAPI description is implemented', async () => {
    const spec = JSON.parse(
      readFileSync(new URL('../../specs/github.openapi.json', import.meta.url), 'utf8'),
    ) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const have = registered();
    const missing: string[] = [];
    for (const path of specPaths())
      for (const method of METHODS)
        if (spec.paths[path]?.[method] && !have.has(`${method.toUpperCase()} ${normalize(path)}`))
          missing.push(`${method.toUpperCase()} ${path}`);
    expect(missing).toEqual([]);
  });

  it('[TST-011] every endpoint of the provider doc "Endpoints used" table is implemented', () => {
    const doc = readFileSync(providerDoc(), 'utf8');
    const section = doc.slice(doc.indexOf('## Endpoints used'), doc.indexOf('## Quirks'));
    const have = registered();
    const paths = new Set([...have].map((r) => r.split(' ')[1]));
    const missing: string[] = [];
    let checked = 0;
    for (const m of section.matchAll(/`([^`]+)`/g)) {
      const text = (m[1] as string).replace(/\?.*$/, '');
      const withMethods =
        /^((?:GET|POST|PUT|PATCH|DELETE)(?:\/(?:GET|POST|PUT|PATCH|DELETE))*) (\/\S*)$/.exec(text);
      if (withMethods) {
        for (const method of (withMethods[1] as string).split('/')) {
          checked++;
          // The table abbreviates: `GET/POST/PATCH .../pulls` also means `.../pulls/{n}` and the Git Data
          // paths are relative to `/repos/{o}/{r}`.
          const base = normalize(
            (withMethods[2] as string).startsWith('/git/')
              ? `/repos/{o}/{r}${withMethods[2]}`
              : (withMethods[2] as string),
          );
          if (!have.has(`${method} ${base}`) && !have.has(`${method} ${base}/*`))
            missing.push(text);
        }
      } else if (/^\/(repos|orgs)\//.test(text) && !/\s/.test(text)) {
        // A bare path in the table (variables, secrets, hooks families): at least the collection exists.
        checked++;
        if (!paths.has(normalize(text))) missing.push(text);
      }
    }
    expect(checked).toBeGreaterThan(40);
    expect(missing).toEqual([]);
  });

  it('[TST-011] the GraphQL endpoint and the LFS batch API are mounted', () => {
    const have = registered();
    expect(have.has('POST /graphql')).toBe(true);
    expect(
      [...have].some((r) => r.startsWith('POST') && r.includes('info/lfs/objects/batch')),
    ).toBe(true);
  });
});
