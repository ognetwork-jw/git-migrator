/**
 * T-083, TST-021: the Phase-1 flow (TST-020) through the browser, against the production build of
 * the web app, the real API and worker, Postgres and the provider fakes (`harness/stack.ts`,
 * ADR-0485). The steps are one ordered scenario: each `test.step` is a numbered step of TST-021.
 */
import { type BrowserContext, expect, type Page, type Response, test } from '@playwright/test';
import { expectLiveStayedSse, signIn, watchLive } from './harness/ui.ts';

const OPERATOR = 'operator@test.local';
const AUTO_OK = 'plat/auto-ok';

/** The number a dashboard Statistic shows under its title, or 0 when the title is not there. */
async function statistic(page: Page, title: string): Promise<number> {
  const card = page.locator('.ant-statistic', {
    has: page.getByRole('link', { name: title, exact: true }),
  });
  if ((await card.count()) === 0) return 0;
  return Number((await card.first().locator('.ant-statistic-content-value').innerText()).trim());
}

/** Reloads the dashboard and reads a count once it has loaded. */
async function freshStatistic(page: Page, title: string): Promise<number> {
  await page.reload();
  await page.getByRole('region', { name: 'By status' }).waitFor();
  return statistic(page, title);
}

/**
 * Records every distinct text of the Status cell of a Run page from now on, across soft
 * navigations (the page is never reloaded). The Run page's status arrives over SSE; this proves
 * which states the page showed, in order.
 */
async function recordRunStatuses(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __runStatuses: string[] }).__runStatuses = seen;
    const scan = () => {
      for (const th of document.querySelectorAll('tbody th')) {
        if (th.textContent?.trim() !== 'Status') continue;
        const text = th.nextElementSibling?.textContent?.trim();
        if (text && seen[seen.length - 1] !== text) seen.push(text);
      }
    };
    new MutationObserver(scan).observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    scan();
  });
}

/**
 * Wraps `EventSource` before any page script runs, so every `gm` event the live connection gets
 * is recorded (`window.__gm`). A page that was loaded, not updated, would record none.
 */
async function recordStreamEvents(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const events: Array<{ type?: string; ids?: Record<string, string> }> = [];
    (window as unknown as { __gm: typeof events }).__gm = events;
    const Native = window.EventSource;
    class Recording extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        this.addEventListener('gm', (event) => {
          try {
            events.push(JSON.parse((event as MessageEvent<string>).data));
          } catch {
            // not JSON: not an event of ours
          }
        });
      }
    }
    window.EventSource = Recording;
  });
}

const streamEvents = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __gm: Array<{ type?: string; ids?: Record<string, string> }> }).__gm,
  );

const runStatuses = (page: Page) =>
  page.evaluate(() => (window as unknown as { __runStatuses: string[] }).__runStatuses);

test('[TST-021] the Phase-1 flow: refresh, find auto-ok, migrate, watch the Run, verify', async ({
  context,
  page,
}, testInfo) => {
  // Traced by hand (the config sets `trace: 'off'`); kept only when the flow fails. Traces embed
  // what the page saw, so e2e credentials must stay fake (ADR-0485).
  await context.tracing.start({ screenshots: true, snapshots: true });
  await recordStreamEvents(context);
  const pageLog: string[] = [];
  page.on('console', (message) => pageLog.push(`console.${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => pageLog.push(`pageerror: ${error.message}`));
  const eventStreams: Response[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/api/v1/events')) eventStreams.push(response);
  });
  try {
    await runFlow(page, eventStreams);
  } catch (error) {
    await testInfo.attach('page-log', { body: pageLog.join('\n'), contentType: 'text/plain' });
    await testInfo
      .attach('failure', {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      })
      .catch(() => undefined);
    await context.tracing.stop({ path: testInfo.outputPath('trace.zip') });
    throw error;
  }
  await context.tracing.stop();
});

async function runFlow(page: Page, eventStreams: readonly Response[]): Promise<void> {
  await test.step('1. sign in with the test form', async () => {
    await signIn(page, OPERATOR);
    await expect(page.getByRole('heading', { name: 'Dashboard' }).first()).toBeVisible();
  });

  await test.step('2. click "Refresh inventory" and wait for the progress toast', async () => {
    const accepted = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/api/v1/inventory/refresh'),
    );
    await page.getByRole('button', { name: 'Refresh inventory' }).click();
    expect((await accepted).status()).toBe(202);
    await expect(page.getByText('Inventory refresh queued.')).toBeVisible();
  });

  const row = page.getByRole('row').filter({ hasText: AUTO_OK });
  await test.step('3. open Repositories (unmigrated by default) and see auto-ok Ready', async () => {
    await page.getByRole('link', { name: 'Repositories' }).first().click();
    await expect(page).toHaveURL(/\/repositories/);
    // The inventory jobs create the rows and the background feeder analyzes them. Migrations that
    // inventory creates send no live event (follow-up), so reload until the row is there.
    await expect(async () => {
      await page.reload();
      await expect(row).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000, intervals: [1_000] });
    await expect(row.getByText('Ready', { exact: true })).toBeVisible({ timeout: 90_000 });
  });

  // The counts are read once the inventory has settled: Total unchanged across two reads.
  let verifiedBefore = 0;
  let totalBefore = 0;
  await test.step('3b. read the dashboard counts once they are stable', async () => {
    // A full load: a Next `Link` click to the URL the page is already on does not navigate, and
    // the dashboard is read fresh anyway.
    await page.goto('/');
    let previous = -1;
    await expect
      .poll(
        async () => {
          const total = await freshStatistic(page, 'Total');
          const stable = total > 0 && total === previous;
          previous = total;
          return stable;
        },
        { intervals: [2_000], timeout: 60_000 },
      )
      .toBe(true);
    totalBefore = await statistic(page, 'Total');
    verifiedBefore = await statistic(page, 'Verified');
    await page.getByRole('link', { name: 'Repositories' }).first().click();
    await expect(row.getByText('Ready', { exact: true })).toBeVisible();
  });

  let eventsBeforeRun = 0;
  await test.step('4. click Migrate', async () => {
    // From here the page is never reloaded: the Run page must update through SSE alone.
    await watchLive(page);
    await recordRunStatuses(page);
    await row.getByRole('button', { name: 'Migrate' }).click();
    const started = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/migrations\/[^/]+\/runs$/.test(r.url()),
    );
    await page.getByRole('dialog').getByRole('button', { name: 'Migrate' }).click();
    expect((await started).status()).toBe(202);
    eventsBeforeRun = (await streamEvents(page)).length;
    await expect(page.getByText('Request accepted.')).toBeVisible();
  });

  await test.step('5. the Run page reaches Succeeded through SSE, without a reload', async () => {
    await row.getByRole('link', { name: /Migrate/ }).click();
    await expect(page).toHaveURL(/\/runs\//);
    const status = page.getByRole('row').filter({
      has: page.getByRole('rowheader', { name: 'Status', exact: true }),
    });
    await expect(status.getByRole('cell', { name: 'Succeeded', exact: true })).toBeVisible({
      timeout: 150_000,
    });
    await expectLiveStayedSse(page);
    // Delivery: the live connection received events for this Run after the Migrate 202 (the page
    // was updated, not loaded), and the stream answered as text/event-stream. The statuses the
    // page showed on the way are informational: a fast Run can skip the non-terminal ones.
    const runId = /\/runs\/([^/?#]+)/.exec(page.url())?.[1] ?? '';
    expect(runId).not.toBe('');
    const received = (await streamEvents(page)).slice(eventsBeforeRun);
    expect(
      received.filter((e) => e.type?.startsWith('run.') && e.ids?.run === runId).length,
      `stream events after the 202: ${JSON.stringify(received)}`,
    ).toBeGreaterThan(0);
    const seen = await runStatuses(page);
    console.log(`Run statuses shown: ${seen.join(' > ')}`);
    expect(seen[seen.length - 1]).toBe('Succeeded');
    const streams = eventStreams.filter(
      (r) =>
        r.status() === 200 && (r.headers()['content-type'] ?? '').includes('text/event-stream'),
    );
    expect(streams.length).toBeGreaterThan(0);
  });

  await test.step('6. the repository is Verified and the dashboard counts changed', async () => {
    await page.getByRole('link', { name: /^Back to / }).click();
    await expect(page).toHaveURL(/\/repositories\/[^/]+$/);
    // The Status cell of the detail header holds just the status tag's text.
    await expect(page.getByRole('cell', { name: 'Verified', exact: true })).toBeVisible({
      timeout: 60_000,
    });
    // A full load: a Next `Link` click to the URL the page is already on does not navigate, and
    // the dashboard is read fresh anyway.
    await page.goto('/');
    await expect.poll(() => freshStatistic(page, 'Verified')).toBe(verifiedBefore + 1);
    expect(await statistic(page, 'Total')).toBe(totalBefore);
  });
}
