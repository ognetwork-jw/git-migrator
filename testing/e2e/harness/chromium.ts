import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { chromiumBuilds, fallbackNote } from '../src/chromium.ts';

let noted = false;

/**
 * Playwright wants the Chromium build that matches its own version. Sandboxes with a pre-installed
 * browser (PLAYWRIGHT_BROWSERS_PATH) can hold an older build, so use the newest one there instead
 * of failing on a missing download, and say so on stderr. `GM_CHROMIUM_PATH` overrides both.
 * Never calls `playwright install`.
 */
export function chromiumPath(): string | undefined {
  const explicit = process.env.GM_CHROMIUM_PATH;
  if (explicit) return explicit;
  const expected = chromium.executablePath();
  if (existsSync(expected)) return undefined;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  const chosen = chromiumBuilds(readdirSync(root))
    .map((name) => join(root, name, 'chrome-linux', 'chrome'))
    .find((path) => existsSync(path));
  const note = chosen === undefined ? undefined : fallbackNote(expected, chosen);
  if (note !== undefined && !noted) {
    noted = true;
    process.stderr.write(`${note}\n`);
  }
  return chosen;
}
