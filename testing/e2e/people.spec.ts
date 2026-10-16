import { type BrowserContext, expect, type Locator, type Page, test } from '@playwright/test';
import { signIn } from './harness/ui.ts';

/**
 * The People pages through the UI (TST-021, UI-027, UI-028), against the stack of
 * `harness/global-setup.ts`; nothing reaches a real provider (TST-006).
 *
 * After an inventory the fixture world (TST-012) has `bob` suggested by login and `alice` and
 * `carol` unmapped (AUTH-050; without Atlassian Admin enrichment no source email is visible), and
 * one source group, `platform-team`, whose team does not exist on the target yet. Every change this spec makes is undone before it ends, so the specs that
 * run after it on the same stack see the mappings the inventory made.
 */

let context: BrowserContext;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

const table = () => page.getByRole('table');
/** The row of one source identity or group, found by text that only it shows. */
const row = (text: RegExp): Locator => table().getByRole('row').filter({ hasText: text });

/** Picks an option of an antd Select by its accessible name. */
async function choose(label: string, option: string) {
  await page.getByRole('combobox', { name: label }).click();
  // antd draws the visible options as titled items; its role="option" nodes are a hidden copy.
  await page
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
    .getByTitle(option, { exact: true })
    .click();
}

test('[TST-021] [UI-027] the identity mappings list what the inventory matched, by status', async () => {
  await signIn(page, 'operator@test.local');
  // The inventory makes the mappings; it may already have run for an earlier spec.
  await page.getByRole('button', { name: 'Refresh inventory' }).click();
  await expect(page.getByText('Inventory refresh queued.')).toBeVisible();

  await page.goto('/people/identities');
  await expect(page.getByRole('heading', { name: 'Identity mapping', level: 1 })).toBeVisible();
  // The login match needs both endpoints inventoried: reload until it shows.
  await expect(async () => {
    await page.reload();
    await expect(row(/bob/)).toContainText('Suggested', { timeout: 2_000 });
  }).toPass({ timeout: 60_000, intervals: [2_000] });

  // The stack has no Atlassian Admin enrichment, so no source email is visible and alice, who
  // matches only by email, stays unmapped (AUTH-050).
  await expect(row(/alice/)).toContainText('Unmapped');
  await expect(row(/bob/)).toContainText('Login');
  await expect(row(/bob/).getByRole('button', { name: 'Confirm' })).toBeVisible();
  await expect(row(/carol/)).toContainText('Unmapped');
  await expect(row(/carol/).getByRole('button', { name: 'Confirm' })).toHaveCount(0);

  await choose('Filter by status', 'Suggested');
  await expect(row(/bob/)).toBeVisible();
  await expect(row(/alice|carol/)).toHaveCount(0);
  await choose('Filter by status', 'All statuses');

  const search = page.getByRole('searchbox', { name: 'Search source identities' });
  await search.fill('carol');
  await search.press('Enter');
  await expect(row(/carol/)).toBeVisible();
  await expect(row(/alice|bob/)).toHaveCount(0);
  await search.fill('');
  await search.press('Enter');
  await expect(row(/alice/)).toBeVisible();
});

test('[TST-021] [UI-027] excluding a person needs a reason, shows it, and Unmap undoes it', async () => {
  await row(/carol/).getByRole('button', { name: 'Exclude' }).click();
  const dialog = page.getByRole('dialog', { name: 'Exclude from the migration' });
  const submit = dialog.getByRole('button', { name: 'Exclude' });
  await expect(submit).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Reason' }).fill('Left the company');
  await submit.click();
  await expect(dialog).toBeHidden();
  await expect(row(/carol/)).toContainText('Excluded');
  await expect(row(/carol/)).toContainText('Reason: Left the company');

  await row(/carol/).getByRole('button', { name: 'Unmap' }).click();
  await expect(row(/carol/)).toContainText('Unmapped');
  await expect(row(/carol/)).not.toContainText('Left the company');
});

test('[TST-021] [UI-028] the team mappings show the planned slug, and an edited slug is saved', async () => {
  await page.goto('/people/teams');
  await expect(page.getByRole('heading', { name: 'Team mapping', level: 1 })).toBeVisible();
  const team = row(/Platform Team|platform-team/);
  await expect(team).toContainText('2 members');
  await expect(team).toContainText('platform-team');
  await expect(team).toContainText('Team will be created');

  const rename = async (slug: string) => {
    await team.getByRole('button', { name: 'Edit slug' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit the planned team slug' });
    const input = dialog.getByRole('textbox', { name: 'Team slug' });
    await input.fill('Not A Slug');
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
    await input.fill(slug);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(team).toContainText(slug);
  };
  await rename('platform-engineering');
  // Back to the slug the inventory planned, for the specs that follow.
  await rename('platform-team');
});
