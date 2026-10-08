import { expect, type Page, test } from '@playwright/test';

type Role = 'viewer' | 'operator' | 'admin';

const ACTORS: Record<Role, { id: string; displayName: string; email: string }> = {
  viewer: { id: 'a-viewer', displayName: 'Vera Viewer', email: 'vera@example.test' },
  operator: { id: 'a-operator', displayName: 'Omar Operator', email: 'omar@example.test' },
  admin: { id: 'a-admin', displayName: 'Ada Admin', email: 'ada@example.test' },
};

/** The API is mocked: the page only needs `GET /api/v1/me`. */
async function mockApi(page: Page, role: Role | 'signed-out') {
  await page.route('**/api/v1/me', (route) => {
    if (role === 'signed-out') {
      return route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'https://git-migrator.invalid/problems/unauthenticated',
          title: 'Authentication required',
          status: 401,
          code: 'unauthenticated',
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...ACTORS[role], kind: 'human', role, disabled: false }),
    });
  });
}

/** A deterministic live connection: it opens at once and stays quiet. */
async function fakeEventSource(page: Page) {
  await page.addInitScript(() => {
    class QuietEventSource {
      onopen: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      constructor() {
        setTimeout(() => this.onopen?.({}), 0);
      }
      addEventListener() {}
      close() {}
    }
    (window as unknown as { EventSource: unknown }).EventSource = QuietEventSource;
  });
}

/** Fixed fonts and no motion, so the screenshots do not depend on the machine. */
async function freeze(page: Page) {
  await page.addStyleTag({
    content: `*, *::before, *::after {
      font-family: 'DejaVu Sans', sans-serif !important;
      transition: none !important;
      animation: none !important;
      caret-color: transparent !important;
    }`,
  });
}

async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await freeze(page);
}

test.describe('antd and Tailwind layering', () => {
  test.beforeEach(async ({ page }) => {
    await fakeEventSource(page);
  });

  test('[UI-001] antd styles sit in their own layer between Tailwind base and utilities', async ({
    page,
  }) => {
    await mockApi(page, 'admin');
    await open(page, '/');
    const order = await page.evaluate(() => {
      const names: string[] = [];
      const visit = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSLayerStatementRule) names.push(...rule.nameList);
          else if (rule instanceof CSSLayerBlockRule && rule.name) names.push(rule.name);
        }
      };
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          visit(sheet.cssRules);
        } catch {
          // A cross-origin sheet; none are expected.
        }
      }
      return [...new Set(names)];
    });
    const position = (name: string) => order.indexOf(name);
    expect(position('antd')).toBeGreaterThan(position('base'));
    expect(position('components')).toBeGreaterThan(position('antd'));
    expect(position('utilities')).toBeGreaterThan(position('components'));
  });

  test('[UI-001] a Tailwind utility beats the antd rule for the same property', async ({
    page,
  }) => {
    await mockApi(page, 'admin');
    await open(page, '/');
    // antd's h1 is 38px with a 0.5em bottom margin; the page asks for text-2xl and mb-2.
    const heading = page.getByRole('heading', { level: 1, name: 'Dashboard' });
    await expect(heading).toHaveCSS('font-size', '24px');
    await expect(heading).toHaveCSS('margin-bottom', '8px');
  });

  test('[UI-001] antd base styles beat the Tailwind reset', async ({ page }) => {
    await mockApi(page, 'signed-out');
    await open(page, '/signin');
    // Tailwind's reset makes buttons transparent; antd's primary button must keep its fill.
    const button = page.getByRole('button', { name: 'Sign in with Microsoft' });
    await expect(button).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  });
});

test.describe('shell', () => {
  test.beforeEach(async ({ page }) => {
    await fakeEventSource(page);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`[UI-010] admin shell, ${scheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await mockApi(page, 'admin');
      await open(page, '/');
      await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
      await expect(page).toHaveScreenshot(`shell-admin-${scheme}.png`);
    });
  }

  test('[UI-010] header shows the Actor, the role and sign-out', async ({ page }) => {
    await mockApi(page, 'operator');
    await open(page, '/');
    const header = page.getByRole('banner');
    await expect(header.getByText('Omar Operator')).toBeVisible();
    await expect(header.getByTestId('actor-role')).toHaveText('Operator');
    await expect(header.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('[UI-010] a viewer sees only the items its role can use', async ({ page }) => {
    await mockApi(page, 'viewer');
    await open(page, '/');
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav.getByRole('link', { name: 'Repositories' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Audit log' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Capability matrix' })).toBeVisible();
    for (const hidden of ['Identity mapping', 'Naming rules', 'Actors and API keys']) {
      await expect(nav.getByRole('link', { name: hidden })).toHaveCount(0);
    }
  });

  test('[UI-010] the sidebar collapses into a drawer below 1024 px', async ({ page }) => {
    await page.setViewportSize({ width: 1023, height: 800 });
    await mockApi(page, 'operator');
    await open(page, '/');
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav.getByRole('link', { name: 'Identity mapping' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Naming rules' })).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('shell-operator-drawer.png');
  });

  test('[UI-010] the sidebar stays beside the page from 1024 px up', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await mockApi(page, 'operator');
    await open(page, '/');
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open navigation menu' })).toBeHidden();
  });

  test('[UI-001] the live status says when it is polling', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { EventSource?: unknown }).EventSource = undefined;
    });
    await mockApi(page, 'admin');
    await open(page, '/');
    const status = page.getByRole('status').filter({ hasText: 'Polling' });
    await expect(status).toBeVisible();
    await expect(status).toHaveAttribute('title', /refreshes every few seconds/);
  });

  test('[UI-001] landmarks: header, nav and main', async ({ page }) => {
    await mockApi(page, 'admin');
    await open(page, '/');
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
  });
});

test.describe('sign-in and denied pages', () => {
  test.beforeEach(async ({ page }) => {
    await fakeEventSource(page);
  });

  test('[UI-036] a signed-out visitor is sent to /signin and returns afterwards', async ({
    page,
  }) => {
    await mockApi(page, 'signed-out');
    await page.goto('/repositories');
    await expect(page).toHaveURL(/\/signin\?next=%2Frepositories$/);
    await expect(page.getByRole('heading', { name: 'Sign in to git-migrator' })).toBeVisible();
  });

  test('[UI-036] /signin offers Entra and, when enabled, the test form', async ({ page }) => {
    await mockApi(page, 'signed-out');
    await open(page, '/signin');
    await expect(page.getByRole('button', { name: 'Sign in with Microsoft' })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page).toHaveScreenshot('signin.png');
  });

  test('[UI-036] test sign-in posts the credentials and follows next', async ({ page }) => {
    await mockApi(page, 'signed-out');
    let body: unknown;
    await page.route('**/api/auth/sign-in/email', (route) => {
      body = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await open(page, '/signin?next=%2Fwaves');
    await page.getByLabel('Email').fill('operator@test.local');
    await page.getByLabel('Password').fill('not-a-real-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect.poll(() => body).toMatchObject({ email: 'operator@test.local' });
    await expect(page).toHaveURL(/\/waves$/);
  });

  test('[UI-036] a refused test sign-in says so', async ({ page }) => {
    await mockApi(page, 'signed-out');
    await page.route('**/api/auth/sign-in/email', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{"code":"x"}' }),
    );
    await open(page, '/signin');
    await page.getByLabel('Email').fill('operator@test.local');
    await page.getByLabel('Password').fill('wrong');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'The email or password is not correct.' }),
    ).toBeVisible();
  });

  test('[UI-036] a viewer opening an admin page lands on /denied', async ({ page }) => {
    await mockApi(page, 'viewer');
    await page.goto('/admin/actors');
    await expect(page).toHaveURL(/\/denied\?required=admin$/);
    await expect(page.getByText('This page needs the Admin role.')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await freeze(page);
    await expect(page).toHaveScreenshot('denied-viewer.png');
  });

  test('[UI-036] /auth/error shows the text of the error code', async ({ page }) => {
    await open(page, '/auth/error?error=role_assignment_required');
    await expect(
      page.getByText('You are not assigned an app role for git-migrator.'),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to sign-in' })).toBeVisible();
  });

  test('[UI-036] /auth/error with an unknown code falls back to the generic text', async ({
    page,
  }) => {
    await open(page, '/auth/error?error=%3Cscript%3E');
    await expect(page.getByText('Sign-in failed. Try again')).toBeVisible();
  });
});
