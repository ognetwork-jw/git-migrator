import { beforeEach, describe, expect, it, vi } from 'vitest';

const order: string[] = [];
const args = (params: Record<string, string> = {}) => ({ searchParams: Promise.resolve(params) });
const authorizePage = vi.fn(async (path: string) => {
  order.push(`authorize ${path}`);
});

vi.mock('./authorize.ts', () => ({ authorizePage: (path: string) => authorizePage(path) }));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => {
    order.push('translate');
    return key;
  },
}));
vi.mock('../dashboard/dashboard-view.tsx', () => ({ DashboardView: () => null }));
vi.mock('../repositories/repositories-view.tsx', () => ({ RepositoriesView: () => null }));
vi.mock('../ui/page-heading.tsx', () => ({ PageHeading: () => null }));

const dashboard = await import('../../app/(shell)/page.tsx');
const repositories = await import('../../app/(shell)/repositories/page.tsx');

beforeEach(() => {
  order.length = 0;
  authorizePage.mockClear();
  authorizePage.mockImplementation(async (path: string) => {
    order.push(`authorize ${path}`);
  });
});

describe('[AUTH-021] [UI-020] [UI-021] the dashboard and repositories pages are gated on the server', () => {
  it('[AUTH-021] [UI-020] the dashboard authorizes "/" before anything else renders', async () => {
    const page = await dashboard.default();
    expect(order[0]).toBe('authorize /');
    expect(page).toBeTruthy();
    expect(dashboard.dynamic).toBe('force-dynamic');
  });

  it('[AUTH-021] [UI-021] the repositories page authorizes "/repositories" before anything else renders', async () => {
    const page = await repositories.default(args());
    expect(order[0]).toBe('authorize /repositories');
    expect(page).toBeTruthy();
    expect(repositories.dynamic).toBe('force-dynamic');
  });

  it('[AUTH-021] a redirect from the gate stops the page from rendering', async () => {
    authorizePage.mockRejectedValue(new Error('NEXT_REDIRECT /signin'));
    await expect(dashboard.default()).rejects.toThrow('NEXT_REDIRECT');
    await expect(repositories.default(args())).rejects.toThrow('NEXT_REDIRECT');
    expect(order).not.toContain('translate');
  });
});

describe('[UI-021] the repositories page opens pre-filtered from the address', () => {
  it('[UI-021] passes the Route and filters of the query string to the view', async () => {
    const page = (await repositories.default(args({ route: 'r2', status: 'failed' }))) as {
      props: { children: { props: Record<string, unknown> }[] };
    };
    const view = page.props.children[1] as { props: Record<string, unknown> };
    expect(view.props).toMatchObject({
      initialRouteId: 'r2',
      initialFilters: { status: 'failed' },
    });
  });
});
