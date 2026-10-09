import { defineConfig } from '@playwright/test';
import { chromiumPath } from '../harness/chromium.ts';

const PORT = 3917;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * The visual regression suite of the web shell (T-080, UI-001, UI-010, UI-036). It runs against
 * the production build (`pnpm test:visual` builds it first) with a mocked API: the page never
 * reaches a database or a provider (TST-006).
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  // Baselines are for Linux (CI and the sandbox); one folder, no platform suffix.
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      // Anti-aliasing differs a little between Chromium builds; layout regressions do not.
      maxDiffPixelRatio: 0.015,
    },
  },
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    launchOptions: { executablePath: chromiumPath() },
  },
  webServer: {
    command: 'pnpm --filter @git-migrator/web start',
    url: `${BASE_URL}/signin`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      HOST: '127.0.0.1',
      PORT: String(PORT),
      GM_AUTH_TEST_SIGN_IN_ENABLED: 'true',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
