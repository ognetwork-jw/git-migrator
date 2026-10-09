import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectSpecIds,
  computeReport,
  extractIds,
  extractTestTitleIds,
  ILLUSTRATIVE_IDS,
  isMustTest,
  main,
  readMustTest,
  renderMustTest,
} from './spec-coverage.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// IDs are assembled at runtime so that this file does not itself "reference" real requirements.
const id = (prefix: string, n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

function write(root: string, rel: string, content: string) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function world() {
  const root = mkdtempSync(join(tmpdir(), 'gm-spec-'));
  cleanup.push(root);
  const must = id('LIF', 1);
  const mustCovered = id('LIF', 2);
  const optional = id('API', 3);
  write(
    root,
    'docs/spec/03-x.md',
    `- **${must}** a\n- **${mustCovered}** b\n- ${optional} c\n- ${id('JOB', 41)} d\n- ${id('JOB', 11)} e\n- ${id('FAC-BRR', 2)} f\n- ${id('AUTH', 7)} g\n`,
  );
  write(root, 'docs/spec/15-work-breakdown.md', `ranges ${id('LIF', 900)} only referenced\n`);
  write(root, 'packages/core/src/a.test.ts', `it('[${mustCovered}] works', () => {});\n`);
  write(root, 'packages/core/src/a.ts', `// ${must} mentioned in non-test source does not count\n`);
  return { root, must, mustCovered, optional };
}

describe('spec:coverage', () => {
  it('[TST-002] extracts requirement IDs, including multi-part facet IDs', () => {
    expect(
      extractIds(`x ${id('FAC-BRR', 2)}, ${id('LIF', 42)} and SHA-256 and ${id('UTF', 8)}`),
    ).toEqual([id('FAC-BRR', 2), id('LIF', 42)]);
  });

  it('[TST-002] must-test covers LIF, FAC, JOB-04x and AUTH-0xx only', () => {
    for (const ok of [id('LIF', 1), id('FAC', 6), id('FAC-GIT', 12), id('JOB', 46), id('AUTH', 61)])
      expect(isMustTest(ok), ok).toBe(true);
    for (const no of [id('JOB', 11), id('JOB', 60), id('API', 1), id('DOM', 4), id('AUTH', 101)])
      expect(isMustTest(no), no).toBe(false);
  });

  it('[TST-002] ignores the work breakdown when collecting spec IDs', () => {
    const { root, must } = world();
    const ids = collectSpecIds(root);
    expect(ids).toContain(must);
    expect(ids).not.toContain(id('LIF', 900));
  });

  it('[TST-002] ignores IDs that the overview uses only as naming examples (ADR-0506)', () => {
    const { root } = world();
    const example = id('LIF', 12);
    expect(ILLUSTRATIVE_IDS['00-overview.md']).toContain(example);
    write(root, 'docs/spec/00-overview.md', `for example \`${example}\`\n`);
    expect(collectSpecIds(root)).not.toContain(example);
    // The same ID defined in another spec file is a real requirement.
    write(root, 'docs/spec/06-x.md', `- **${example}** defined\n`);
    expect(collectSpecIds(root)).toContain(example);
    expect(readFileSync(join(repoRoot, 'must-test.txt'), 'utf8')).not.toContain(example);
  });

  it('[TST-002] lists uncovered IDs and flags must-test ones', () => {
    const { root, must, mustCovered, optional } = world();
    write(root, 'must-test.txt', renderMustTest(collectSpecIds(root)));
    const report = computeReport(root);
    expect(report.uncovered).toContain(must);
    expect(report.uncovered).toContain(optional);
    expect(report.uncovered).not.toContain(mustCovered);
    expect(report.uncoveredMustTest).toContain(must);
    expect(report.uncoveredMustTest).not.toContain(optional);
    expect(readMustTest(join(root, 'must-test.txt'))).toEqual(
      [must, mustCovered, id('JOB', 41), id('FAC-BRR', 2), id('AUTH', 7)].sort(),
    );
  });

  it('[TST-002] report-only mode exits 0; strict mode exits 1 only for must-test gaps', () => {
    const { root } = world();
    write(root, 'must-test.txt', renderMustTest(collectSpecIds(root)));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(main(['--root', root], {})).toBe(0);
    expect(main(['--root', root, '--strict'], {})).toBe(1);
    expect(main(['--root', root], { SPEC_COVERAGE_STRICT: '1' })).toBe(1);
  });

  it('[TST-002] strict mode passes when only non-must-test IDs are uncovered', () => {
    const root = mkdtempSync(join(tmpdir(), 'gm-spec-'));
    cleanup.push(root);
    write(root, 'docs/spec/a.md', `${id('API', 3)} ${id('LIF', 5)}\n`);
    write(root, 'packages/x/src/x.test.ts', `it('[${id('LIF', 5)}] x', () => {});\n`);
    write(root, 'must-test.txt', renderMustTest(collectSpecIds(root)));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(main(['--root', root, '--strict'], {})).toBe(0);
  });

  it('[TST-002] --generate writes must-test.txt', () => {
    const { root } = world();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(main(['--root', root, '--generate'], {})).toBe(0);
    const lines = readMustTest(join(root, 'must-test.txt'));
    expect(lines).toHaveLength(5);
    expect(readFileSync(join(root, 'must-test.txt'), 'utf8')).toMatch(/^# /);
  });

  it('[TST-002] warns about a stale or incomplete must-test.txt', () => {
    const { root, must } = world();
    write(root, 'must-test.txt', `${id('LIF', 777)}\n`);
    const report = computeReport(root);
    expect(report.staleMustTest).toEqual([id('LIF', 777)]);
    expect(report.missingFromMustTest).toContain(must);
  });

  it('[TST-002] the committed must-test.txt matches docs/spec', () => {
    const report = computeReport(repoRoot);
    expect(report.missingFromMustTest).toEqual([]);
    expect(report.staleMustTest).toEqual([]);
    expect(readMustTest(join(repoRoot, 'must-test.txt')).length).toBeGreaterThan(50);
  });

  it('[TST-002] the CLI runs in report-only mode against the repository and exits 0', () => {
    const run = spawnSync(process.execPath, [join(repoRoot, 'tools/spec-coverage.ts')], {
      encoding: 'utf8',
      env: { ...process.env, SPEC_COVERAGE_STRICT: '' },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('requirement IDs referenced by a test');
  });

  it('[TST-002] strict mode passes against the repository: no must-test gaps (CI gate, T-097)', () => {
    const run = spawnSync(
      process.execPath,
      [join(repoRoot, 'tools/spec-coverage.ts'), '--strict'],
      {
        encoding: 'utf8',
      },
    );
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('[TST-002] counts only IDs in titles of running it/test/describe calls', () => {
    const a = id('LIF', 1);
    const b = id('LIF', 2);
    const c = id('LIF', 3);
    const d = id('LIF', 4);
    const e = id('LIF', 5);
    const f = id('LIF', 6);
    const g = id('LIF', 7);
    const src = [
      `// ${a} in a comment`,
      `const s = '${a} in a plain string';`,
      `it('[${b}] runs', () => {});`,
      `it.skip('[${c}] skipped', () => {});`,
      `it.todo('[${c}] todo');`,
      `describe('[${d}] group', () => { it('inner', () => {}); });`,
      `describe('[${id('LIF', 8)}] empty group', () => {});`,
      `it.each\`a\`('[${id('LIF', 9)}] tagged table', () => {});`,
      `test.each([1, 2])('[${e}] each %s', () => {});`,
      `it.only(\`[${f}] template \${x}\`, () => {});`,
      `it.skipIf(cond)('[${g}] conditional', () => {});`,
    ].join('\n');
    expect(extractTestTitleIds(src).sort()).toEqual([b, d, e, f, id('LIF', 9)]);
  });

  it('[TST-002] reads .test.tsx files', () => {
    const { root, must } = world();
    write(root, 'apps/web/src/a.test.tsx', `it('[${must}] renders', () => {});\n`);
    expect(computeReport(root).uncovered).not.toContain(must);
  });

  it('[TST-002] only files that the test globs would run count', () => {
    const root = mkdtempSync(join(tmpdir(), 'gm-spec-'));
    cleanup.push(root);
    const ran = id('LIF', 21);
    const never = id('LIF', 22);
    const inCoverageDir = id('LIF', 23);
    const inDist = id('LIF', 24);
    const inFixtures = id('LIF', 25);
    write(root, 'docs/spec/a.md', [ran, never, inCoverageDir, inDist, inFixtures].join(' '));
    const t = (x: string) => `it('[${x}] t', () => {});\n`;
    write(root, 'packages/guidance/package.json', '{}');
    write(root, 'packages/guidance/src/a.test.ts', t(ran));
    write(root, 'packages/guidance/test/b.test.ts', t(never)); // outside src: never runs
    write(root, 'packages/guidance/src/c.spec.ts', t(never)); // not a unit-test name
    write(root, 'packages/guidance/src/coverage/x.test.ts', t(inCoverageDir)); // source dir, counts
    write(root, 'packages/guidance/dist/y.test.ts', t(inDist)); // build output, does not count
    write(root, 'packages/guidance/src/__fixtures__/z.test.ts', t(inFixtures));
    const report = computeReport(root);
    expect(report.uncovered.sort()).toEqual([never, inDist, inFixtures].sort());
  });

  it('[TST-002] strict mode fails closed on missing inputs; bare --root exits 2 in every mode', () => {
    const { root } = world();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(main(['--root', root, '--strict'], {})).toBe(2); // no must-test.txt
    write(root, 'must-test.txt', '# only comments\n');
    expect(main(['--root', root, '--strict'], {})).toBe(2); // empty
    expect(main(['--root', join(root, 'nope'), '--strict'], {})).toBe(2);
    expect(main(['--root'], {})).toBe(2);
    expect(main(['--root', '--strict'], {})).toBe(2);
    expect(main(['--root'], { SPEC_COVERAGE_STRICT: '' })).toBe(2);
  });

  it('[TST-002] strict mode fails on a stale or incomplete must-test.txt', () => {
    const root = mkdtempSync(join(tmpdir(), 'gm-spec-'));
    cleanup.push(root);
    const covered = id('LIF', 31);
    write(root, 'docs/spec/a.md', `${covered} ${id('LIF', 32)}\n`);
    write(root, 'packages/x/src/x.test.ts', `it('[${covered}] x', () => {});\n`);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    write(root, 'must-test.txt', `${covered}\n`); // incomplete
    expect(main(['--root', root, '--strict'], {})).toBe(1);
    expect(main(['--root', root], {})).toBe(0);
    write(root, 'must-test.txt', `${covered}\n${id('LIF', 99)}\n`); // stale
    expect(main(['--root', root, '--strict'], {})).toBe(1);
  });

  it('[TST-002] counts titles of names assigned from test.extend and Playwright groups', () => {
    const a = id('LIF', 41);
    const b = id('LIF', 42);
    const c = id('LIF', 43);
    const src = [
      'const t = test.extend({});',
      'const u = t.extend({});',
      `t('[${a}] extended', () => {});`,
      `u.skip('[${b}] skipped', () => {});`,
      `test.describe('[${c}] group', () => { t('inner', () => {}); });`,
    ].join('\n');
    expect(extractTestTitleIds(src).sort()).toEqual([a, c]);
  });

  it('[TST-002] a file with a syntax error contributes no IDs', () => {
    expect(extractTestTitleIds(`it('[${id('LIF', 51)}] x', () => {`)).toEqual([]);
  });

  it('[TST-002] nothing inside a skipped, todo or fixme call counts', () => {
    const n = (k: number) => id('LIF', 60 + k);
    const cases: [string, boolean][] = [
      [`describe.skip('g', () => { it('[${n(1)}] a', () => {}); });`, false],
      [`describe.skipIf(true)('g', () => { it('[${n(2)}] a', () => {}); });`, false],
      [`test.describe.skip('g', () => { test('[${n(3)}] a', () => {}); });`, false],
      [`it.skip('t', () => { it('[${n(4)}] a', () => {}); });`, false],
      [`test.fixme('[${n(5)}] a', () => {});`, false],
      [`describe.todo('[${n(6)}] a');`, false],
      [
        `describe('g', () => { describe.skip('h', () => { it('[${n(7)}] a', () => {}); }); });`,
        false,
      ],
      [`describe('[${n(8)}] g', () => { it('[${n(9)}] a', () => {}); });`, true],
      [`test.skip(true, 'reason'); test('[${n(10)}] a', () => {});`, true],
    ];
    for (const [src, counted] of cases) {
      const found = extractTestTitleIds(src);
      expect(found.length > 0, src).toBe(counted);
    }
    expect(extractTestTitleIds(cases[7]?.[0] as string).sort()).toEqual([n(8), n(9)]);
  });

  it('[TST-002] import aliases of test/it/describe are recognised, also with extend', () => {
    const a = id('LIF', 71);
    const b = id('LIF', 72);
    const c = id('LIF', 73);
    const src = [
      "import { test as base, describe as group } from 'vitest';",
      'const t = base.extend({});',
      `t('[${a}] x', () => {});`,
      `base('[${b}] y', () => {});`,
      `group('[${c}] g', () => { t('z', () => {}); });`,
    ].join('\n');
    expect(extractTestTitleIds(src).sort()).toEqual([a, b, c]);
  });
});
