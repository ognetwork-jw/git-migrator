import { configDefaults, defineConfig } from 'vitest/config';
import { INTEGRATION_INCLUDE, INTEGRATION_ONLY, UNIT_INCLUDE } from './tools/test-globs.ts';

/**
 * Unit tier (TST-001). Per-package coverage thresholds follow TST-005 and are expressed as glob
 * thresholds, so each package is measured on its own sources. See docs/adr/0030-coverage-placeholders.md.
 */
const lines80 = { lines: 80 };
const apps = { lines: 60 };
const pure = { lines: 90, branches: 90 };

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'unit',
          include: UNIT_INCLUDE,
          // The Phase-1 scenario is slow and runs only in the integration project (ADR-0475).
          exclude: [...configDefaults.exclude, ...INTEGRATION_ONLY],
        },
      },
      {
        // TST-001: API + worker + Postgres + provider fakes. Each file creates its own database
        // and fakes on free ports, so files may run side by side; the scenarios are slow.
        test: {
          name: 'integration',
          include: INTEGRATION_INCLUDE,
          testTimeout: 120_000,
          hookTimeout: 180_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // Stable for CI; set VITEST_COVERAGE_DIR to run two coverage runs in one worktree at once.
      // biome-ignore lint/suspicious/noUndeclaredEnvVars: local override only; not a turbo task input
      reportsDirectory: process.env.VITEST_COVERAGE_DIR ?? './coverage',
      reporter: ['text-summary', 'lcov'],
      // Keep .tsx in every glob: apps/web and packages/api contain React/JSX sources (TST-005).
      include: [
        'apps/*/src/**/*.{ts,tsx,mts}',
        'packages/**/src/**/*.{ts,tsx,mts}',
        'testing/*/src/**/*.{ts,tsx,mts}',
        'tools/*.ts',
      ],
      exclude: [
        '**/*.test.{ts,tsx,mts}',
        '**/*.d.ts',
        '**/*.child.ts',
        '**/*.fixture.ts',
        'packages/db/src/generated/**',
        'apps/worker/src/db-cli.ts',
      ],
      thresholds: {
        'packages/core/src/**': pure,
        'packages/facets/src/**': pure,
        'packages/quota/src/**': lines80,
        'packages/git/src/**': lines80,
        'packages/adapters/*/src/**': lines80,
        'packages/api/src/**': lines80,
        'packages/jobs/src/**': lines80,
        'apps/*/src/**': apps,
      },
    },
  },
});
