import { expect, type Page } from '@playwright/test';
import { TEST_PASSWORD } from './constants.ts';

/** Signs in through the test form of the sign-in page (AUTH-012) and waits for the shell. */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/signin');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/signin'));
}

interface LiveProbe {
  noReload?: boolean;
  polled?: boolean;
}

/**
 * Starts watching the page's live connection (UI-001 status tag, `data-live-mode`). It waits until
 * the connection is `sse`, then plants a marker that a reload would lose and an observer that
 * records any switch to the `polling` fallback. Call it before the action whose result must arrive
 * over SSE, and `expectLiveStayedSse` after the result showed.
 */
export async function watchLive(page: Page): Promise<void> {
  await expect(page.locator('[data-live-mode="sse"]')).toBeVisible();
  await page.evaluate(() => {
    const probe = window as unknown as { __live: LiveProbe };
    probe.__live = { noReload: true, polled: false };
    const polling = '[data-live-mode="polling"]';
    // Inspect what each record touched, so a `polling` that is replaced within the same task is
    // still seen.
    const inspect = (records: MutationRecord[]) => {
      for (const record of records) {
        const target = record.target as Element;
        if (record.type === 'attributes' && target.getAttribute('data-live-mode') === 'polling') {
          probe.__live.polled = true;
        }
        for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches(polling) || node.querySelector(polling))) {
            probe.__live.polled = true;
          }
        }
      }
    };
    new MutationObserver(inspect).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-live-mode'],
    });
    if (document.querySelector(polling)) probe.__live.polled = true;
  });
}

/** The page was not reloaded since `watchLive`, and its connection never fell back to polling. */
export async function expectLiveStayedSse(page: Page): Promise<void> {
  const probe = await page.evaluate(() => (window as unknown as { __live?: LiveProbe }).__live);
  expect(probe, 'watchLive ran on this page and the page was not reloaded').toEqual({
    noReload: true,
    polled: false,
  });
  await expect(page.locator('[data-live-mode="sse"]')).toBeVisible();
}
