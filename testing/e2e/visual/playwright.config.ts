import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, defineConfig } from '@playwright/test';

const PORT = 3917;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Playwright wants the Chromium build that matches its own version. Sandboxes with a pre-installed
 * browser (PLAYWRIGHT_BROWSERS_PATH) can hold an older build, so use that one instead of failing
 * on a missing download. `GM_CHROMIUM_PATH` overrides both. Never calls `playwright install`.
 */
function chromiumPath(): string | undefined {
  const explicit = process.env.GM_CHROMIUM_PATH;
  if (explicit) return explicit;
  if (existsSync(chromium.executablePath())) return undefined;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  const found = readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort()
    .reverse()
    .map((name) => join(root, name, 'chrome-linux', 'chrome'))
    .find((path) => existsSync(path));
  return found;
}

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
