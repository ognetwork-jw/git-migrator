/**
 * TST-002: lists requirement IDs from docs/spec that no test references.
 *
 * "Referenced" means the ID appears in the title of a running it/test call, or of a describe that
 * contains a running test, in a file that the test globs of tools/test-globs.ts would run.
 *
 * Usage: node tools/spec-coverage.ts [--root <dir>] [--strict] [--generate]
 *   (default)  report only, always exit 0 (see docs/adr/0029-spec-coverage-modes.md)
 *   --strict   exit 1 if any ID listed in must-test.txt has no referencing test, or if
 *              must-test.txt is stale/incomplete; exit 2 if must-test.txt is missing or empty or the
 *              root has no docs/spec (also enabled by SPEC_COVERAGE_STRICT=1)
 * A bare --root exits 2 in every mode.
 *   --generate rewrite must-test.txt from docs/spec
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Node, parse, stringValue, walk as walkAst } from './ast.ts';
import { BUILD_OUTPUT_DIRS, isTestPath } from './test-globs.ts';

/** Prefixes of requirement IDs used in docs/spec. */
export const ID_PREFIXES = [
  'ADP',
  'API',
  'ARC',
  'AUTH',
  'DATA',
  'DEP',
  'DEV',
  'DOM',
  'FAC',
  'GLO',
  'JOB',
  'LIF',
  'PROC',
  'TST',
  'UI',
];

const ID_RE = new RegExp(`\\b(?:${ID_PREFIXES.join('|')})(?:-[A-Z]{2,5})*-\\d{3}\\b`, 'g');
const MUST_TEST_RE = /^(?:LIF-\d{3}|FAC(?:-[A-Z]{2,5})*-\d{3}|JOB-04\d|AUTH-0\d\d)$/;
/** The work breakdown only references IDs (including ranges); it does not define them. */
const SPEC_EXCLUDE = new Set(['15-work-breakdown.md']);

export const MUST_TEST_FILE = 'must-test.txt';

export function extractIds(text: string): string[] {
  return [...new Set(text.match(ID_RE) ?? [])];
}

export function isMustTest(id: string): boolean {
  return MUST_TEST_RE.test(id);
}

const ALWAYS_SKIP = new Set(['node_modules', '__fixtures__', '.git', '.worktrees']);
/** Build output, skipped only directly inside a package (a `src/coverage` directory is source). */
const BUILD_DIRS = BUILD_OUTPUT_DIRS;

function* walk(dir: string, accept: (rel: string) => boolean, rel = ''): Generator<string> {
  if (!existsSync(dir)) return;
  const isPackageRoot = existsSync(join(dir, 'package.json'));
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (ALWAYS_SKIP.has(entry.name) || (isPackageRoot && BUILD_DIRS.has(entry.name))) continue;
      yield* walk(join(dir, entry.name), accept, childRel);
    } else if (accept(childRel)) {
      yield join(dir, entry.name);
    }
  }
}

export function collectSpecIds(root: string): string[] {
  const ids = new Set<string>();
  for (const file of walk(join(root, 'docs', 'spec'), (n) => n.endsWith('.md'))) {
    if (SPEC_EXCLUDE.has(file.split(/[\\/]/).pop() ?? '')) continue;
    for (const id of extractIds(readFileSync(file, 'utf8'))) ids.add(id);
  }
  return [...ids].sort();
}

const TEST_CALLS = new Set(['it', 'test']);
const GROUP_CALLS = new Set(['describe', 'suite']);
/** Modifiers after which the test does not run (or runs conditionally), so it proves nothing. */
const INERT_MODIFIERS = new Set(['skip', 'todo', 'fixme', 'skipIf', 'runIf', 'fails']);

interface TitleCall {
  group: boolean;
  inert: boolean;
  start: number;
  end: number;
  ids: string[];
}

/** `it.skip.each(x)` and friends: the root identifier, the modifier names and whether `.each` was used. */
function callChain(callee: Node): { root: string; modifiers: string[]; each: boolean } | undefined {
  const modifiers: string[] = [];
  let each = false;
  let node: Node | undefined = callee;
  while (node) {
    if (node.type === 'MemberExpression' && node.property?.type === 'Identifier') {
      modifiers.unshift(node.property.name as string);
      node = node.object;
    } else if (node.type === 'CallExpression') {
      node = node.callee; // it.each(table)
    } else if (node.type === 'TaggedTemplateExpression') {
      node = node.tag; // it.each`table`
    } else if (node.type === 'Identifier') {
      each = modifiers.includes('each');
      return { root: node.name as string, modifiers, each };
    } else return undefined;
  }
  return undefined;
}

/**
 * IDs named in the titles of running tests (TST-002): `it`/`test` calls, and `describe` calls that
 * contain at least one running test. Comments, other strings, `.skip`, `.todo`, `.fixme` and conditional
 * variants do not count, nor does anything nested inside such a call. `.each(table)('title')`, ``.each`table`('title')`` and names assigned from
 * `test.extend(…)` are supported. The source is parsed; a syntax error yields no IDs.
 */
export function extractTestTitleIds(source: string, filename = 'file.ts'): string[] {
  const { program, ok } = parse(source, filename);
  if (!ok) return [];
  const testNames = new Set(TEST_CALLS);
  const groupNames = new Set(GROUP_CALLS);
  // Aliases: `import { test as t }`, then `const u = t.extend({ … })`, also chained.
  walkAst(program, (n) => {
    if (n.type !== 'ImportDeclaration') return;
    for (const spec of (n.specifiers ?? []) as Node[]) {
      const imported = spec.imported?.name ?? spec.imported?.value;
      if (spec.type !== 'ImportSpecifier' || !spec.local?.name) continue;
      if (TEST_CALLS.has(imported)) testNames.add(spec.local.name as string);
      if (GROUP_CALLS.has(imported)) groupNames.add(spec.local.name as string);
    }
  });
  let changed = true;
  while (changed) {
    changed = false;
    walkAst(program, (n) => {
      if (
        n.type !== 'VariableDeclarator' ||
        n.id?.type !== 'Identifier' ||
        n.init?.type !== 'CallExpression'
      )
        return;
      const chain = callChain(n.init.callee as Node);
      if (!chain?.modifiers.includes('extend')) return;
      if (testNames.has(chain.root) && !testNames.has(n.id.name)) {
        testNames.add(n.id.name as string);
        changed = true;
      }
    });
  }
  const calls: TitleCall[] = [];
  walkAst(program, (n) => {
    if (n.type !== 'CallExpression') return;
    const chain = callChain(n.callee as Node);
    if (!chain) return;
    // Playwright's `test.describe(...)` is a group.
    const group =
      groupNames.has(chain.root) ||
      (testNames.has(chain.root) && chain.modifiers[0] === 'describe');
    if (!group && !testNames.has(chain.root)) return;
    const inert = chain.modifiers.some((m) => INERT_MODIFIERS.has(m));
    // For `.each(table)(title)` the call node is the outer one; skip the inner `.each(table)` call.
    if (
      chain.modifiers[chain.modifiers.length - 1] === 'each' &&
      n.callee.type === 'MemberExpression'
    )
      return;
    const title = stringValue(n.arguments?.[0] as Node | undefined);
    if (!title) return;
    calls.push({ group, inert, start: n.start, end: n.end, ids: extractIds(title.value) });
  });
  // Anything inside a skipped/todo/fixme call never runs, whatever its own modifiers say.
  const inertCalls = calls.filter((c) => c.inert);
  const live = calls.filter(
    (c) => !c.inert && !inertCalls.some((i) => i.start < c.start && c.end < i.end),
  );
  const running = live.filter((c) => !c.group);
  const ids = new Set<string>();
  for (const call of live) {
    const counts = !call.group || running.some((t) => t.start > call.start && t.end < call.end);
    if (counts) for (const id of call.ids) ids.add(id);
  }
  return [...ids];
}

export function collectTestIds(root: string): Set<string> {
  const ids = new Set<string>();
  for (const top of ['apps', 'packages', 'testing', 'tools']) {
    for (const file of walk(join(root, top), (rel) => isTestPath(`${top}/${rel}`))) {
      for (const id of extractTestTitleIds(readFileSync(file, 'utf8'), file)) ids.add(id);
    }
  }
  return ids;
}

export function renderMustTest(specIds: readonly string[]): string {
  const header = [
    '# Requirement IDs that MUST be referenced by a test (TST-002).',
    '# Generated by `node tools/spec-coverage.ts --generate`: every LIF, FAC, JOB-04x and AUTH-0xx ID in docs/spec.',
    '# `pnpm spec:coverage -- --strict` fails when one of these has no referencing test.',
  ];
  return `${[...header, ...specIds.filter(isMustTest)].join('\n')}\n`;
}

export function readMustTest(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

export interface CoverageReport {
  specIds: string[];
  uncovered: string[];
  uncoveredMustTest: string[];
  /** IDs in must-test.txt that no longer appear in docs/spec (stale list). */
  staleMustTest: string[];
  /** IDs that docs/spec requires to be listed in must-test.txt but are not. */
  missingFromMustTest: string[];
}

export function computeReport(root: string): CoverageReport {
  const specIds = collectSpecIds(root);
  const tested = collectTestIds(root);
  const mustTest = readMustTest(join(root, MUST_TEST_FILE));
  const specSet = new Set(specIds);
  const mustSet = new Set(mustTest);
  const uncovered = specIds.filter((id) => !tested.has(id));
  return {
    specIds,
    uncovered,
    uncoveredMustTest: mustTest.filter((id) => !tested.has(id)),
    staleMustTest: mustTest.filter((id) => !specSet.has(id)),
    missingFromMustTest: specIds.filter((id) => isMustTest(id) && !mustSet.has(id)),
  };
}

export function main(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): number {
  const rootFlag = argv.indexOf('--root');
  if (rootFlag >= 0 && (argv[rootFlag + 1] === undefined || argv[rootFlag + 1]?.startsWith('--'))) {
    console.error('spec-coverage: --root needs a directory');
    return 2;
  }
  const root = resolve(
    rootFlag >= 0
      ? (argv[rootFlag + 1] as string)
      : join(dirname(fileURLToPath(import.meta.url)), '..'),
  );
  const strict = argv.includes('--strict') || env.SPEC_COVERAGE_STRICT === '1';
  const specDir = join(root, 'docs', 'spec');
  if (!existsSync(root) || !existsSync(specDir)) {
    console.error(`spec-coverage: ${specDir} not found`);
    return strict || argv.includes('--generate') ? 2 : 0;
  }
  if (argv.includes('--generate')) {
    const text = renderMustTest(collectSpecIds(root));
    writeFileSync(join(root, MUST_TEST_FILE), text);
    console.log(`spec-coverage: wrote ${MUST_TEST_FILE} (${text.split('\n').length - 4} IDs)`);
    return 0;
  }
  const mustTestFile = join(root, MUST_TEST_FILE);
  if (strict && readMustTest(mustTestFile).length === 0) {
    console.error(`spec-coverage: ${MUST_TEST_FILE} is missing or empty; run --generate`);
    return 2;
  }
  const report = computeReport(root);
  const mustSet = new Set(readMustTest(mustTestFile));
  console.log(
    `spec-coverage: ${report.specIds.length - report.uncovered.length}/${report.specIds.length} requirement IDs referenced by a test`,
  );
  if (report.uncovered.length > 0) {
    console.log('IDs without a referencing test (* = must-test):');
    for (const id of report.uncovered) console.log(`  ${mustSet.has(id) ? '*' : ' '} ${id}`);
  }
  const level = strict ? console.error : console.warn;
  for (const id of report.staleMustTest)
    level(`${strict ? 'error' : 'warning'}: ${id} is in ${MUST_TEST_FILE} but not in docs/spec`);
  for (const id of report.missingFromMustTest)
    level(
      `${strict ? 'error' : 'warning'}: ${id} is in docs/spec but not in ${MUST_TEST_FILE} (run --generate)`,
    );
  if (report.uncoveredMustTest.length > 0)
    console.log(
      `${report.uncoveredMustTest.length} must-test ID(s) uncovered${strict ? '' : ' (report-only mode; pass --strict to fail)'}`,
    );
  if (
    strict &&
    (report.uncoveredMustTest.length > 0 ||
      report.staleMustTest.length > 0 ||
      report.missingFromMustTest.length > 0)
  )
    return 1;
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
