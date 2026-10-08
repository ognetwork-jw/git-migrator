// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json' with { type: 'json' };
import { installMatchMedia, renderWithApp } from '../test-render.tsx';
import { AppShell } from './app-shell.tsx';

const replace = vi.fn();
let pathname = '/';

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));
const hardNavigate = vi.fn();
vi.mock('../auth/navigate.ts', () => ({ hardNavigate: (url: string) => hardNavigate(url) }));

const actor = (role: string, extra: Record<string, unknown> = {}) => ({
  id: 'a1',
  kind: 'human',
  displayName: 'Ada Admin',
  email: 'ada@example.test',
  role,
  disabled: false,
  ...extra,
});

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  installMatchMedia(false);
  replace.mockReset();
  hardNavigate.mockReset();
  pathname = '/';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AppShell', () => {
  it('[UI-010] renders header, navigation and main landmarks with the Actor and role', async () => {
    mockFetch(() => reply(200, actor('operator')));
    renderWithApp(
      <AppShell>
        <p>page body</p>
      </AppShell>,
    );
    expect((await screen.findByRole('main')).textContent).toContain('page body');
    const header = screen.getByRole('banner');
    expect(within(header).getByText('Ada Admin')).toBeTruthy();
    expect(within(header).getByTestId('actor-role').textContent).toContain('Operator');
    expect(within(header).getByRole('button', { name: 'Sign out' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).getByRole('link', { name: 'Repositories' }).getAttribute('href')).toBe(
      '/repositories',
    );
    expect(within(nav).getByRole('link', { name: 'Identity mapping' })).toBeTruthy();
    expect(within(nav).queryByRole('link', { name: 'Naming rules' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href')).toBe(
      '#main',
    );
  });

  it('[UI-010] hides items the role cannot use', async () => {
    mockFetch(() => reply(200, actor('viewer')));
    renderWithApp(<AppShell>x</AppShell>);
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).getByRole('link', { name: 'Audit log' })).toBeTruthy();
    expect(within(nav).queryByRole('link', { name: 'Identity mapping' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Actors and API keys' })).toBeNull();
  });

  it('[UI-036] sends a signed-out visitor to /signin with the page to return to', async () => {
    pathname = '/repositories';
    mockFetch(() => reply(401, { code: 'unauthenticated' }));
    renderWithApp(<AppShell>secret</AppShell>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/signin?next=%2Frepositories'));
    expect(screen.queryByText('secret')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Loading your account');
  });

  it('[UI-036] sends an Actor without the role for a page to /denied and shows no content', async () => {
    pathname = '/admin/actors';
    mockFetch(() => reply(200, actor('viewer')));
    renderWithApp(<AppShell>secret</AppShell>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/denied?required=admin'));
    expect(screen.queryByText('secret')).toBeNull();
  });

  it('[UI-036] keeps /denied itself open to any signed-in Actor', async () => {
    pathname = '/denied';
    mockFetch(() => reply(200, actor('viewer')));
    renderWithApp(<AppShell>denied page</AppShell>);
    expect(await screen.findByText('denied page')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it('[UI-010] shows the problem text and retries when the Actor cannot be loaded', async () => {
    let calls = 0;
    mockFetch(() => {
      calls += 1;
      return calls === 1 ? reply(503, { code: 'not_ready' }) : reply(200, actor('admin'));
    });
    renderWithApp(<AppShell>content</AppShell>);
    expect(await screen.findByText(messages.problem.not_ready)).toBeTruthy();
    expect(screen.getByText('Your account could not be loaded')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('content')).toBeTruthy();
  });

  it('[UI-010] falls back to the generic text for a problem code it has no text for', async () => {
    mockFetch(() => reply(500, { code: 'brand_new_code' }));
    renderWithApp(<AppShell>content</AppShell>);
    expect(await screen.findByText(messages.problem.internal_error)).toBeTruthy();
  });

  it('[UI-010] sign-out ends the session on the server and returns to /signin', async () => {
    const fetchMock = mockFetch((url) =>
      url === '/api/auth/sign-out' ? reply(200, {}) : reply(200, actor('admin')),
    );
    renderWithApp(<AppShell>x</AppShell>);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/signin'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/sign-out',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('[UI-010] the menu button opens the drawer with the same navigation', async () => {
    mockFetch(() => reply(200, actor('admin')));
    renderWithApp(<AppShell>x</AppShell>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open navigation menu' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('link', { name: 'Actors and API keys' })).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('link', { name: 'Waves' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { hidden: false })).toBeNull());
  });

  it('[UI-001] the live status reports polling when the browser has no EventSource', async () => {
    mockFetch(() => reply(200, actor('admin')));
    renderWithApp(<AppShell>x</AppShell>);
    const status = await screen.findByText('Polling');
    expect(status.closest('[role="status"]')?.getAttribute('title')).toBe(
      messages.shell.live.pollingHint,
    );
  });
});
