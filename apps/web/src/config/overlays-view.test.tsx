// @vitest-environment jsdom

import { QueryClient } from '@tanstack/react-query';
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, callsTo, json, mockApi } from '../test-api.ts';
import { installMatchMedia, renderWithApp } from '../test-render.tsx';
import { OverlaysView } from './overlays-view.tsx';

// antd modals are slow to mount in jsdom, and the machine is shared: explicit, bounded timeouts.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

const fresh = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const overlays = [
  {
    id: 'o1',
    routeId: 'r1',
    facetKey: 'repository-settings',
    data: { description: 'Migrated' },
    enabled: true,
    updatedAt: '2026-10-01T10:00:00.000Z',
  },
];
const matrix = {
  ceiling: 'static',
  adapters: ['alpha', 'beta'],
  rows: [
    { facet: 'repository-settings', scope: 'repository', inScope: true, cells: [] },
    { facet: 'webhooks', scope: 'repository', inScope: true, cells: [] },
  ],
};

function setup(rows: unknown[], extra?: (url: URL, init?: RequestInit) => Response | undefined) {
  return mockApi(
    (url, init) => {
      if (url.pathname === '/api/v1/routes') {
        return json({ items: [{ id: 'r1', sourceEndpointId: 'e1', targetEndpointId: 'e2' }] });
      }
      if (url.pathname === '/api/v1/capability-matrix') return json(matrix);
      return extra?.(url, init);
    },
    { overlay: rows },
  );
}

/** A header button is disabled until the Route list has loaded: wait for it. */
const enabled = async (name: string) => {
  const button = (await screen.findByRole('button', { name })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
};

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

describe('[UI-032] overlays page', () => {
  it('[UI-032] lists the overlays and deletes one through the validated endpoint', async () => {
    const { calls } = setup(overlays, (url, init) =>
      url.pathname === '/api/v1/overlays/o1' && init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : undefined,
    );
    renderWithApp(<OverlaysView />, fresh());
    expect(await screen.findByText('repository-settings')).toBeTruthy();
    expect(screen.getByText('Enabled')).toBeTruthy();
    expect(screen.getByText('{"description":"Migrated"}')).toBeTruthy();

    const row = screen.getByText('repository-settings').closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    const popover = await waitFor(() => {
      const found = document.querySelector('.ant-popconfirm') as HTMLElement | null;
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    fireEvent.click(within(popover).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(callsTo(calls, 'DELETE', '/api/v1/overlays/o1')).toHaveLength(1));
    expect(
      calls.filter((c) => c.url.pathname.startsWith('/api/model/overlay/delete')),
    ).toHaveLength(0);
  });

  it('[UI-032] [DOM-003] a document the Facet schema refuses is not sent; a valid one is created at /api/v1/overlays', async () => {
    const { calls } = setup([], (url, init) =>
      url.pathname === '/api/v1/overlays' && init?.method === 'POST'
        ? json({ id: 'new', routeId: 'r1', facetKey: 'webhooks' }, 201)
        : undefined,
    );
    renderWithApp(<OverlaysView />, fresh());
    fireEvent.click(await enabled('Add overlay'));
    const dialog = within(await screen.findByRole('dialog'));
    const text = dialog.getByLabelText('Overlay document (JSON)');
    const save = dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    fireEvent.mouseDown(dialog.getByRole('combobox', { name: 'Facet' }));
    fireEvent.click(await screen.findByText('webhooks'));

    fireEvent.change(text, { target: { value: '{"a": ' } });
    expect(dialog.getByText('The overlay is not valid JSON.')).toBeTruthy();
    fireEvent.change(text, { target: { value: '[1]' } });
    expect(dialog.getByText('The overlay must be a JSON object.')).toBeTruthy();
    fireEvent.change(text, { target: { value: '{"nope": 1}' } });
    expect(dialog.getByText("The overlay does not match the Facet's document:")).toBeTruthy();
    expect(dialog.getAllByText(/nope/).length).toBeGreaterThan(0);
    expect(save.disabled).toBe(true);
    expect(callsTo(calls, 'POST', '/api/v1/overlays')).toHaveLength(0);

    fireEvent.change(text, { target: { value: '{"hooks": [{"active": false}]}' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(callsTo(calls, 'POST', '/api/v1/overlays')).toHaveLength(1));
    expect(bodyOf(callsTo(calls, 'POST', '/api/v1/overlays')[0])).toEqual({
      routeId: 'r1',
      facetKey: 'webhooks',
      data: { hooks: [{ active: false }] },
      enabled: true,
    });
    expect(calls.filter((c) => c.url.pathname === '/api/model/overlay/create')).toHaveLength(0);
  });

  it('[UI-032] editing updates the document and the flag with PATCH, and shows the server problems', async () => {
    let reject = true;
    const { calls } = setup(overlays, (url, init) => {
      if (url.pathname !== '/api/v1/overlays/o1' || init?.method !== 'PATCH') return undefined;
      if (!reject) return json({ ...overlays[0] });
      return new Response(
        JSON.stringify({
          type: 'https://git-migrator.invalid/problems/validation_failed',
          title: 'Validation failed',
          status: 422,
          code: 'validation_failed',
          errors: [{ path: 'data.description', message: 'rejected by the server' }],
        }),
        { status: 422, headers: { 'content-type': 'application/problem+json' } },
      );
    });
    renderWithApp(<OverlaysView />, fresh());
    await screen.findByText('repository-settings');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.click(dialog.getByRole('switch', { name: 'Enabled' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    expect(await dialog.findByText('rejected by the server')).toBeTruthy();
    expect(dialog.getByText('data.description')).toBeTruthy();

    reject = false;
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo(calls, 'PATCH', '/api/v1/overlays/o1')).toHaveLength(2));
    expect(bodyOf(callsTo(calls, 'PATCH', '/api/v1/overlays/o1')[1])).toEqual({
      data: { description: 'Migrated' },
      enabled: false,
    });
  });
});
