// @vitest-environment jsdom

import { QueryClient } from '@tanstack/react-query';
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, json, mockApi } from '../test-api.ts';
import { installMatchMedia, renderWithApp } from '../test-render.tsx';
import { WebhookAllowlistView } from './webhook-view.tsx';

vi.setConfig({ testTimeout: 30_000 });
// The machine is shared by parallel agents: async queries get more than the 1 s default (UI tests).
configure({ asyncUtilTimeout: 10_000 });

/** A header button is disabled until the Route list has loaded: wait for it. */
const enabled = async (name: string) => {
  const button = (await screen.findByRole('button', { name })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
};

const fresh = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
/** A fresh answer per call: a Response body can be read once. */
const routes = () =>
  json({ items: [{ id: 'r1', sourceEndpointId: 'e1', targetEndpointId: 'e2' }] });

const hooks = [
  { id: 'w1', routeId: 'r1', pattern: 'https://*.example.test/hooks/**', note: 'CI' },
  { id: 'w2', routeId: 'r1', pattern: 'https://ops.example.test/alerts', note: null },
];

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

describe('[UI-031] webhook allowlist page', () => {
  it('[UI-031] lists the patterns and tests a URL against them without sending it anywhere', async () => {
    const { calls } = mockApi((url) => (url.pathname === '/api/v1/routes' ? routes() : undefined), {
      webhookAllowlistEntry: hooks,
    });
    renderWithApp(<WebhookAllowlistView />, fresh());
    expect(await screen.findByText('https://ops.example.test/alerts')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Hook URL to test'), {
      target: { value: 'https://ci.example.test/hooks/build' },
    });
    expect(await screen.findByText('One pattern matches this URL.')).toBeTruthy();
    expect(screen.getAllByText('https://*.example.test/hooks/**').length).toBeGreaterThan(1);

    fireEvent.change(screen.getByLabelText('Hook URL to test'), {
      target: { value: 'https://elsewhere.example.org/hooks/build' },
    });
    expect(
      await screen.findByText('No pattern matches this URL. A hook to it would not be created.'),
    ).toBeTruthy();
    expect(calls.filter((c) => c.url.pathname.includes('hooks/build'))).toHaveLength(0);
  });

  it('[UI-031] adding a pattern creates it through the RPC mount, and a bad pattern is refused', async () => {
    const { calls } = mockApi((url) => (url.pathname === '/api/v1/routes' ? routes() : undefined), {
      webhookAllowlistEntry: hooks,
    });
    renderWithApp(<WebhookAllowlistView />, fresh());
    await screen.findByText('https://ops.example.test/alerts');
    fireEvent.click(await enabled('Add pattern'));
    const dialog = within(await screen.findByRole('dialog'));
    const save = dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(dialog.getByLabelText('URL pattern'), { target: { value: 'ftp://x' } });
    expect(dialog.getByText(/Enter an http or https URL/)).toBeTruthy();
    expect(save.disabled).toBe(true);

    fireEvent.change(dialog.getByLabelText('URL pattern'), {
      target: { value: 'https://*.example.test/new/**' },
    });
    fireEvent.change(dialog.getByLabelText('Note'), { target: { value: 'Release bot' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(
        calls.filter((c) => c.url.pathname === '/api/model/webhookAllowlistEntry/create'),
      ).toHaveLength(1),
    );
    const created = calls.find((c) => c.url.pathname === '/api/model/webhookAllowlistEntry/create');
    expect(bodyOf(created)).toEqual({
      data: { routeId: 'r1', pattern: 'https://*.example.test/new/**', note: 'Release bot' },
    });
  });

  it('[UI-031] deleting a pattern asks first, then sends the RPC delete', async () => {
    const { calls } = mockApi((url) => (url.pathname === '/api/v1/routes' ? routes() : undefined), {
      webhookAllowlistEntry: hooks,
    });
    renderWithApp(<WebhookAllowlistView />, fresh());
    const row = (await screen.findByText('https://ops.example.test/alerts')).closest(
      'tr',
    ) as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls.filter((c) => c.init?.method === 'DELETE')).toHaveLength(1));
    const del = calls.find((c) => c.init?.method === 'DELETE') as (typeof calls)[number];
    expect(del.url.pathname).toBe('/api/model/webhookAllowlistEntry/delete');
    expect(JSON.parse(del.url.searchParams.get('q') ?? '{}')).toEqual({ where: { id: 'w2' } });
  });
});
