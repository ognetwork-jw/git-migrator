import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDependencies } from './check-deps.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const cleanup: string[] = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

interface Pkg {
  deps?: string[];
  /** Extra package.json fields, merged last. */
  manifest?: Record<string, unknown>;
  src?: string;
  /** Extra files relative to the package directory. */
  files?: Record<string, string>;
}

function fixture(pkgs: Record<string, Pkg>): string {
  const root = mkdtempSync(join(tmpdir(), 'gm-deps-'));
  cleanup.push(root);
  write(
    root,
    'pnpm-workspace.yaml',
    'packages:\n  - apps/*\n  - packages/*\n  - packages/adapters/*\n  - testing/*\n',
  );
  for (const [
    dir,
    { deps = [], manifest = {}, src = 'export {};\n', files = {} },
  ] of Object.entries(pkgs)) {
    const name = dir.replace(/^packages\/adapters\//, 'adapter-').replace(/^[^/]+\//, '');
    write(
      root,
      `${dir}/package.json`,
      JSON.stringify({
        name: `@git-migrator/${name}`,
        dependencies: Object.fromEntries(deps.map((d) => [`@git-migrator/${d}`, 'workspace:*'])),
        ...manifest,
      }),
    );
    write(root, `${dir}/src/index.ts`, src);
    for (const [rel, content] of Object.entries(files)) write(root, `${dir}/${rel}`, content);
  }
  return root;
}

describe('ARC-012 dependency-rule check', () => {
  it('[ARC-012] the real repository has no violations', () => {
    expect(checkDependencies(repoRoot)).toEqual([]);
  });

  it('[ARC-012] fails when core imports another internal package (source import)', () => {
    const root = fixture({
      'packages/core': { src: "import { x } from '@git-migrator/db';\nexport const y = x;\n" },
      'packages/db': {},
    });
    const violations = checkDependencies(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe(join('packages', 'core', 'src', 'index.ts'));
    expect(violations[0]?.message).toContain('must not depend on @git-migrator/db');
  });

  it('[ARC-012] fails on a forbidden package.json dependency', () => {
    const root = fixture({ 'packages/core': { deps: ['canonical'] }, 'packages/canonical': {} });
    expect(checkDependencies(root).map((v) => v.file)).toEqual([
      join('packages', 'core', 'package.json'),
    ]);
  });

  it('[ARC-012] adapters may not depend on facets, git, db or each other', () => {
    const root = fixture({
      'packages/adapters/one': { deps: ['facets', 'adapter-two'] },
      'packages/adapters/two': {},
      'packages/facets': {},
    });
    expect(checkDependencies(root)).toHaveLength(2);
  });

  it('[ARC-012] only registry (and apps) may depend on concrete adapters', () => {
    const root = fixture({
      'packages/adapters/one': {},
      'packages/registry': { deps: ['adapter-one'] },
      'packages/jobs': { deps: ['adapter-one'] },
      'apps/web': { deps: ['adapter-one'] },
    });
    expect(checkDependencies(root).map((v) => v.file)).toEqual([
      join('packages', 'jobs', 'package.json'),
    ]);
  });

  it('[ARC-012] rejects relative imports that reach into another package', () => {
    const root = fixture({
      'packages/core': { src: "export * from '../../canonical/src/index';\n" },
      'packages/canonical': {},
    });
    const violations = checkDependencies(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('reaches outside');
  });

  it('[ARC-012] accepts the allowed edges', () => {
    const root = fixture({
      'packages/core': {},
      'packages/canonical': { deps: ['core'], src: "import '@git-migrator/core';\n" },
      'packages/facets': { deps: ['core', 'canonical'] },
      'packages/quota': { deps: ['db'] },
      'packages/db': {},
      'packages/adapter-sdk': { deps: ['core', 'canonical', 'quota'] },
    });
    expect(checkDependencies(root)).toEqual([]);
  });

  it('[ARC-012] the CLI exits non-zero on a violating fixture and zero on the repository', () => {
    const bad = fixture({
      'packages/core': { src: "import '@git-migrator/db';\n" },
      'packages/db': {},
    });
    const script = join(here, 'check-deps.ts');
    const failing = spawnSync(process.execPath, [script, '--root', bad], { encoding: 'utf8' });
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain('[ARC-012]');
    const passing = spawnSync(process.execPath, [script, '--root', repoRoot], { encoding: 'utf8' });
    expect(passing.status).toBe(0);
  });

  it('[ARC-012] catches dependencies hidden in the value (workspace/link/file paths, npm aliases)', () => {
    for (const value of ['workspace:../db', 'link:../db', 'file:../db', 'npm:@git-migrator/db@1']) {
      const root = fixture({
        'packages/core': { manifest: { dependencies: { harmless: value } } },
        'packages/db': {},
      });
      const violations = checkDependencies(root);
      expect(
        violations.map((v) => v.file),
        value,
      ).toEqual([join('packages', 'core', 'package.json')]);
    }
  });

  it('[ARC-012] catches bundled dependencies', () => {
    for (const field of ['bundledDependencies', 'bundleDependencies']) {
      const root = fixture({
        'packages/core': { manifest: { [field]: ['@git-migrator/db'] } },
        'packages/db': {},
      });
      expect(checkDependencies(root), field).toHaveLength(1);
    }
  });

  it('[ARC-012] checks tsconfig project references against the rules', () => {
    const root = fixture({
      'packages/core': {
        files: { 'tsconfig.json': JSON.stringify({ references: [{ path: '../db' }] }) },
      },
      'packages/db': {},
    });
    const violations = checkDependencies(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('references ../db');
  });

  it('[ARC-012] catches template-literal, createRequire and import.meta.resolve references', () => {
    const forms = [
      'const a = await import(`@git-migrator/db`);',
      "const b = createRequire(import.meta.url)('@git-migrator/db');",
      "const c = import.meta.resolve('@git-migrator/db');",
      '/// <reference types="@git-migrator/db" />',
      "vi.mock('@git-migrator/db');",
      'export type { T } from "@git-migrator/db";',
    ];
    for (const src of forms) {
      const root = fixture({ 'packages/core': { src: `${src}\n` }, 'packages/db': {} });
      expect(checkDependencies(root), src).toHaveLength(1);
    }
  });

  it('[ARC-012] rejects computed specifiers it cannot verify', () => {
    const root = fixture({
      'packages/core': {
        src: ['const m = await import(`@git-migrator/', '$', '{name}`);\n'].join(''),
      },
      'packages/db': {},
    });
    expect(checkDependencies(root)[0]?.message).toContain('cannot be verified');
  });

  it('[ARC-012] ignores package names inside comments', () => {
    const root = fixture({
      'packages/core': {
        src: "// import '@git-migrator/db'\n/* from '@git-migrator/db' */\nexport {};\n",
      },
      'packages/db': {},
    });
    expect(checkDependencies(root)).toEqual([]);
  });

  it('[ARC-012] does not skip a source directory that is merely named like build output', () => {
    const root = fixture({
      'packages/core': {
        files: {
          'src/coverage/x.ts': "import '@git-migrator/db';\n",
          'dist/y.ts': "import '@git-migrator/db';\n",
        },
      },
      'packages/db': {},
    });
    const files = checkDependencies(root).map((v) => v.file);
    expect(files).toEqual([join('packages', 'core', 'src', 'coverage', 'x.ts')]);
  });

  it('[ARC-012] test-support packages: devDependency plus *.test.* files only (*.spec.* under testing/ only)', () => {
    const ok = fixture({
      'packages/core': {
        manifest: { devDependencies: { '@git-migrator/fixtures': 'workspace:*' } },
        files: {
          'src/a.test.ts': "import '@git-migrator/fixtures';\n",
          'src/b.test.tsx': "import '@git-migrator/provider-fakes';\n",
        },
      },
      'testing/fixtures': {},
      'testing/provider-fakes': {},
    });
    expect(checkDependencies(ok)).toEqual([]);
    const fromSrc = fixture({
      'packages/core': { src: "import '@git-migrator/fixtures';\n" },
      'testing/fixtures': {},
    });
    expect(checkDependencies(fromSrc)).toHaveLength(1);
    const asDependency = fixture({
      'packages/core': { deps: ['fixtures'] },
      'testing/fixtures': {},
    });
    expect(checkDependencies(asDependency)).toHaveLength(1);
    const otherTesting = fixture({
      'packages/core': { manifest: { devDependencies: { '@git-migrator/e2e': 'workspace:*' } } },
      'testing/e2e': {},
    });
    expect(checkDependencies(otherTesting)).toHaveLength(1);
  });

  it('[ARC-012] a test/ directory is not a test file, and re-exporting test files is rejected', () => {
    const helperDir = fixture({
      'packages/core': {
        manifest: { devDependencies: { '@git-migrator/fixtures': 'workspace:*' } },
        src: "export * from './test/helper';\n",
        files: { 'src/test/helper.ts': "import '@git-migrator/fixtures';\n" },
      },
      'testing/fixtures': {},
    });
    expect(checkDependencies(helperDir).map((v) => v.file)).toEqual([
      join('packages', 'core', 'src', 'test', 'helper.ts'),
    ]);
    const reexport = fixture({
      'packages/core': {
        manifest: { devDependencies: { '@git-migrator/fixtures': 'workspace:*' } },
        src: "export * from './y.test';\n",
        files: { 'src/y.test.ts': "import '@git-migrator/fixtures';\n" },
      },
      'testing/fixtures': {},
    });
    const messages = checkDependencies(reexport).map((v) => v.message);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('imports a test file from non-test code');
  });

  it('[ARC-012] fails closed: no workspaces, a missing --root value and a missing root', () => {
    const empty = mkdtempSync(join(tmpdir(), 'gm-deps-'));
    cleanup.push(empty);
    const script = join(here, 'check-deps.ts');
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    expect(run('--root', empty).status).toBe(2);
    expect(run('--root').status).toBe(2);
    expect(run('--root', join(empty, 'missing')).status).toBe(2);
    write(empty, 'pnpm-workspace.yaml', 'packages:\n  - nothing-here/*\n');
    expect(run('--root', empty).status).toBe(1);
  });

  it('[ARC-012] flags packages outside pnpm-workspace.yaml and workspaces missing from the root tsconfig', () => {
    const root = fixture({ 'packages/core': {} });
    write(root, 'packages/stray/package.json', JSON.stringify({ name: '@git-migrator/stray' }));
    write(root, 'tsconfig.json', JSON.stringify({ files: [], references: [] }));
    write(root, 'pnpm-workspace.yaml', 'packages:\n  - packages/core\n');
    const messages = checkDependencies(root).map((v) => v.message);
    expect(messages.some((m) => m.includes('not matched by pnpm-workspace.yaml'))).toBe(true);
    expect(messages.some((m) => m.includes('not referenced by the root tsconfig'))).toBe(true);
  });

  it('[ARC-012] only module positions count; plain strings and path.resolve do not', () => {
    const root = fixture({
      'packages/core': {
        src: "export const SERVICE = '@git-migrator/db';\nconst p = path.resolve('../..');\nexport {};\n",
      },
      'packages/db': {},
    });
    expect(checkDependencies(root)).toEqual([]);
    const url = fixture({
      'packages/core': { src: "const u = new URL('../../db/src/index.ts', import.meta.url);\n" },
      'packages/db': {},
    });
    expect(checkDependencies(url)).toHaveLength(1);
    const req = fixture({
      'packages/core': { src: "const u = require.resolve('@git-migrator/db');\n" },
      'packages/db': {},
    });
    expect(checkDependencies(req)).toHaveLength(1);
  });

  it('[ARC-012] rejects absolute specifiers and symlinks that leave the workspace', () => {
    const abs = fixture({
      'packages/core': { src: "import '/abs/elsewhere.js';\nimport 'file:///x/y.js';\n" },
    });
    expect(checkDependencies(abs)).toHaveLength(2);
    const root = fixture({ 'packages/core': {}, 'packages/db': {} });
    symlinkSync(join(root, 'packages/db/src'), join(root, 'packages/core/src/linked'));
    const violations = checkDependencies(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('symlink leaves the workspace');
    const viaLink = fixture({ 'packages/core': {}, 'packages/db': {} });
    symlinkSync(join(viaLink, 'packages/db'), join(viaLink, 'packages/core/db-link'));
    write(viaLink, 'packages/core/src/a.ts', "import '../db-link/src/index';\n");
    expect(checkDependencies(viaLink).length).toBeGreaterThan(0);
  });

  it('[ARC-012] reads every tsconfig*.json, JSONC syntax and file-path references', () => {
    const jsonc = '// comment\n{ /* c */ "references": [ { "path": "../db/tsconfig.json" }, ], }\n';
    const root = fixture({
      'packages/core': { files: { 'tsconfig.build.json': jsonc } },
      'packages/db': {},
    });
    const violations = checkDependencies(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe(join('packages', 'core', 'tsconfig.build.json'));
    const broken = fixture({ 'packages/core': { files: { 'tsconfig.json': '{ nope' } } });
    expect(checkDependencies(broken)[0]?.message).toContain('cannot parse');
  });

  it('[ARC-012] fails closed on unparsable files and does not misread division as a regex', () => {
    const bad = fixture({
      'packages/core': { src: 'const a = `never closed;\n' },
      'packages/db': {},
    });
    expect(checkDependencies(bad)[0]?.message).toContain('could not be parsed');
    const tricky = [
      'const a = i[0]! / 2;',
      'const b = i++ / 2;',
      'const c = i-- / 2;',
      'const d = (x) / 2 / 3;',
      "import '@git-migrator/db';",
    ].join('\n');
    const root = fixture({ 'packages/core': { src: `${tricky}\n` }, 'packages/db': {} });
    expect(checkDependencies(root)).toHaveLength(1);
    const jsx = fixture({
      'packages/core': {
        files: {
          'src/view.tsx':
            "export const v = <div>a</div>;\nconst t = `\nmulti\nline`;\nimport '@git-migrator/db';\nconst s = <p>Don't</p>;\n",
        },
      },
      'packages/db': {},
    });
    expect(checkDependencies(jsx)).toHaveLength(1);
    const regex = fixture({
      'packages/core': { src: "const r = !/a'b/.test(x);\nimport '@git-migrator/db';\n" },
      'packages/db': {},
    });
    expect(checkDependencies(regex)).toHaveLength(1);
  });

  it('[ARC-012] parses real syntax: arrow-returned regex, JSX text with quotes and slashes', () => {
    const src = [
      "export const f = () => /ab'c/;",
      "export const v = <a>it's http://x</a>;",
      "import '@git-migrator/db';",
    ].join('\n');
    const root = fixture({
      'packages/core': { files: { 'src/view.tsx': `${src}\n` }, src: 'export {};\n' },
      'packages/db': {},
    });
    const violations = checkDependencies(root);
    expect(violations.map((v) => v.message)).toEqual([
      expect.stringContaining('must not depend on @git-migrator/db'),
    ]);
  });

  it('[ARC-012] catches createRequire variables, import.meta.glob, node_modules paths, import= and import types', () => {
    const forms = [
      "const r = createRequire(import.meta.url);\nr('@git-migrator/db');",
      "const g = import.meta.glob('../../db/src/*.ts');",
      "const g = import.meta.glob(['@git-migrator/db']);",
      "import '../node_modules/@git-migrator/db/src/index';",
      "import db = require('@git-migrator/db');",
      "export type T = import('@git-migrator/db').X;",
    ];
    for (const src of forms) {
      const root = fixture({ 'packages/core': { src: `${src}\n` }, 'packages/db': {} });
      expect(checkDependencies(root), src).toHaveLength(1);
    }
  });

  it('[ARC-012] *.spec.* files are rejected in packages and apps (they would never run)', () => {
    const root = fixture({
      'packages/core': { files: { 'src/a.spec.ts': 'export {};\n' } },
      'apps/web': { files: { 'src/b.spec.ts': 'export {};\n' } },
      'testing/e2e': { files: { 'src/c.spec.ts': "import '@git-migrator/core';\n" } },
      'testing/fixtures': {},
    });
    expect(
      checkDependencies(root)
        .map((v) => v.file)
        .sort(),
    ).toEqual([
      join('apps', 'web', 'src', 'b.spec.ts'),
      join('packages', 'core', 'src', 'a.spec.ts'),
    ]);
  });

  it('[ARC-012] computed import()/require() specifiers fail closed; literals and safe templates pass', () => {
    for (const src of [
      'await import(name);',
      'require(name);',
      'const r = createRequire(import.meta.url); r(name);',
      `let r; r = createRequire(import.meta.url); r(\`\${a}\`);`,
      `await import(\`\${dir}/x\`);`,
    ]) {
      const root = fixture({ 'packages/core': { src: `${src}\n` } });
      expect(
        checkDependencies(root).map((v) => v.message),
        src,
      ).toEqual([expect.stringContaining('cannot be verified')]);
    }
    const ok = fixture({
      'packages/core': {
        src: `await import('node:fs');\nawait import(\`./locales/\${l}.json\`);\n`,
      },
    });
    expect(checkDependencies(ok)).toEqual([]);
  });

  it('[ARC-012] skips build output directories only at the workspace root', () => {
    const bad = "import '@git-migrator/db';\n";
    const files: Record<string, string> = {};
    for (const d of [
      'dist',
      'out',
      'build',
      '.vercel',
      'storybook-static',
      'playwright-report',
      'test-results',
    ])
      files[`${d}/x.ts`] = bad;
    files['src/build/y.ts'] = bad;
    const root = fixture({ 'packages/core': { files }, 'packages/db': {} });
    expect(checkDependencies(root).map((v) => v.file)).toEqual([
      join('packages', 'core', 'src', 'build', 'y.ts'),
    ]);
  });
});
