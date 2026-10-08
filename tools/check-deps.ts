/**
 * ARC-012 dependency-rule check.
 *
 * Workspaces come from pnpm-workspace.yaml. For each one it verifies that package.json
 * dependencies (keys AND values: `workspace:`/`link:`/`file:` paths, `npm:` aliases, bundled
 * dependencies), tsconfig `references` and the imports in source files respect the allowed internal
 * dependencies of ARC-012, and that no file reaches into another package by relative path.
 *
 * Only `*.test.*` and `*.spec.*` files count as test files; they may use test-support packages, and
 * non-test files may not import them (or any test file).
 *
 * Usage: node tools/check-deps.ts [--root <dir>]
 * Exit codes: 0 ok, 1 violations, 2 usage error or no workspaces found (never "OK" on nothing).
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Node, parse, stringValue, walk as walkAst } from './ast.ts';
import { BUILD_OUTPUT_DIRS } from './test-globs.ts';

export const SCOPE = '@git-migrator/';

/** Marker used in `RULES` for "any concrete adapter package" (everything under packages/adapters). */
export const ANY_ADAPTER = '*adapters';

/**
 * Allowed internal dependencies by package short name (package name without the scope).
 * Packages under `packages/adapters/` share the `adapter` rule. `apps/*` and `testing/*` may depend
 * on anything. See docs/adr/0028-dependency-rule-checker.md for the choices beyond ARC-012's text.
 */
export const RULES: Readonly<Record<string, readonly string[]>> = {
  core: [],
  canonical: ['core'],
  facets: ['core', 'canonical'],
  'adapter-sdk': ['core', 'canonical', 'quota'],
  adapter: ['adapter-sdk', 'canonical', 'core'],
  git: ['adapter-sdk', 'core', 'canonical'],
  quota: ['db', 'core'],
  registry: ['core', 'canonical', 'facets', 'adapter-sdk', ANY_ADAPTER],
  db: ['core', 'canonical'],
  auth: ['db', 'config', 'observability', 'core'],
  api: [
    'core',
    'canonical',
    'db',
    'auth',
    'jobs',
    'registry',
    'quota',
    'config',
    'observability',
    'guidance',
    'adapter-sdk',
  ],
  jobs: [
    'core',
    'canonical',
    'db',
    'quota',
    'registry',
    'git',
    'adapter-sdk',
    'config',
    'observability',
    'guidance',
  ],
  config: [],
  observability: [],
  guidance: ['core', 'canonical'],
};

/** Test-support packages any package may use as a devDependency, from test files only. */
export const TEST_SUPPORT = ['provider-fakes', 'fixtures'] as const;

export interface Violation {
  rule: 'ARC-012';
  file: string;
  message: string;
}

export interface Workspace {
  dir: string;
  relDir: string;
  name: string;
  short: string;
  /** Key into RULES, or 'any'. */
  ruleKey: string;
  isAdapter: boolean;
  isTesting: boolean;
}

const ALWAYS_SKIP = 'node_modules';
/** Skipped only directly under a workspace root (build output), never deeper (a `src/coverage` dir is source). */
const ROOT_SKIP = BUILD_OUTPUT_DIRS;
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
/** The only files that count as tests. Directory names such as `test/` do not. */
export const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
/** Playwright specs; only recognised (and only allowed) under testing/. */
const SPEC_FILE = /\.spec\.[cm]?[jt]sx?$/;
const TEST_SPECIFIER = /\.(?:test|spec)(?:\.[cm]?[jt]sx?)?$/;

/** Strips comments and trailing commas so tsconfig-style JSONC can be parsed. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === '}' || c === ']') {
      out = out.replace(/,\s*$/, '');
      out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out);
}

type Report = (file: string, message: string) => void;

function readJson(file: string, report?: Report): Record<string, unknown> {
  try {
    const value = parseJsonc(readFileSync(file, 'utf8'));
    if (value && typeof value === 'object') return value as Record<string, unknown>;
    throw new Error('not an object');
  } catch (error) {
    if (!report) throw error;
    report(file, `cannot parse: ${(error as Error).message}`);
    return {};
  }
}

/** realpath of the nearest existing ancestor plus the remaining (non-existent) tail. */
function realpathLoose(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    tail.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  return join(realpathSync(current), ...tail);
}

const within = (dir: string, path: string) => path === dir || path.startsWith(dir + sep);

/** Reads the `packages:` list of pnpm-workspace.yaml (plain `- glob` items; `!` excludes). */
export function readWorkspaceGlobs(root: string): string[] {
  const file = join(root, 'pnpm-workspace.yaml');
  if (!existsSync(file)) return [];
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd();
    if (/^packages:\s*$/.test(line)) inPackages = true;
    else if (/^\S/.test(line)) inPackages = false;
    else if (inPackages) {
      const m = /^\s+-\s+['"]?([^'"]+?)['"]?\s*$/.exec(line);
      if (m?.[1]) globs.push(m[1]);
    }
  }
  return globs;
}

function expandGlob(root: string, glob: string): string[] {
  const parts = glob.replace(/\/+$/, '').split('/');
  let dirs = [root];
  for (const part of parts) {
    const next: string[] = [];
    for (const d of dirs) {
      if (part === '*' || part === '**') {
        if (!existsSync(d)) continue;
        for (const e of readdirSync(d, { withFileTypes: true }))
          if (e.isDirectory() && e.name !== ALWAYS_SKIP && !e.name.startsWith('.'))
            next.push(join(d, e.name));
      } else next.push(join(d, part));
    }
    dirs = next;
  }
  return dirs.filter((d) => existsSync(join(d, 'package.json')));
}

export function discoverWorkspaces(root: string): Workspace[] {
  const globs = readWorkspaceGlobs(root);
  const include = globs.filter((g) => !g.startsWith('!'));
  const exclude = new Set(
    globs.filter((g) => g.startsWith('!')).flatMap((g) => expandGlob(root, g.slice(1))),
  );
  const seen = new Set<string>();
  const found: Workspace[] = [];
  for (const dir of include.flatMap((g) => expandGlob(root, g))) {
    if (seen.has(dir) || exclude.has(dir)) continue;
    seen.add(dir);
    const manifest = readJson(join(dir, 'package.json'), () => {});
    const name = String(manifest.name ?? '');
    const short = name.startsWith(SCOPE) ? name.slice(SCOPE.length) : name;
    const relDir = relative(root, dir).split(sep).join('/');
    const isAdapter = relDir.startsWith('packages/adapters/');
    const isTesting = relDir.startsWith('testing/');
    let ruleKey = 'any';
    if (relDir.startsWith('packages/')) ruleKey = short;
    if (isAdapter) ruleKey = 'adapter';
    found.push({ dir, relDir, name, short, ruleKey, isAdapter, isTesting });
  }
  return found;
}

/** Source files of a workspace. Symlinks are never followed; ones leaving the workspace are reported. */
function* walk(
  wsDir: string,
  realWs: string,
  report: Report,
  dir = wsDir,
  atRoot = true,
): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (lstatSync(full).isSymbolicLink()) {
      const target = realpathLoose(full);
      if (!within(realWs, target))
        report(full, `symlink leaves the workspace (${relative(wsDir, full)} -> ${target})`);
      continue;
    }
    if (entry.isDirectory()) {
      if (entry.name === ALWAYS_SKIP || (atRoot && ROOT_SKIP.has(entry.name))) continue;
      yield* walk(wsDir, realWs, report, full, false);
    } else if (SOURCE_EXT.test(entry.name)) {
      yield full;
    }
  }
}

function targetShort(specifier: string): string {
  const rest = specifier.slice(SCOPE.length);
  return rest.split('/')[0] ?? rest;
}

export interface ModuleReference {
  specifier: string;
  dynamic: boolean;
}

const MODULE_CALL_NAMES = new Set([
  'mock',
  'doMock',
  'unmock',
  'doUnmock',
  'importActual',
  'importMock',
  'requireActual',
  'requireMock',
]);

const isMember = (n: Node | undefined, object: string, property: string): boolean =>
  n?.type === 'MemberExpression' &&
  n.object?.type === 'Identifier' &&
  n.object.name === object &&
  n.property?.name === property;

/**
 * Module specifiers found in code, via a real parser (comments and ordinary strings are ignored).
 * A string counts when it is in a module position: `import`/`export … from`, `import()`,
 * `import x = require()`, `import('x')` types, `require()`, `require.resolve()`,
 * `import.meta.resolve()`, `import.meta.glob()`, `vi.mock`-style calls, `createRequire(…)(…)` and
 * variables assigned from `createRequire`, `new URL('…', import.meta.url)`, and `/// <reference>`
 * directives. A syntax error makes `ok` false (fail closed).
 */
export function findModuleReferences(
  source: string,
  filename = 'file.ts',
): { references: ModuleReference[]; ok: boolean } {
  const { program, comments, ok } = parse(source, filename);
  const references: ModuleReference[] = [];
  const add = (node: Node | undefined) => {
    const str = stringValue(node);
    if (str) references.push({ specifier: str.value, dynamic: str.dynamic });
  };

  /** import()/require() arguments: anything that is not a string is a computed specifier (fail closed). */
  const addDynamic = (node: Node | undefined) => {
    if (!node) return;
    if (!stringValue(node)) references.push({ specifier: '', dynamic: true });
    else add(node);
  };

  // Variables holding a require function: `const r = createRequire(import.meta.url)`.
  const requireFns = new Set<string>(['require']);
  walkAst(program, (n) => {
    const target =
      n.type === 'VariableDeclarator'
        ? { id: n.id as Node | undefined, init: n.init as Node | undefined }
        : n.type === 'AssignmentExpression' && n.operator === '='
          ? { id: n.left as Node | undefined, init: n.right as Node | undefined }
          : undefined;
    if (target?.id?.type !== 'Identifier') return;
    const callee =
      target.init?.type === 'CallExpression' ? (target.init.callee as Node) : undefined;
    if (
      (callee?.type === 'Identifier' && callee.name === 'createRequire') ||
      (callee?.type === 'MemberExpression' && callee.property?.name === 'createRequire')
    )
      requireFns.add(target.id.name as string);
  });

  walkAst(program, (n) => {
    switch (n.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
      case 'ExportNamedDeclaration':
        if (n.source) add(n.source);
        break;
      case 'ImportExpression':
        addDynamic(n.source);
        break;
      case 'TSImportEqualsDeclaration':
        if (n.moduleReference?.type === 'TSExternalModuleReference')
          add(n.moduleReference.expression);
        break;
      case 'TSImportType':
        add(n.source ?? n.argument?.literal ?? n.argument);
        break;
      case 'NewExpression':
        if (
          n.callee?.type === 'Identifier' &&
          n.callee.name === 'URL' &&
          n.arguments?.[1]?.type === 'MemberExpression' &&
          n.arguments[1].object?.type === 'MetaProperty'
        )
          add(n.arguments[0]);
        break;
      case 'CallExpression': {
        const callee = n.callee as Node;
        const first = n.arguments?.[0] as Node | undefined;
        const meta = callee.type === 'MemberExpression' && callee.object?.type === 'MetaProperty';
        if (callee.type === 'Identifier' && requireFns.has(callee.name as string)) {
          addDynamic(first);
        } else if (
          callee.type === 'CallExpression' ||
          isMember(callee, 'require', 'resolve') ||
          (meta && callee.property?.name === 'resolve') ||
          (callee.type === 'MemberExpression' && MODULE_CALL_NAMES.has(callee.property?.name))
        )
          add(first);
        else if (meta && callee.property?.name === 'glob') {
          if (first?.type === 'ArrayExpression') for (const el of first.elements as Node[]) add(el);
          else add(first);
        }
        break;
      }
    }
  });

  for (const c of comments) {
    const m = /^\/\s*<reference\s+(?:types|path)\s*=\s*["']([^"']+)["']/.exec(c.value);
    if (m?.[1]) references.push({ specifier: m[1], dynamic: false });
  }
  return { references, ok };
}

function isTestFile(ws: Workspace, file: string): boolean {
  return TEST_FILE.test(file) || (ws.isTesting && SPEC_FILE.test(file));
}

/** Workspace short names that a package.json dependency entry points at (key and value). */
function dependencyTargets(
  ws: Workspace,
  byDir: Map<string, Workspace>,
  key: string,
  value: string,
): string[] {
  const targets: string[] = [];
  if (key.startsWith(SCOPE)) targets.push(targetShort(key));
  const alias = /^(?:npm|workspace):(@git-migrator\/[^@]+)/.exec(value);
  if (alias?.[1]) targets.push(targetShort(alias[1]));
  const pathMatch = /^(?:workspace|link|file|portal):(.+)$/.exec(value);
  const spec = pathMatch?.[1];
  if (spec && /^(?:\.|\/|~)/.test(spec)) {
    const resolved = realpathLoose(resolve(ws.dir, spec));
    for (const [dir, other] of byDir) if (within(dir, resolved)) targets.push(other.short);
  }
  return targets;
}

export function checkDependencies(root: string): Violation[] {
  const workspaces = discoverWorkspaces(root);
  const byShort = new Map(workspaces.map((w) => [w.short, w]));
  const byDir = new Map(workspaces.map((w) => [realpathLoose(w.dir), w]));
  const violations: Violation[] = [];
  const add: Report = (file, message) =>
    violations.push({ rule: 'ARC-012', file: relative(root, file), message });

  if (workspaces.length === 0) {
    add(join(root, 'pnpm-workspace.yaml'), 'no workspace packages found; refusing to report OK');
    return violations;
  }

  const verdict = (
    from: Workspace,
    target: string,
    ctx: { devDependencyOnly: boolean; testFile: boolean },
  ): string | undefined => {
    const other = byShort.get(target);
    if (!other) return `refers to unknown internal package ${SCOPE}${target}`;
    if (from.ruleKey === 'any' || target === from.short) return undefined;
    const allowed = RULES[from.ruleKey] ?? [];
    if (allowed.includes(target)) return undefined;
    if (other.isAdapter && allowed.includes(ANY_ADAPTER)) return undefined;
    if (other.isTesting && (TEST_SUPPORT as readonly string[]).includes(target)) {
      if (ctx.devDependencyOnly && ctx.testFile) return undefined;
      return `${SCOPE}${target} is test support: list it only in devDependencies and import it only from *.test.* / *.spec.* files`;
    }
    return `${from.name} must not depend on ${SCOPE}${target} (allowed: ${
      allowed.join(', ') || 'no internal packages'
    })`;
  };

  // Packages that exist on disk but are not part of the pnpm workspace would escape every check.
  const known = new Set(workspaces.map((w) => w.dir));
  for (const top of ['apps', 'packages', 'testing']) {
    const base = join(root, top);
    if (!existsSync(base)) continue;
    const stack = [base];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name === ALWAYS_SKIP || ROOT_SKIP.has(e.name)) continue;
        const sub = join(dir, e.name);
        if (existsSync(join(sub, 'package.json')) && !known.has(sub))
          add(join(sub, 'package.json'), 'package is not matched by pnpm-workspace.yaml');
        if (relative(base, sub).split(sep).length < 3) stack.push(sub);
      }
    }
  }

  // Every workspace must be a project of the root tsconfig solution file (when there is one).
  const rootTsconfig = join(root, 'tsconfig.json');
  if (existsSync(rootTsconfig)) {
    const refs = ((readJson(rootTsconfig, add).references ?? []) as { path: string }[]).map((r) =>
      realpathLoose(resolve(root, r.path.endsWith('.json') ? dirname(r.path) : r.path)),
    );
    for (const ws of workspaces)
      if (!refs.includes(realpathLoose(ws.dir)))
        add(rootTsconfig, `${ws.relDir} is not referenced by the root tsconfig.json`);
  }

  for (const ws of workspaces) {
    const realWs = realpathLoose(ws.dir);
    const pkgFile = join(ws.dir, 'package.json');
    const pkg = readJson(pkgFile, add);
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      const deps = (pkg[field] ?? {}) as Record<string, string>;
      for (const [key, value] of Object.entries(deps)) {
        for (const target of new Set(dependencyTargets(ws, byDir, key, String(value)))) {
          const problem = verdict(ws, target, {
            devDependencyOnly: field === 'devDependencies',
            testFile: true,
          });
          if (problem) add(pkgFile, `${field}.${key}: ${problem}`);
        }
      }
    }
    for (const field of ['bundledDependencies', 'bundleDependencies']) {
      const bundled = pkg[field];
      if (!Array.isArray(bundled)) continue;
      for (const name of bundled as string[]) {
        if (!String(name).startsWith(SCOPE)) continue;
        const problem = verdict(ws, targetShort(String(name)), {
          devDependencyOnly: false,
          testFile: false,
        });
        if (problem) add(pkgFile, `${field}: ${problem}`);
      }
    }

    // TypeScript project references (every tsconfig*.json; a reference may name a file).
    for (const entry of readdirSync(ws.dir)) {
      if (!/^tsconfig.*\.json$/.test(entry)) continue;
      const tsconfig = join(ws.dir, entry);
      for (const ref of (readJson(tsconfig, add).references ?? []) as { path: string }[]) {
        const refPath = resolve(ws.dir, ref.path);
        const target = realpathLoose(refPath.endsWith('.json') ? dirname(refPath) : refPath);
        const other = byDir.get(target);
        if (!other) {
          if (!within(realWs, target))
            add(tsconfig, `references ${ref.path}, which is not a workspace package`);
          continue;
        }
        const problem = verdict(ws, other.short, { devDependencyOnly: false, testFile: false });
        if (problem) add(tsconfig, `references ${ref.path}: ${problem}`);
      }
    }

    for (const file of walk(ws.dir, realWs, add)) {
      const testFile = isTestFile(ws, file);
      if (!ws.isTesting && SPEC_FILE.test(file))
        add(
          file,
          '*.spec.* files are not run or type-checked in packages and apps; name it *.test.*',
        );
      const { references, ok } = findModuleReferences(readFileSync(file, 'utf8'), file);
      if (!ok) add(file, 'could not be parsed (syntax error); fix the file');
      for (const ref of references) {
        const { dynamic } = ref;
        // A path through node_modules/@git-migrator/ is the package, not a relative file.
        const viaModules = ref.specifier.indexOf('node_modules/@git-migrator/');
        const specifier =
          ref.specifier.startsWith('.') && viaModules >= 0
            ? ref.specifier.slice(viaModules + 'node_modules/'.length)
            : ref.specifier;
        if (dynamic && (specifier === '' || specifier.startsWith(SCOPE))) {
          add(file, 'dynamic import with a computed specifier cannot be verified (ARC-012)');
        } else if (specifier.startsWith(SCOPE)) {
          const problem = verdict(ws, targetShort(specifier), {
            devDependencyOnly: true,
            testFile,
          });
          if (problem) add(file, `'${specifier}': ${problem}`);
        } else if (specifier.startsWith('/') || specifier.startsWith('file:')) {
          add(file, `'${specifier}' is an absolute specifier; import the package by name`);
        } else if (specifier.startsWith('.')) {
          const resolved = realpathLoose(resolve(dirname(file), specifier));
          if (!within(realWs, resolved))
            add(file, `'${specifier}' reaches outside ${ws.relDir}; import the package by name`);
          else if (!testFile && TEST_SPECIFIER.test(specifier))
            add(file, `'${specifier}' imports a test file from non-test code`);
        }
      }
    }
  }
  return violations;
}

export function main(argv: readonly string[]): number {
  const rootFlag = argv.indexOf('--root');
  if (rootFlag >= 0 && (argv[rootFlag + 1] === undefined || argv[rootFlag + 1]?.startsWith('--'))) {
    console.error('check-deps: --root needs a directory');
    return 2;
  }
  const root = resolve(
    rootFlag >= 0
      ? (argv[rootFlag + 1] as string)
      : join(dirname(fileURLToPath(import.meta.url)), '..'),
  );
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`check-deps: root not found: ${root}`);
    return 2;
  }
  if (readWorkspaceGlobs(root).length === 0) {
    console.error(
      `check-deps: no workspaces in ${join(root, 'pnpm-workspace.yaml')}; refusing to report OK`,
    );
    return 2;
  }
  const violations = checkDependencies(root);
  for (const v of violations) console.error(`[${v.rule}] ${v.file}: ${v.message}`);
  if (violations.length > 0) {
    console.error(`check-deps: ${violations.length} dependency-rule violation(s)`);
    return 1;
  }
  console.log('check-deps: dependency rules OK (ARC-012)');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
