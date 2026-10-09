// @vitest-environment jsdom

import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMatchMedia, renderWithApp } from '../test-render.tsx';
import { BulkBar } from './bulk-bar.tsx';
import type { RepositorySelection, SelectedRepository } from './selection.ts';

vi.setConfig({ testTimeout: 30_000 });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  readonly url: URL;
  readonly init?: RequestInit;
}
let calls: Call[] = [];
let bulkAnswer: () => Response = () => json({ accepted: [], skipped: [] });
const clear = vi.fn();

function mockApi() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.pathname === '/api/model/wave/findMany') {
        return json({ data: [{ id: 'w1', name: 'Wave one' }] });
      }
      if (url.pathname === '/api/v1/migrations/bulk') return bulkAnswer();
      return json({ type: 'x', title: 'x', status: 404, code: 'not_found' }, 404);
    }),
  );
}
const bulkCalls = () => calls.filter((c) => c.url.pathname === '/api/v1/migrations/bulk');
const bodyOf = (call: Call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>;

function selectionOf(count: number): RepositorySelection {
  const entries: [string, SelectedRepository][] = Array.from({ length: count }, (_, i) => [
    `m${i + 1}`,
    { id: `m${i + 1}`, readiness: 'ready', path: `acme/repo-${i + 1}` },
  ]);
  const items = new Map(entries);
  return { ids: [...items.keys()], items, count, replaceOnPage: () => undefined, clear };
}

const renderBar = (count: number) =>
  renderWithApp(
    <BulkBar selection={selectionOf(count)} />,
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );

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
  bulkAnswer = () => json({ accepted: [], skipped: [] });
  clear.mockClear();
  mockApi();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('[UI-021] [LIF-090] bulk bar', () => {
  it('[UI-021] has Analyze, Migrate ready, Assign to wave and Remove from wave, all off without a selection', () => {
    renderBar(0);
    for (const name of ['Analyze', 'Migrate ready', 'Assign to wave', 'Remove from wave']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('[LIF-090] Analyze sends the selected ids and clears the selection when nothing was skipped', async () => {
    bulkAnswer = () => json({ accepted: ['m1', 'm2'], skipped: [] });
    renderBar(2);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    expect(await screen.findByText('2 repositories accepted.')).toBeTruthy();
    expect(bodyOf(bulkCalls()[0] as Call)).toEqual({ ids: ['m1', 'm2'], action: 'analyze' });
    expect(clear).toHaveBeenCalled();
  });

  it('[LIF-090] Migrate ready asks first, then lists every skipped repository with its reason', async () => {
    bulkAnswer = () =>
      json({
        accepted: ['m1'],
        skipped: [
          { id: 'm2', reason: 'not_ready' },
          { id: 'm3', reason: 'analysis_stale' },
          { id: 'gone', reason: 'not_found' },
        ],
      });
    renderBar(3);
    fireEvent.click(screen.getByRole('button', { name: 'Migrate ready' }));
    expect(bulkCalls()).toHaveLength(0);
    const confirm = (await screen.findAllByRole('button', { name: 'Migrate ready' })).at(-1);
    fireEvent.click(confirm as HTMLElement);
    expect(await screen.findByText('1 repository accepted.')).toBeTruthy();
    expect(bodyOf(bulkCalls()[0] as Call)).toEqual({
      ids: ['m1', 'm2', 'm3'],
      action: 'migrate-ready',
    });
    expect(screen.getByText('3 repositories skipped.')).toBeTruthy();
    expect(screen.getByText('acme/repo-2: Not ready.')).toBeTruthy();
    expect(
      screen.getByText('acme/repo-3: Its Analysis is stale; analyze it again first.'),
    ).toBeTruthy();
    expect(screen.getByText('gone: No longer exists.')).toBeTruthy();
    expect(clear).not.toHaveBeenCalled();
  });

  it('[LIF-090] Assign to wave needs a chosen Wave and sends its id', async () => {
    bulkAnswer = () => json({ accepted: ['m1'], skipped: [] });
    renderBar(1);
    const assign = screen.getByRole('button', { name: 'Assign to wave' }) as HTMLButtonElement;
    expect(assign.disabled).toBe(true);
    await waitFor(() =>
      expect(calls.some((c) => c.url.pathname.includes('wave/findMany'))).toBe(true),
    );
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Wave to assign' }));
    fireEvent.click(await screen.findByText('Wave one'));
    await waitFor(() => expect(assign.disabled).toBe(false));
    fireEvent.click(assign);
    await screen.findByText('1 repository accepted.');
    expect(bodyOf(bulkCalls()[0] as Call)).toEqual({
      ids: ['m1'],
      action: 'assign-to-wave',
      waveId: 'w1',
    });
  });

  it('[LIF-090] Remove from wave sends no Wave', async () => {
    bulkAnswer = () => json({ accepted: ['m1'], skipped: [] });
    renderBar(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove from wave' }));
    await screen.findByText('1 repository accepted.');
    expect(bodyOf(bulkCalls()[0] as Call)).toEqual({ ids: ['m1'], action: 'remove-from-wave' });
  });

  it('[LIF-090] refuses more than 200 selected rows before calling the server', () => {
    renderBar(201);
    expect(screen.getByText('Select at most 200 repositories for a bulk action.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Analyze' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('[LIF-090] shows the problem text when the request fails', async () => {
    bulkAnswer = () => json({ type: 'x', title: 'x', status: 403, code: 'forbidden' }, 403);
    renderBar(1);
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    expect((await screen.findByRole('alert')).textContent).toContain('role does not allow');
  });
});
