import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OTHER_TIER_INCLUDE, UNIT_INCLUDE } from './test-globs.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every package and app of the ARC-010 monorepo layout, by directory and package name. */
const LAYOUT: Record<string, string> = {
  'apps/web': 'web',
  'apps/worker': 'worker',
  'packages/core': 'core',
  'packages/canonical': 'canonical',
  'packages/facets': 'facets',
  'packages/adapter-sdk': 'adapter-sdk',
  'packages/adapters/bitbucket-cloud': 'adapter-bitbucket-cloud',
  'packages/adapters/github': 'adapter-github',
  'packages/registry': 'registry',
  'packages/git': 'git',
  'packages/db': 'db',
  'packages/auth': 'auth',
  'packages/api': 'api',
  'packages/jobs': 'jobs',
  'packages/quota': 'quota',
  'packages/config': 'config',
  'packages/observability': 'observability',
  'packages/guidance': 'guidance',
  'testing/provider-fakes': 'provider-fakes',
  'testing/fixtures': 'fixtures',
  'testing/integration': 'integration',
  'testing/e2e': 'e2e',
};

// biome-ignore lint/suspicious/noExplicitAny: ad-hoc access to arbitrary manifest fields in assertions
type Json = Record<string, any>;
const readJson = (rel: string): Json => JSON.parse(readFileSync(join(root, rel), 'utf8'));

describe('monorepo layout', () => {
  for (const [dir, short] of Object.entries(LAYOUT)) {
    it(`[ARC-010] ${dir} has package.json, tsconfig and src/index.ts`, async () => {
      expect(existsSync(join(root, dir, 'tsconfig.json'))).toBe(true);
      expect(existsSync(join(root, dir, 'src/index.ts'))).toBe(true);
      const pkg = readJson(`${dir}/package.json`);
      expect(pkg.name).toBe(`@git-migrator/${short}`);
      const mod = await import(join(root, dir, 'src/index.ts'));
      expect(mod.PACKAGE_NAME).toBe(`@git-migrator/${short}`);
    });

    it(`[ARC-011] ${dir} is private, ESM and scoped`, () => {
      const pkg = readJson(`${dir}/package.json`);
      expect(pkg.private).toBe(true);
      expect(pkg.type).toBe('module');
      expect(pkg.name.startsWith('@git-migrator/')).toBe(true);
    });

    it(`[ARC-001] ${dir} tsconfig is referenced from the root solution config`, () => {
      const refs = readJson('tsconfig.json').references as { path: string }[];
      expect(refs.map((r) => r.path)).toContain(dir);
    });
  }

  it('[ARC-010] no unlisted package exists', () => {
    const refs = (readJson('tsconfig.json').references as { path: string }[]).map((r) => r.path);
    expect(refs.filter((p) => p !== 'tools').sort()).toEqual(Object.keys(LAYOUT).sort());
  });
});

describe('toolchain pinning', () => {
  const allManifests = ['package.json', ...Object.keys(LAYOUT).map((d) => `${d}/package.json`)];

  it('[ARC-002] every external dependency is pinned exactly', () => {
    for (const rel of allManifests) {
      const pkg = readJson(rel);
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const [name, version] of Object.entries(pkg[field] ?? {}) as [string, string][]) {
          if (version.startsWith('workspace:')) continue;
          expect(version, `${rel} ${name}`).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
        }
      }
    }
  });

  it('[ARC-002] the pnpm lockfile is committed and the package manager is pinned', () => {
    expect(existsSync(join(root, 'pnpm-lock.yaml'))).toBe(true);
    expect(readJson('package.json').packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it('[ARC-001] Node 24 is required by engines, .nvmrc and .node-version', () => {
    expect(readJson('package.json').engines.node).toBe('24.x');
    for (const f of ['.nvmrc', '.node-version'])
      expect(readFileSync(join(root, f), 'utf8').trim()).toBe('24');
  });

  it('[ARC-001] ADR-0002 records the installed tool versions', () => {
    const adr = readFileSync(join(root, 'docs/adr/0002-versions.md'), 'utf8');
    const rootPkg = readJson('package.json');
    for (const [name, version] of Object.entries(rootPkg.devDependencies) as [string, string][]) {
      expect(adr, name).toContain(`\`${name}\``);
      expect(adr, `${name}@${version}`).toContain(`\`${version}\``);
    }
  });

  it('[ARC-001] TypeScript is strict with noUncheckedIndexedAccess', () => {
    const base = readJson('tsconfig.base.json').compilerOptions;
    expect(base.strict).toBe(true);
    expect(base.noUncheckedIndexedAccess).toBe(true);
    expect(base.composite).toBe(true);
  });

  it('[ARC-001] Turborepo defines build, typecheck, lint and test', () => {
    const tasks = Object.keys(readJson('turbo.json').tasks);
    for (const t of ['build', 'typecheck', 'lint', 'test']) expect(tasks).toContain(t);
  });
});

describe('vitest configuration', () => {
  it('[TST-005] unit discovery and coverage include .tsx sources and tests', async () => {
    const config = (await import(join(root, 'vitest.config.ts'))).default as Json;
    const unit = config.test.projects[0].test.include as string[];
    const cov = config.test.coverage.include as string[];
    for (const glob of [
      ...unit.filter((g) => g.startsWith('apps') || g.startsWith('packages')),
      ...cov.filter((g) => !g.startsWith('tools')),
    ])
      expect(glob, glob).toContain('tsx');
  });

  it('[TST-005] thresholds exist for each gated package', async () => {
    const config = (await import(join(root, 'vitest.config.ts'))).default as Json;
    expect(Object.keys(config.test.coverage.thresholds).sort()).toEqual(
      [
        'apps/*/src/**',
        'packages/adapters/*/src/**',
        'packages/api/src/**',
        'packages/core/src/**',
        'packages/facets/src/**',
        'packages/git/src/**',
        'packages/jobs/src/**',
        'packages/quota/src/**',
      ].sort(),
    );
  });
});

describe('root scripts', () => {
  it('[DEV-040] every documented root script exists', () => {
    const scripts = Object.keys(readJson('package.json').scripts);
    for (const s of [
      'dev',
      'db:migrate',
      'db:seed',
      'db:reset',
      'generate',
      'lint',
      'format',
      'typecheck',
      'test',
      'test:integration',
      'test:e2e',
      'test:e2e:live',
      'e2e:live:reset',
      'helm:check',
      'spec:coverage',
    ])
      expect(scripts, s).toContain(s);
  });
});

describe('tests type-checking', () => {
  /** Expands the single `{a,b,c}` group of a glob. */
  const expand = (glob: string): string[] => {
    const m = /\{([^}]+)\}/.exec(glob);
    return m ? (m[1] as string).split(',').map((alt) => glob.replace(m[0], alt)) : [glob];
  };

  it('[TST-005] tsconfig.tests.json lists one pattern per extension for every test glob (no brace expansion)', () => {
    const include = readJson('tsconfig.tests.json').include as string[];
    expect(include.some((g) => g.includes('{'))).toBe(false);
    const expected = [...UNIT_INCLUDE, ...OTHER_TIER_INCLUDE]
      .filter((g) => !g.startsWith('tools/'))
      .flatMap(expand);
    for (const glob of expected) expect(include, glob).toContain(glob);
  });

  it('[TST-005] an ill-typed package test fails `tsc -p tsconfig.tests.json`', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gm-tests-tsc-'));
    try {
      for (const f of ['tsconfig.base.json', 'tsconfig.tests.json'])
        copyFileSync(join(root, f), join(tmp, f));
      writeFileSync(join(tmp, 'vitest.config.ts'), 'export default {};\n');
      symlinkSync(join(root, 'node_modules'), join(tmp, 'node_modules'));
      const tsc = join(root, 'node_modules/typescript/bin/tsc');
      const run = () =>
        spawnSync(process.execPath, [tsc, '-p', join(tmp, 'tsconfig.tests.json')], {
          encoding: 'utf8',
          cwd: tmp,
        });
      for (const file of [
        'packages/core/src/x.test.ts',
        'packages/adapters/one/src/x.test.mts',
        'apps/web/src/x.test.tsx',
        'testing/integration/x.test.ts',
        'testing/e2e/x.spec.ts',
      ]) {
        mkdirSync(dirname(join(tmp, file)), { recursive: true });
        writeFileSync(join(tmp, file), "export const n: number = 'a';\n");
        const result = run();
        expect(result.status, `${file}: ${result.stdout}`).not.toBe(0);
        expect(result.stdout, file).toContain('TS2322');
        rmSync(join(tmp, file));
      }
      expect(run().status).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
