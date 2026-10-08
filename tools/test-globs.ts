/**
 * Where tests live, per tier. vitest.config.ts uses UNIT_INCLUDE; `pnpm spec:coverage` counts a
 * requirement ID only from files that one of these globs would run, so a file that never runs
 * cannot "cover" anything. A task that adds a tier (integration, e2e) adds its globs here.
 */
const EXT = '{ts,tsx,mts}';

export const UNIT_INCLUDE = [
  `apps/*/src/**/*.test.${EXT}`,
  `packages/*/src/**/*.test.${EXT}`,
  `packages/adapters/*/src/**/*.test.${EXT}`,
  `testing/*/src/**/*.test.${EXT}`,
  'tools/*.test.ts',
];

/** Run by other tools/projects (integration tier, Playwright), not by the unit project. */
export const OTHER_TIER_INCLUDE = [
  `testing/integration/**/*.test.${EXT}`,
  `testing/e2e/**/*.spec.${EXT}`,
];

export const ALL_TEST_INCLUDE = [...UNIT_INCLUDE, ...OTHER_TIER_INCLUDE];

/** Converts a glob using `*`, `**` and `{a,b}` to a RegExp on forward-slash relative paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+?^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const compiled = ALL_TEST_INCLUDE.map(globToRegExp);

export function isTestPath(relPath: string): boolean {
  return compiled.some((r) => r.test(relPath));
}

/**
 * Build/test output directories, skipped only directly inside a package or app (a `src/coverage`
 * directory is source). Shared by check-deps and spec-coverage.
 */
export const BUILD_OUTPUT_DIRS: ReadonlySet<string> = new Set([
  'dist',
  'coverage',
  'out',
  'build',
  '.next',
  '.turbo',
  '.vercel',
  'storybook-static',
  'playwright-report',
  'test-results',
]);
