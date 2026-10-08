import { defineConfig } from 'vitest/config';
import { UNIT_INCLUDE } from './tools/test-globs.ts';

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
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      // Keep .tsx in every glob: apps/web and packages/api contain React/JSX sources (TST-005).
      include: [
        'apps/*/src/**/*.{ts,tsx,mts}',
        'packages/**/src/**/*.{ts,tsx,mts}',
        'testing/*/src/**/*.{ts,tsx,mts}',
        'tools/*.ts',
      ],
      exclude: ['**/*.test.{ts,tsx,mts}', '**/*.d.ts', 'tools/not-implemented.ts'],
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
