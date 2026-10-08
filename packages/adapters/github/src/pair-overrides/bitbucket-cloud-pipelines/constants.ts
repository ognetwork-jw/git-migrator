// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these are workflow expressions, not templates
/**
 * Fixed tables of the bitbucket-cloud to github pipelines translation (FAC-PIP-002).
 * Decisions: docs/adr/0161-pipelines-translation-safety.md, 0162-pipelines-translation-structure.md.
 */

/**
 * Actions are pinned to full commit SHAs (a tag can be moved). The version is in the comment; the
 * SHAs were read from the public tags of each action's repository.
 */
export const ACTIONS = {
  checkout: {
    uses: 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
    version: 'v4.2.2',
  },
  cache: { uses: 'actions/cache@1bd1e32a3bdc45362d1e726936510720a7c30a57', version: 'v4.2.0' },
  uploadArtifact: {
    uses: 'actions/upload-artifact@65c4c4a1ddee5b72f698fdd19549f0f0fb45cf08',
    version: 'v4.6.0',
  },
  downloadArtifact: {
    uses: 'actions/download-artifact@fa0a91b85d4f404e444e00e005971372dc801d16',
    version: 'v4.1.8',
  },
} as const;

export const SOURCE_FILE = 'bitbucket-pipelines.yml';
export const RUNNER = 'ubuntu-latest';
export const WORKFLOW_DIR = '.github/workflows';

/** The kinds of workflow that a pipeline becomes (the trigger decides which variables exist). */
export type Trigger = 'default' | 'branch' | 'tag' | 'custom';

/** Source variables with a direct equivalent. Their values are passed through `env:`, never inlined. */
export const BUILT_IN_VARIABLES: Readonly<Record<string, string>> = {
  BITBUCKET_BRANCH: '${{ github.ref_name }}',
  BITBUCKET_TAG: '${{ github.ref_name }}',
  BITBUCKET_COMMIT: '${{ github.sha }}',
  BITBUCKET_BUILD_NUMBER: '${{ github.run_number }}',
  BITBUCKET_REPO_SLUG: '${{ github.event.repository.name }}',
  BITBUCKET_CLONE_DIR: '${{ github.workspace }}',
  BITBUCKET_PR_ID: '${{ github.event.pull_request.number }}',
  BITBUCKET_PR_DESTINATION_BRANCH: '${{ github.base_ref }}',
};

/** The default workflow also runs for pull requests, where the branch name is the head ref. */
const DEFAULT_BRANCH = '${{ github.head_ref || github.ref_name }}';

/**
 * The value of a built-in variable in a workflow with this trigger. `BITBUCKET_TAG` exists only in
 * tag workflows, `BITBUCKET_BRANCH` only in branch workflows and in the default workflow;
 * elsewhere it would hold a different kind of ref, so it is `'unset'`. Undefined: not a known name.
 */
export function builtInVariable(name: string, trigger: Trigger): string | 'unset' | undefined {
  if (!Object.hasOwn(BUILT_IN_VARIABLES, name)) return undefined;
  if (name === 'BITBUCKET_TAG') return trigger === 'tag' ? BUILT_IN_VARIABLES[name] : 'unset';
  if (name === 'BITBUCKET_BRANCH') {
    if (trigger === 'default') return DEFAULT_BRANCH;
    return trigger === 'branch' ? BUILT_IN_VARIABLES[name] : 'unset';
  }
  return BUILT_IN_VARIABLES[name];
}

/** Bounds (ADR-0161): a small file cannot make the translation allocate without limit. */
export const MAX_JOBS_PER_WORKFLOW = 50;
export const MAX_TOTAL_JOBS = 500;
export const MAX_TEXT_BUDGET = 4_000_000;
export const MAX_WORKFLOW_BYTES = 2_000_000;
export const MAX_REPORTS = 500;
/** Per list of one step (aliases can repeat a step, so every list is bounded on its own). */
export const MAX_LIST_ENTRIES = 200;
export const MAX_SCRIPT_ENTRIES = 1000;
export const MAX_CACHES_PER_STEP = 10;
export const MAX_SERVICES_PER_STEP = 10;
export const MAX_ARTIFACT_GLOBS = 20;
/** Patterns examined per `branches`, `tags` and `custom` section, and exclusions per workflow. */
export const MAX_PATTERNS = 100;
export const MAX_EXCLUSIONS = 100;
/** A workflow takes no further step once its estimated size passes this (below MAX_WORKFLOW_BYTES). */
export const WORKFLOW_ESTIMATE_LIMIT = 1_800_000;

export const DEPLOYMENT_VARIABLE = 'BITBUCKET_DEPLOYMENT_ENVIRONMENT';

/** Predefined caches: the path they hold and the lockfiles that key them. `docker` has no entry. */
export const PREDEFINED_CACHES: Readonly<
  Record<string, { readonly path: string; readonly files: readonly string[] }>
> = {
  node: {
    path: 'node_modules',
    files: ['**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml'],
  },
  pip: { path: '~/.cache/pip', files: ['**/requirements*.txt', '**/Pipfile.lock'] },
  maven: { path: '~/.m2/repository', files: ['**/pom.xml'] },
  gradle: {
    path: '~/.gradle/caches',
    files: ['**/*.gradle*', '**/gradle-wrapper.properties'],
  },
  composer: { path: '~/.composer/cache', files: ['**/composer.lock'] },
  dotnetcore: { path: '~/.nuget/packages', files: ['**/*.csproj', '**/packages.lock.json'] },
};
/** Dropped: the runner has Docker, so there is nothing to cache. */
export const DROPPED_CACHES: readonly string[] = ['docker'];

/** Key files of a custom cache that names none. */
export const DEFAULT_LOCKFILES: readonly string[] = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/requirements*.txt',
  '**/pom.xml',
  '**/composer.lock',
  '**/go.sum',
];

/**
 * A job on the runner reaches a service on localhost only through a published port, so the
 * well-known databases get theirs (a job in a container uses the service name instead).
 */
export const SERVICE_PORTS: Readonly<Record<string, number>> = {
  mysql: 3306,
  mariadb: 3306,
  postgres: 5432,
  redis: 6379,
  mongo: 27017,
  memcached: 11211,
  rabbitmq: 5672,
  elasticsearch: 9200,
};

export const REASONS = {
  generic: 'has no translation rule',
  pipe: 'pipes have no equivalent action',
  gated:
    'manual triggers and conditions have no equivalent; the step is not generated, so it never runs unconditionally',
  oidc: 'OIDC has no equivalent in the translated subset',
  runner: 'runner selection is not translated',
  stages: 'stages are not translated',
  pullRequests: 'pull request triggers filter by source branch, the target filters by base branch',
  variable: 'the variable has no equivalent',
  expression: 'it contains an expression delimiter, which would run as a workflow expression',
  unsafe: 'the value contains characters that are not translated safely',
  scriptEntry: 'only plain string script entries are translated',
  service: 'the service uses options that are not translated',
  afterGate: 'it follows a step that waits for approval, so it is not generated',
  tooMany: 'the file has more steps or script text than are translated',
  tooLarge: 'the generated workflow would be too large',
  moreUnsupported: 'more unsupported constructs than are listed',
  fileOrder:
    'the broader pattern is listed before the narrower one and the source may resolve the overlap by file order; confirm which pipeline should run',
  overlap: 'the pattern overlaps another one and which pipeline runs cannot be decided',
} as const;

/** Whether `pattern` matches `text` (`**` any characters, `*` any except `/`). O(n*m), no regex. */
export function globMatches(pattern: string, text: string): boolean {
  const tokens: string[] = [];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*') {
      if (pattern[i + 1] === '*') {
        tokens.push('any');
        i++;
      } else tokens.push('seg');
    } else tokens.push(`=${pattern[i]}`);
  }
  let row = new Array<boolean>(text.length + 1).fill(false);
  row[0] = true;
  for (const t of tokens) {
    const next = new Array<boolean>(text.length + 1).fill(false);
    if (t === 'any' || t === 'seg') next[0] = row[0] === true;
    for (let j = 1; j <= text.length; j++) {
      const ch = text[j - 1];
      if (t === 'any') next[j] = row[j] === true || next[j - 1] === true;
      else if (t === 'seg') next[j] = row[j] === true || (ch !== '/' && next[j - 1] === true);
      else next[j] = row[j - 1] === true && t === `=${ch}`;
    }
    row = next;
  }
  return row[text.length] === true;
}

const literalPrefix = (g: string) => g.slice(0, g.indexOf('*'));

/**
 * How two sibling globs relate: `covers` (every ref matching `h` also matches `g`, so `g` is the
 * broader one), `inside`, `disjoint`, or `unknown` when it is not decidable here.
 */
export function globRelation(g: string, h: string): 'covers' | 'inside' | 'disjoint' | 'unknown' {
  const gLiteral = !g.includes('*');
  const hLiteral = !h.includes('*');
  if (gLiteral && hLiteral) return 'disjoint';
  if (hLiteral) return globMatches(g, h) ? 'covers' : 'disjoint';
  if (gLiteral) return globMatches(h, g) ? 'inside' : 'disjoint';
  if (g === '**') return 'covers';
  if (h === '**') return 'inside';
  const pg = literalPrefix(g);
  const ph = literalPrefix(h);
  if (!pg.startsWith(ph) && !ph.startsWith(pg)) return 'disjoint';
  const tail = (x: string) => x.endsWith('/**') && x.indexOf('*') === x.length - 2;
  if (tail(g) && h.startsWith(g.slice(0, -2))) return 'covers';
  if (tail(h) && g.startsWith(h.slice(0, -2))) return 'inside';
  return 'unknown';
}
