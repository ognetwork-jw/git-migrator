import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseSync } from 'oxc-parser';
import { describe, expect, it } from 'vitest';

const APP_DIR = join(import.meta.dirname, '..');
/** Modules that hold server credentials and the database: never part of a browser bundle. */
const SERVER_DIR = join(APP_DIR, 'src', 'server');
const SERVER_PACKAGES = ['@git-migrator/web/server/api'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes are walked generically
type Node = { type: string; [key: string]: any };

function walk(node: unknown, visit: (n: Node) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
  } else if (node && typeof node === 'object') {
    const n = node as Node;
    if (typeof n.type === 'string') visit(n);
    for (const [key, child] of Object.entries(n)) {
      if (key !== 'type' && key !== 'start' && key !== 'end') walk(child, visit);
    }
  }
}

interface ModuleInfo {
  readonly client: boolean;
  /** Specifiers of value imports and re-exports; type-only ones are erased and do not count. */
  readonly imports: readonly string[];
}

/** Whether a module starts with `'use client'`, and what it imports at run time. */
function moduleInfo(path: string, source: string): ModuleInfo {
  const parsed = parseSync(path, source);
  const program = parsed.program as unknown as Node;
  const client = (program.body as Node[]).some(
    (statement) => statement.type === 'ExpressionStatement' && statement.directive === 'use client',
  );
  const imports: string[] = [];
  walk(program, (node) => {
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
      imports.push(String(node.source.value));
    }
    if (
      (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
      node.source &&
      node.exportKind !== 'type'
    ) {
      imports.push(String(node.source.value));
    }
    if (node.type === 'ImportExpression' && node.source?.type === 'Literal') {
      imports.push(String(node.source.value));
    }
  });
  return { client, imports };
}

/** The file a relative specifier names, or `undefined` for a package. */
function resolveRelative(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(from), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find(
    (candidate) => existsSync(candidate) && /\.tsx?$/.test(candidate),
  );
}

/**
 * Every path from a client module into a server-only module: the client entry, the chain of
 * imports, and the server module or package it ends at. `load` reads a module's imports.
 */
function clientToServerPaths(
  entries: readonly string[],
  load: (path: string) => ModuleInfo,
  isServer: (pathOrSpecifier: string) => boolean,
): string[][] {
  const found: string[][] = [];
  for (const entry of entries) {
    if (!load(entry).client) continue;
    const seen = new Set<string>([entry]);
    const queue: string[][] = [[entry]];
    while (queue.length > 0) {
      const chain = queue.shift() as string[];
      const current = chain[chain.length - 1] as string;
      for (const specifier of load(current).imports) {
        if (isServer(specifier)) {
          found.push([...chain, specifier]);
          continue;
        }
        const target = resolveRelative(current, specifier);
        if (target === undefined || seen.has(target)) continue;
        if (isServer(target)) {
          found.push([...chain, target]);
          continue;
        }
        seen.add(target);
        queue.push([...chain, target]);
      }
    }
  }
  return found;
}

const isServerModule = (pathOrSpecifier: string): boolean =>
  pathOrSpecifier.startsWith(`${SERVER_DIR}${sep}`) || SERVER_PACKAGES.includes(pathOrSpecifier);

describe('server-only modules stay out of the browser bundle', () => {
  it('[UI-001] no client component reaches src/server, directly or through other modules', () => {
    const cache = new Map<string, ModuleInfo>();
    const load = (path: string): ModuleInfo => {
      let info = cache.get(path);
      if (info === undefined) {
        info = moduleInfo(path, readFileSync(path, 'utf8'));
        cache.set(path, info);
      }
      return info;
    };
    const entries = [join(APP_DIR, 'app'), join(APP_DIR, 'src')].flatMap(sourceFiles);
    expect(entries.filter((path) => load(path).client).length).toBeGreaterThan(20);
    const paths = clientToServerPaths(entries, load, isServerModule).map((chain) =>
      chain.map((step) => (step.startsWith('/') ? relative(APP_DIR, step) : step)).join(' -> '),
    );
    expect(paths).toEqual([]);
  });

  it('[UI-001] the check follows chains of imports and ignores type-only imports', () => {
    const root = join(APP_DIR, 'src');
    // `shell/navigation.ts` exists on disk, so the walk resolves it and follows it.
    const graph: Record<string, ModuleInfo> = {
      [join(root, 'view.tsx')]: { client: true, imports: ['./shell/navigation.ts'] },
      [join(root, 'shell', 'navigation.ts')]: { client: false, imports: ['../server/api.ts'] },
    };
    const load = (path: string): ModuleInfo => graph[path] ?? { client: false, imports: [] };
    const isServer = (s: string) => s.includes(`${sep}server${sep}`) || s.endsWith('server/api.ts');
    expect(clientToServerPaths([join(root, 'view.tsx')], load, isServer)).toEqual([
      [join(root, 'view.tsx'), join(root, 'shell', 'navigation.ts'), '../server/api.ts'],
    ]);
    // A server component may import the server modules.
    expect(
      clientToServerPaths(
        [join(root, 'page.tsx')],
        () => ({ client: false, imports: ['./server/api.ts'] }),
        isServer,
      ),
    ).toEqual([]);
    expect(
      moduleInfo('t.tsx', "'use client';\nimport type { ApiRuntime } from './server/api.ts';\n"),
    ).toEqual({ client: true, imports: [] });
    expect(
      moduleInfo('t.ts', "export { x } from './a.ts';\nconst m = import('./b.ts');\n"),
    ).toEqual({
      client: false,
      imports: ['./a.ts', './b.ts'],
    });
  });
});
