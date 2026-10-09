import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { expectLiveStayedSse, signIn, watchLive } from './harness/ui.ts';

/**
 * The second UI e2e spec of TST-021: the NeedsAttention flow. It runs against the built app, the
 * worker and the provider fakes started by `harness/global-setup.ts`; nothing here reaches a real
 * provider (TST-006).
 *
 * `data/unmapped-user` is the fixture repository that needs attention: its Analysis has the pre
 * task `access-control.unmapped-principal`, a `resolution` task that cannot be marked done by hand
 * (LIF-006). The flow opens the task list, runs the repository anyway, dismisses the task and
 * watches the status change. The steps are one ordered scenario sharing one signed-in page.
 *
 * "Complete a task" is covered by dismiss: the only task of this fixture is a resolution task,
 * which the server refuses to mark done (ADR-0485). LIF-043's strict options and typed
 * confirmation are covered at the API level by `packages/api/src/runs.test.ts` (T-074).
 */

const REPOSITORY = 'unmapped-user';
const TASK_CODE = 'access-control.unmapped-principal';

let page: Page;
/** The repository's detail page, remembered by the first steps for the later ones. */
let detailPath = '';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let failed = false;

test.beforeAll(async ({ browser }) => {
  // One context for the whole scenario, traced by hand because the test-scoped fixtures do not
  // reach a page shared by several tests.
  context = await browser.newContext();
  await context.tracing.start({ screenshots: true, snapshots: true });
  page = await context.newPage();
});

test.afterEach(async () => {
  const testInfo = test.info();
  if (testInfo.status === testInfo.expectedStatus) return;
  failed = true;
  try {
    await testInfo.attach('failure', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  } catch {
    // The page may be gone; the trace still holds the steps.
  }
});

test.afterAll(async () => {
  // Keep the trace only when a step failed, next to the other artifacts of the run.
  await context?.tracing.stop(failed ? { path: test.info().outputPath('scenario-trace.zip') } : {});
  await context?.close();
});

/** The Status cell of the detail header, which holds just the status tag's text. */
const statusCell = (label: string) => page.getByRole('cell', { name: label, exact: true });

test('[TST-021] [UI-022] signs in, refreshes the inventory and finds the repository listed as Needs attention', async () => {
  await signIn(page, 'operator@test.local');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh inventory' }).click();
  await expect(page.getByText('Inventory refresh queued.')).toBeVisible();

  await page.goto('/repositories');
  await page.getByPlaceholder('Search by name or path').fill(REPOSITORY);
  const row = page.getByRole('row', { name: new RegExp(REPOSITORY) });
  // The inventory runs in the background, and the first Analysis waits for the background feeder
  // unless the operator asks for it: reload until the row exists, then click its Analyze action.
  await expect(async () => {
    await page.reload();
    await page.getByPlaceholder('Search by name or path').fill(REPOSITORY);
    await expect(row).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000, intervals: [2_000] });
  // Wait for the request itself: a reload right after the click could cancel it.
  const analyzed = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/migrations\/[^/]+\/analyze$/.test(r.url()),
  );
  await row.getByRole('button', { name: 'Analyze' }).click();
  expect((await analyzed).status()).toBe(202);
  await expect(async () => {
    await page.reload();
    await page.getByPlaceholder('Search by name or path').fill(REPOSITORY);
    await expect(row.getByText('Needs attention')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 90_000, intervals: [2_000] });
  await row.getByRole('link').first().click();
  await page.waitForURL(/\/repositories\/[^/]+$/);
  detailPath = new URL(page.url()).pathname;
  await expect(page.getByRole('heading', { name: 'Repository' })).toBeVisible();
});

test('[TST-021] [UI-022] the Tasks tab lists the open pre task, and a resolution task cannot be marked done', async () => {
  await page.getByRole('tab', { name: /^Tasks/ }).click();
  await expect(page.getByText('1 of 1 tasks are open.')).toBeVisible();
  await expect(page.locator('.ant-collapse-header code', { hasText: TASK_CODE })).toBeVisible();
  await expect(page.locator('.ant-collapse-header').getByText('Before the run')).toBeVisible();

  // Guidance for the code is rendered inside the task (UI-040). A copy control appears only for
  // codes whose steps carry a value to copy; this one has none (ADR-0485).
  await expect(
    page
      .getByRole('tabpanel', { name: /^Tasks/ })
      .getByText('Open the identity mappings for this Route'),
  ).toBeVisible();

  // A note is saved with the task and survives a reload.
  await page
    .getByRole('textbox', { name: 'Note', exact: true })
    .fill('Asked the repository owner.');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByRole('button', { name: 'Save note' })).toBeDisabled();
  await page.reload();
  await page.getByRole('tab', { name: /^Tasks/ }).click();
  await expect(page.getByRole('textbox', { name: 'Note', exact: true })).toHaveValue(
    'Asked the repository owner.',
  );

  // [LIF-006] The task is resolved by an Identity Mapping, so the server refuses "done" (422) and
  // the page says so in its own words instead of changing the task.
  await page.getByRole('button', { name: 'Mark done' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'cannot be marked done by hand' }),
  ).toBeVisible();
  await expect(page.getByText('1 of 1 tasks are open.')).toBeVisible();
});

test('[TST-021] [LIF-043] Run anyway starts a Run that reaches Succeeded through SSE, leaving the pre task open', async () => {
  await page.getByRole('button', { name: 'Run anyway' }).click();
  const dialog = page.getByRole('dialog', { name: 'Run this repository anyway?' });
  await expect(dialog.getByText('1 open task will not be done by the Run.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Run anyway' }).click();
  await expect(page.getByText('The Run was queued.')).toBeVisible();

  // Evidence of delivery: the Run page opens the event stream, and the status then arrives on it.
  const stream = page.waitForResponse(
    (r) =>
      /\/api\/v1\/events/.test(r.url()) &&
      (r.headers()['content-type'] ?? '').includes('text/event-stream'),
  );
  await page.getByRole('link', { name: 'Open the Run' }).first().click();
  await page.waitForURL(/\/runs\/[^/]+$/);
  expect((await stream).status()).toBe(200);
  // The Run reaches its end over SSE: the connection is `sse` before the wait, never fell back to
  // polling, and the page was not reloaded.
  await watchLive(page);
  await expect(page.getByRole('row', { name: /^Kind .* Status Succeeded/ })).toBeVisible({
    timeout: 150_000,
  });
  await expectLiveStayedSse(page);
});

test('[TST-021] [LIF-006] the repository is Migrated with its task still open, and dismissing the task makes it Verified', async () => {
  await page.goto(detailPath);
  // Parity cannot be `equal` while a task is open (LIF-002): the Run leaves the Migration migrated.
  await expect(statusCell('Migrated')).toBeVisible();
  await page.getByRole('tab', { name: /^Tasks/ }).click();
  await expect(page.getByText('1 of 1 tasks are open.')).toBeVisible();

  await watchLive(page);
  await page.getByRole('button', { name: 'Dismiss' }).click();
  const dialog = page.getByRole('dialog', { name: 'Dismiss this task?' });
  // A resolution task is dismissed with a reason: "proceed without it" (LIF-006).
  await dialog.getByRole('textbox').fill('The unmapped principal is a retired account.');
  await dialog.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByText('0 of 1 tasks are open.')).toBeVisible();

  // The task change enqueues a Parity Check (LIF-062); its verdict moves the status over SSE,
  // without a reload of the page.
  await expect(statusCell('Verified')).toBeVisible({ timeout: 90_000 });
  await expectLiveStayedSse(page);

  // A dismissed task can be reopened (LIF-006) and dismissed again; the status stays Verified.
  await page.getByRole('button', { name: 'Reopen' }).click();
  await expect(page.getByText('1 of 1 tasks are open.')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss' }).click();
  const again = page.getByRole('dialog', { name: 'Dismiss this task?' });
  await again.getByRole('textbox').fill('Dismissed again after the check.');
  await again.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByText('0 of 1 tasks are open.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run anyway' })).toHaveCount(0);
});

test('[TST-021] [LIF-075] marking the repository complete by hand records the reason, and revoking it restores Verified', async () => {
  await page.getByRole('button', { name: 'Mark complete' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mark this repository complete?' });
  await dialog.getByRole('textbox').fill('Finished by hand: the retired account needs no mapping.');
  await dialog.getByRole('button', { name: 'Mark complete' }).click();
  await expect(statusCell('Manually completed')).toBeVisible();
  await expect(
    page.getByRole('cell', { name: /: Finished by hand: the retired account needs no mapping\./ }),
  ).toBeVisible();

  // Completing by hand does not close tasks (LIF-075): the dismissed task stays dismissed, and
  // revoking returns the computed status, which is Verified (parity equal, no task open).
  await page.getByRole('button', { name: 'Revoke completion' }).click();
  await page
    .getByRole('dialog', { name: 'Revoke the manual completion?' })
    .getByRole('button', { name: 'Revoke' })
    .click();
  await expect(statusCell('Verified')).toBeVisible();
});
