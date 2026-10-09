import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

/**
 * Playwright wants the Chromium build that matches its own version. Sandboxes with a pre-installed
 * browser (PLAYWRIGHT_BROWSERS_PATH) can hold an older build, so use that one instead of failing
 * on a missing download. `GM_CHROMIUM_PATH` overrides both. Never calls `playwright install`.
 */
export function chromiumPath(): string | undefined {
  const explicit = process.env.GM_CHROMIUM_PATH;
  if (explicit) return explicit;
  if (existsSync(chromium.executablePath())) return undefined;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  return readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort()
    .reverse()
    .map((name) => join(root, name, 'chrome-linux', 'chrome'))
    .find((path) => existsSync(path));
}
