// @vitest-environment jsdom

import { QueryClient } from '@tanstack/react-query';
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActorProvider } from '../shell/actor-context.tsx';
import { ACTORS, ISSUED_KEY, KEY, ME } from '../test-admin.ts';
import { bodyOf, callsTo, json, mockApi, problem } from '../test-api.ts';
import { installMatchMedia, renderWithApp } from '../test-render.tsx';
import { ActorsView, expiryFromLocal, keyStatus } from './actors-view.tsx';

// antd modals are slow to mount in jsdom, and the machine is shared: explicit, bounded timeouts.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

const fresh = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  installMatchMedia(false);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const view = (client = fresh()) =>
  renderWithApp(
    <ActorProvider value={ME}>
      <ActorsView />
    </ActorProvider>,
    client,
  );

describe('[UI-034] actors and API keys', () => {
  it('[UI-034] lists human and service Actors, and offers keys only for service Actors', async () => {
    mockApi(() => undefined, { actor: ACTORS, apiKey: [KEY] });
    view();
    expect(await screen.findByText('Grace')).toBeTruthy();
    expect(screen.getByText('Release bot')).toBeTruthy();
    expect(screen.getAllByText('Person')).toHaveLength(2);
    expect(screen.getByText('Service')).toBeTruthy();
  });

  it('[UI-034] an admin cannot disable their own account', async () => {
    mockApi(() => undefined, { actor: ACTORS });
    view();
    const row = (await screen.findByText('Ada')).closest('tr') as HTMLElement;
    const button = within(row).getByRole('button', { name: 'Disable' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('You cannot disable your own account.');
  });

  it('[UI-034] [API-020] disabling an Actor sends PATCH with disabled and reports a refused change', async () => {
    const { calls } = mockApi(
      (url, init) =>
        url.pathname === '/api/v1/actors/a2' && init?.method === 'PATCH'
          ? problem(409, 'last_admin')
          : undefined,
      { actor: ACTORS },
    );
    view();
    const row = (await screen.findByText('Grace')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Disable' }));
    await screen.findByText('Disable Grace?');
    fireEvent.click(screen.getAllByRole('button', { name: 'Disable' }).at(-1) as HTMLElement);
    await waitFor(() => expect(callsTo(calls, 'PATCH', '/api/v1/actors/a2')).toHaveLength(1));
    expect(bodyOf(callsTo(calls, 'PATCH', '/api/v1/actors/a2')[0])).toEqual({ disabled: true });
    expect(
      await screen.findByText(
        'This change would leave the system without an enabled administrator. Make another account an administrator first.',
      ),
    ).toBeTruthy();
  });

  it('[API-020] creating a service Actor posts its name and role', async () => {
    const { calls } = mockApi(
      (url, init) =>
        url.pathname === '/api/v1/actors' && init?.method === 'POST'
          ? json(
              {
                id: 'new',
                kind: 'service',
                displayName: 'Nightly',
                email: null,
                role: 'operator',
                disabled: false,
              },
              201,
            )
          : undefined,
      { actor: ACTORS },
    );
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'New service Actor' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Name'), { target: { value: ' Nightly ' } });
    fireEvent.mouseDown(dialog.getByRole('combobox', { name: 'Role' }));
    fireEvent.click(
      await screen.findByText('Operator', { selector: '.ant-select-item-option-content' }),
    );
    fireEvent.click(dialog.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(callsTo(calls, 'POST', '/api/v1/actors')).toHaveLength(1));
    expect(bodyOf(callsTo(calls, 'POST', '/api/v1/actors')[0])).toEqual({
      displayName: 'Nightly',
      role: 'operator',
    });
  });

  it('[UI-034] [API-020] a key is shown once, with a copy button and a warning, and is kept nowhere after the dialog closes', async () => {
    const logged = vi.spyOn(console, 'log');
    const errored = vi.spyOn(console, 'error');
    const warned = vi.spyOn(console, 'warn');
    const { calls } = mockApi(
      (url, init) => {
        if (url.pathname === '/api/v1/actors/bot/api-keys' && init?.method === 'POST') {
          return json(
            {
              id: 'k2',
              actorId: 'bot',
              name: 'nightly',
              prefix: 'abcd1234',
              expiresAt: null,
              key: ISSUED_KEY,
            },
            201,
          );
        }
        return undefined;
      },
      { actor: ACTORS, apiKey: [KEY] },
    );
    const client = fresh();
    view(client);
    const row = (await screen.findByText('Release bot')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /expand row/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create API key' }));
    const issue = within(await screen.findByRole('dialog'));
    fireEvent.change(issue.getByLabelText('Key name'), { target: { value: 'nightly' } });
    fireEvent.click(issue.getByRole('button', { name: 'Create key' }));

    const shown = within(await screen.findByRole('dialog'));
    expect(shown.getByText(/This key is shown once/)).toBeTruthy();
    expect((shown.getByLabelText('New API key') as HTMLInputElement).value).toBe(ISSUED_KEY);
    expect(shown.getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(bodyOf(callsTo(calls, 'POST', '/api/v1/actors/bot/api-keys')[0])).toEqual({
      name: 'nightly',
    });

    fireEvent.click(shown.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByDisplayValue(ISSUED_KEY)).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();

    // Not in the query or mutation caches, the browser storage, or any log line (ADR-0365).
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(ISSUED_KEY);
    expect(
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((m) => m.state),
      ),
    ).not.toContain(ISSUED_KEY);
    expect(JSON.stringify({ ...localStorage })).not.toContain(ISSUED_KEY);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(ISSUED_KEY);
    for (const spy of [logged, errored, warned]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(ISSUED_KEY);
    }
    expect(calls.map((c) => c.url.toString()).join(' ')).not.toContain(ISSUED_KEY);
  });

  it('[API-020] the expiry must be in the future, and a future one is sent as an instant', async () => {
    const { calls } = mockApi(
      (url, init) =>
        url.pathname === '/api/v1/actors/bot/api-keys' && init?.method === 'POST'
          ? json(
              {
                id: 'k3',
                actorId: 'bot',
                name: 'x',
                prefix: 'p',
                expiresAt: null,
                key: ISSUED_KEY,
              },
              201,
            )
          : undefined,
      { actor: ACTORS, apiKey: [] },
    );
    view();
    const row = (await screen.findByText('Release bot')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /expand row/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create API key' }));
    const issue = within(await screen.findByRole('dialog'));
    fireEvent.change(issue.getByLabelText('Key name'), { target: { value: 'x' } });
    fireEvent.change(issue.getByLabelText('Expiry (optional)'), {
      target: { value: '2001-01-01T00:00' },
    });
    expect(issue.getByText('The expiry must be in the future.')).toBeTruthy();
    expect((issue.getByRole('button', { name: 'Create key' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.change(issue.getByLabelText('Expiry (optional)'), {
      target: { value: '2099-06-01T12:30' },
    });
    fireEvent.click(issue.getByRole('button', { name: 'Create key' }));
    await waitFor(() =>
      expect(callsTo(calls, 'POST', '/api/v1/actors/bot/api-keys')).toHaveLength(1),
    );
    const body = bodyOf(callsTo(calls, 'POST', '/api/v1/actors/bot/api-keys')[0]);
    expect(String((body as { expiresAt?: unknown }).expiresAt)).toMatch(/^2099-06-01T/);
  });

  it('[UI-034] enabling a disabled Actor sends PATCH with disabled false, loading only that row', async () => {
    const actors = ACTORS.map((a) => (a.id === 'a2' ? { ...a, disabled: true } : a));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = mockApi(() => undefined, { actor: actors });
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/v1/actors/a2') && init?.method === 'PATCH') await gate;
      return original(input, init);
    });
    view();
    const row = (await screen.findByText('Grace')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(row.querySelector('.ant-btn-loading')).not.toBeNull());
    const other = screen.getByText('Release bot').closest('tr') as HTMLElement;
    expect(other.querySelector('.ant-btn-loading')).toBeNull();
    release?.();
    await waitFor(() => expect(callsTo(calls, 'PATCH', '/api/v1/actors/a2')).toHaveLength(1));
    expect(bodyOf(callsTo(calls, 'PATCH', '/api/v1/actors/a2')[0])).toEqual({ disabled: false });
  });

  it('[UI-034] [AUTH-040] the shown-once dialog closes only with Done, and a failed copy says so', async () => {
    mockApi(
      (url, init) =>
        url.pathname === '/api/v1/actors/bot/api-keys' && init?.method === 'POST'
          ? json(
              {
                id: 'k4',
                actorId: 'bot',
                name: 'x',
                prefix: 'p',
                expiresAt: null,
                key: ISSUED_KEY,
              },
              201,
            )
          : undefined,
      { actor: ACTORS, apiKey: [] },
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
    view();
    const row = (await screen.findByText('Release bot')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /expand row/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create API key' }));
    const issue = within(await screen.findByRole('dialog'));
    fireEvent.change(issue.getByLabelText('Key name'), { target: { value: 'x' } });
    fireEvent.click(issue.getByRole('button', { name: 'Create key' }));

    const shown = within(await screen.findByRole('dialog'));
    await shown.findByLabelText('New API key');
    // Escape and a click on the backdrop do not close it, and there is no close icon.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', keyCode: 27 });
    const wrap = document.querySelector('.ant-modal-wrap') as HTMLElement;
    fireEvent.mouseDown(wrap);
    fireEvent.click(wrap);
    expect(document.querySelector('.ant-modal-close')).toBeNull();
    expect(screen.queryByDisplayValue(ISSUED_KEY)).not.toBeNull();

    fireEvent.click(shown.getByRole('button', { name: 'Copy' }));
    expect(await shown.findByText(/could not be copied/)).toBeTruthy();
    fireEvent.click(shown.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByDisplayValue(ISSUED_KEY)).toBeNull());
  });

  it('[UI-034] [AUTH-040] while the key is being issued the dialog cannot be cancelled', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockApi(() => undefined, { actor: ACTORS, apiKey: [] });
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api-keys') && init?.method === 'POST') {
        await gate;
        return json(
          { id: 'k5', actorId: 'bot', name: 'x', prefix: 'p', expiresAt: null, key: ISSUED_KEY },
          201,
        );
      }
      return original(input, init);
    });
    view();
    const row = (await screen.findByText('Release bot')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /expand row/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create API key' }));
    const issue = within(await screen.findByRole('dialog'));
    fireEvent.change(issue.getByLabelText('Key name'), { target: { value: 'x' } });
    fireEvent.click(issue.getByRole('button', { name: 'Create key' }));

    const cancel = await waitFor(() => {
      const button = issue.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      return button;
    });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', keyCode: 27 });
    fireEvent.click(cancel);
    expect(screen.queryByRole('dialog')).not.toBeNull();

    release?.();
    expect(await screen.findByDisplayValue(ISSUED_KEY)).toBeTruthy();
  });

  it('[UI-034] [API-020] revoking a key asks first and sends DELETE', async () => {
    const { calls } = mockApi(() => undefined, { actor: ACTORS, apiKey: [KEY] });
    view();
    const row = (await screen.findByText('Release bot')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /expand row/i }));
    const keyRow = (await screen.findByText('nightly')).closest('tr') as HTMLElement;
    fireEvent.click(within(keyRow).getByRole('button', { name: 'Revoke' }));
    // The confirmation lives in the popover opened from this row.
    const popover = await waitFor(() => {
      const found = document.querySelector('.ant-popconfirm') as HTMLElement | null;
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(callsTo(calls, 'DELETE', '/api/v1/api-keys/k1')).toHaveLength(0);
    fireEvent.click(within(popover).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(callsTo(calls, 'DELETE', '/api/v1/api-keys/k1')).toHaveLength(1));
  });

  it('[UI-034] a key status is revoked, expired or active, from the times alone', () => {
    const now = Date.parse('2026-10-09T00:00:00.000Z');
    expect(keyStatus({ ...KEY, revokedAt: '2026-01-01T00:00:00.000Z' }, now)).toBe('revoked');
    expect(keyStatus({ ...KEY, expiresAt: '2026-01-01T00:00:00.000Z' }, now)).toBe('expired');
    expect(keyStatus({ ...KEY, expiresAt: '2030-01-01T00:00:00.000Z' }, now)).toBe('active');
    expect(keyStatus(KEY, now)).toBe('active');
    expect(expiryFromLocal('  ')).toBeUndefined();
    expect(expiryFromLocal('not a date')).toBeUndefined();
  });
});
