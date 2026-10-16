/**
 * Choosing a pre-installed Chromium for Playwright (harness/chromium.ts). Pure, so the choice is
 * unit-tested without a browser.
 */

/** The revision in a `chromium-NNNN` folder name or in a path that contains one. */
export function chromiumRevision(nameOrPath: string): number | undefined {
  const match = /(?:^|[\\/])chromium-(\d+)(?:[\\/]|$)/.exec(nameOrPath);
  return match ? Number(match[1]) : undefined;
}

/**
 * The `chromium-NNNN` folders of a browsers directory, newest revision first. Revisions are
 * compared as numbers: `chromium-999` is older than `chromium-1000`, which a text sort gets wrong.
 * Headless-shell and other folders are left out.
 */
export function chromiumBuilds(names: readonly string[]): string[] {
  return names
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => (chromiumRevision(b) ?? 0) - (chromiumRevision(a) ?? 0));
}

/** The note printed when the fallback build is not the one Playwright expects. */
export function fallbackNote(expectedPath: string, chosenPath: string): string | undefined {
  const expected = chromiumRevision(expectedPath);
  const chosen = chromiumRevision(chosenPath);
  if (expected === undefined || chosen === undefined || expected === chosen) return undefined;
  return `Playwright expects Chromium ${expected}, which is not installed; using ${chosen} from PLAYWRIGHT_BROWSERS_PATH. Screenshots can differ from the baselines in anti-aliasing. Set GM_CHROMIUM_PATH to choose a build.`;
}
