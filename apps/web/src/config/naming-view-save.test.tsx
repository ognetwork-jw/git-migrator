// @vitest-environment jsdom

import { QueryClient } from '@tanstack/react-query';
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, callsTo, json, mockApi } from '../test-api.ts';
import { DEFAULT_STEPS, preview, ROUTE, setupNaming } from '../test-naming.ts';
import { installMatchMedia, renderWithApp } from '../test-render.tsx';
import { NamingRulesView } from './naming-view.tsx';

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

describe('[UI-030] naming rules page', () => {
  it('[UI-030] lists the saved rules, and deleting one warns about its effect before the RPC delete', async () => {
    const { calls } = setupNaming(() => json(preview()));
    renderWithApp(<NamingRulesView />, fresh());
    expect(await screen.findByText('Projects')).toBeTruthy();
    expect(screen.getByText('Namespace')).toBeTruthy();
    expect(screen.getByText(/cannot be edited here/)).toBeTruthy();

    const row = screen.getByText('Projects').closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/Planned names for those repositories can change/)).toBeTruthy();
    expect(callsTo(calls, 'DELETE', '/api/model/namingRule/delete')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Delete rule' }));
    await waitFor(() =>
      expect(callsTo(calls, 'DELETE', '/api/model/namingRule/delete')).toHaveLength(1),
    );
    const del = callsTo(calls, 'DELETE', '/api/model/namingRule/delete')[0];
    expect(JSON.parse(del?.url.searchParams.get('q') ?? '{}')).toEqual({
      where: { id: 'rule-1' },
    });
  });

  it('[UI-030] [API-020] the preview is sent as the rule body and the saved update carries the pipeline', async () => {
    const { calls } = setupNaming(() => json(preview()));
    renderWithApp(<NamingRulesView />, fresh());
    await screen.findByText('Projects');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.click(dialog.getByRole('button', { name: 'Preview names' }));
    await dialog.findByText('2 affected, 2 renamed, 0 invalid, 0 colliding.');
    expect(bodyOf(callsTo(calls, 'POST', '/api/v1/routes/r1/naming/preview')[0])).toEqual({
      rule: {
        scope: 'namespace',
        scopeRef: 'ns1',
        pipeline: { steps: DEFAULT_STEPS, template: '{namespace}-{repository}' },
      },
    });

    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(callsTo(calls, 'PUT', '/api/model/namingRule/update')).toHaveLength(1),
    );
    expect(bodyOf(callsTo(calls, 'PUT', '/api/model/namingRule/update')[0])).toEqual({
      where: { id: 'rule-1' },
      data: {
        override: null,
        pipeline: { steps: DEFAULT_STEPS, template: '{namespace}-{repository}' },
      },
    });
  });

  it('[UI-030] a new rule is created through the RPC mount once its preview passes', async () => {
    const { calls } = mockApi(
      (url) => {
        if (url.pathname === '/api/v1/routes') return json({ items: [ROUTE] });
        if (url.pathname === '/api/v1/routes/r1/naming/preview') return json(preview());
        return undefined;
      },
      {
        namingRule: [],
        namespace: [{ id: 'ns2', name: 'Platform', key: null }],
        repository: [],
        route: [],
      },
    );
    renderWithApp(<NamingRulesView />, fresh());
    const newRule = (await screen.findByRole('button', { name: 'New rule' })) as HTMLButtonElement;
    await waitFor(() => expect(newRule.disabled).toBe(false));
    fireEvent.click(newRule);
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.mouseDown(dialog.getByRole('combobox', { name: 'Namespace or repository' }));
    fireEvent.click(await screen.findByText('Platform'));
    fireEvent.click(dialog.getByRole('button', { name: 'Preview names' }));
    await dialog.findByText('2 affected, 2 renamed, 0 invalid, 0 colliding.');
    fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(callsTo(calls, 'POST', '/api/model/namingRule/create')).toHaveLength(1),
    );
    expect(bodyOf(callsTo(calls, 'POST', '/api/model/namingRule/create')[0])).toEqual({
      data: {
        routeId: 'r1',
        scope: 'namespace',
        scopeRef: 'ns2',
        override: null,
        pipeline: { steps: DEFAULT_STEPS, template: '{namespace}-{repository}' },
      },
    });
  });
});
