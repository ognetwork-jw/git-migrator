import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { chromiumPath } from '../harness/chromium.ts';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The visual regression suite of the web shell (T-080, UI-001, UI-010, UI-036). Pages are gated on
 * the server (AUTH-021, ADR-0321), so it runs against the same stack as the UI e2e tier
 * (`harness/global-setup.ts`: the production build on a free port, a throw-away database and the
 * provider fakes; `pnpm test:visual` builds the web app first). The specs sign in for real and then
 * mock `GET /api/v1/me` in the browser to show each role; nothing reaches a provider (TST-006).
 */
export default defineConfig({
  testDir: here,
  testMatch: '*.spec.ts',
  // Baselines are for Linux (CI and the sandbox); one folder, no platform suffix.
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  globalSetup: join(here, '../harness/global-setup.ts'),
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      // Anti-aliasing differs a little between Chromium builds; layout regressions do not. What a
      // screenshot must contain (nav items, header) is asserted in the DOM as well, because one
      // missing item is a small share of the pixels.
      maxDiffPixelRatio: 0.001,
    },
  },
  use: {
    // The stack picks a free port, so the specs read the base URL from the environment.
    baseURL: process.env.GM_E2E_BASE_URL,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    launchOptions: { executablePath: chromiumPath() },
  },
});
