import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { chromiumPath } from '../harness/chromium.ts';

const here = dirname(fileURLToPath(import.meta.url));
// A live run's artefacts can hold real secrets: they go to their own directory (never uploaded).
const live = process.env.GM_E2E_TARGET === 'live';

/**
 * The live e2e (TST-030): the Phase-1 flow of `phase1.spec.ts` with the targets chosen by
 * `GM_E2E_TARGET`. `fakes` is the dry mode that CI runs (`pnpm test:e2e:live:dry`); `live` calls
 * real Bitbucket and GitHub test accounts, is started by a human with `pnpm test:e2e:live`, and
 * refuses to start in CI or when a precondition is unmet (`global-setup.ts`, TST-031). The main
 * configuration ignores this folder.
 */
export default defineConfig({
  testDir: here,
  testMatch: '*.live.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // Real providers are slow: the flow multiplies its own waits (`slow`), the test gets 30 minutes.
  timeout: 30 * 60_000,
  expect: { timeout: 30_000 },
  globalSetup: join(here, 'global-setup.ts'),
  outputDir: join(here, live ? '../live-artifacts/test-results' : '../test-results/live'),
  use: {
    baseURL: process.env.GM_E2E_BASE_URL,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    trace: 'off',
    launchOptions: { executablePath: chromiumPath() },
  },
});
