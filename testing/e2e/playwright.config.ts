import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { chromiumPath } from './harness/chromium.ts';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The UI e2e tier with fakes (TST-021). `harness/global-setup.ts` starts the built web app, the
 * worker, a throw-away database and the provider fakes once; the specs share that stack, so they
 * run one after another and each uses its own repository of the fixture world. Run
 * `pnpm test:e2e`, which builds the web app first.
 */
export default defineConfig({
  testDir: here,
  testMatch: '*.spec.ts',
  // The visual regression suite and the live suite have their own configurations.
  testIgnore: ['visual/**', 'live/**'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 180_000,
  expect: { timeout: 30_000 },
  globalSetup: join(here, 'harness/global-setup.ts'),
  use: {
    // The stack picks a free port, so the specs read the base URL from the environment.
    baseURL: process.env.GM_E2E_BASE_URL,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    // Off: the specs share one context per scenario and trace it by hand (see the spec).
    trace: 'off',
    launchOptions: { executablePath: chromiumPath() },
  },
});
