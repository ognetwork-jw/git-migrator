// @vitest-environment jsdom

import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../api/actor.ts';
import { ActorProvider } from '../shell/actor-context.tsx';
import { LiveTopicsProvider } from '../shell/live-topics.tsx';
import { installMatchMedia, renderWithApp } from '../test-render.tsx';
import { fromDateInput, WavesView } from './waves-view.tsx';

vi.mock('../repositories/repositories-view.tsx', () => ({
  RepositoriesView: (props: { initialRouteId?: string; initialFilters?: unknown }) => (
    <div data-testid="repos">{JSON.stringify(props)}</div>
  ),
}));
const { WaveDetailView } = await import('./wave-detail-view.tsx');

vi.setConfig({ testTimeout: 30_000 });

const actor = (role: Actor['role']): Actor => ({
  id: 'a1',
  displayName: 'Ada',
  email: null,
  role,
  disabled: false,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  readonly url: URL;
  readonly init?: RequestInit;
}
let calls: Call[] = [];
const DEFAULT_WAVES = [
  {
    id: 'w1',
    name: 'Wave one',
    targetDate: '2026-11-01T00:00:00.000Z',
    description: 'First batch',
  },
];
let waves = DEFAULT_WAVES;

function mockApi() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      calls.push({ url, ...(init ? { init } : {}) });
      switch (url.pathname) {
        case '/api/model/wave/findMany': {
          const args = JSON.parse(url.searchParams.get('q') ?? '{}') as {
            where?: { id?: string };
          };
          return json({
            data: args.where?.id ? waves.filter((w) => w.id === args.where?.id) : waves,
          });
        }
        case '/api/model/migration/findMany':
          return json({ data: [{ routeId: 'r9' }] });
        case '/api/v1/dashboard':
          return json({
            generatedAt: '2026-10-01T00:00:00.000Z',
            routes: [],
            wavesTruncated: false,
            waves: [
              {
                id: 'w1',
                name: 'Wave one',
                targetDate: null,
                total: 4,
                byStatus: { analyzed: 2, verified: 1, failed: 1 },
              },
            ],
            recentRuns: [],
          });
        case '/api/model/wave/create':
        case '/api/model/wave/update':
        case '/api/model/wave/delete':
          return json({ data: {} });
        default:
          return json({ type: 'x', title: 'x', status: 404, code: 'not_found' }, 404);
      }
    }),
  );
}
const writes = (name: string) => calls.filter((c) => c.url.pathname === `/api/model/wave/${name}`);

const renderWith = (ui: React.ReactElement, role: Actor['role'] = 'operator') =>
  renderWithApp(
    <ActorProvider value={actor(role)}>{ui}</ActorProvider>,
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
  waves = DEFAULT_WAVES;
  mockApi();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  listeners = new Map<string, (event: { data?: string }) => void>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.closed = true;
  }
  emit(topics: string[]) {
    this.listeners.get('gm')?.({ data: JSON.stringify({ topics }) });
  }
}
const count = (path: string) => calls.filter((c) => c.url.pathname === path).length;

describe('[UI-024] waves', () => {
  it('[UI-024] lists Waves with their target date, description and progress', async () => {
    renderWith(<WavesView />);
    expect(await screen.findByRole('link', { name: 'Wave one' })).toBeTruthy();
    expect(screen.getByText('First batch')).toBeTruthy();
    expect(await screen.findByText('1 of 4 done')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Wave one' }).getAttribute('href')).toBe('/waves/w1');
  });

  it('[UI-024] an operator creates a Wave', async () => {
    renderWith(<WavesView />);
    await screen.findByRole('link', { name: 'Wave one' });
    fireEvent.click(screen.getByRole('button', { name: /New Wave/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: ' Wave two ' } });
    fireEvent.change(within(dialog).getByLabelText('Target date'), {
      target: { value: '2026-12-01' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes('create')).toHaveLength(1));
    expect(JSON.parse(String(writes('create')[0]?.init?.body))).toEqual({
      data: { name: 'Wave two', targetDate: '2026-12-01T00:00:00.000Z', description: null },
    });
  });

  it('[UI-024] an operator edits and deletes a Wave', async () => {
    renderWith(<WavesView />);
    await screen.findByRole('link', { name: 'Wave one' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Wave one' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes('update')).toHaveLength(1));
    expect(JSON.parse(String(writes('update')[0]?.init?.body))).toMatchObject({
      where: { id: 'w1' },
      data: { name: 'Renamed' },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Delete Wave one' }));
    const confirm = (await screen.findAllByRole('button', { name: 'Delete' })).at(-1);
    fireEvent.click(confirm as HTMLElement);
    await waitFor(() => expect(writes('delete')).toHaveLength(1));
    expect(JSON.parse(writes('delete')[0]?.url.searchParams.get('q') as string)).toEqual({
      where: { id: 'w1' },
    });
  });

  it('[UI-024] a viewer sees the Waves without create, edit or delete', async () => {
    renderWith(<WavesView />, 'viewer');
    await screen.findByRole('link', { name: 'Wave one' });
    expect(screen.queryByRole('button', { name: /New Wave/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Wave one' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Wave one' })).toBeNull();
  });

  it('[UI-024] the detail page shows the status breakdown and the list filtered to the Wave', async () => {
    renderWith(<WaveDetailView id="w1" />);
    expect(await screen.findByText('Analyzed: 2')).toBeTruthy();
    expect(screen.getByText('Failed: 1')).toBeTruthy();
    const repos = await screen.findByTestId('repos');
    expect(JSON.parse(repos.textContent as string)).toEqual({
      initialRouteId: 'r9',
      initialFilters: { waveId: 'w1', status: 'all' },
    });
  });

  it('[UI-024] the detail page of an unknown Wave says so', async () => {
    waves = [];
    renderWith(<WaveDetailView id="nope" />);
    expect(await screen.findByText('This Wave does not exist.')).toBeTruthy();
    expect(screen.queryByTestId('repos')).toBeNull();
  });

  it('[UI-024] reads a date input as UTC midnight and an empty one as no date', () => {
    expect(fromDateInput('2026-12-01')).toBe('2026-12-01T00:00:00.000Z');
    expect(fromDateInput('')).toBeNull();
    expect(fromDateInput('garbage')).toBeNull();
  });

  it('[UI-024] [UI-001] the list refetches Waves and progress when the migrations list changes', async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    renderWith(
      <LiveTopicsProvider>
        <WavesView />
      </LiveTopicsProvider>,
    );
    await screen.findByText('1 of 4 done');
    const live = () =>
      FakeEventSource.instances.find((i) => !i.closed && i.url.includes('list%3Amigrations'));
    await waitFor(() => expect(live()).toBeTruthy());
    const source = live() as FakeEventSource;
    const before = { dash: count('/api/v1/dashboard'), waves: count('/api/model/wave/findMany') };
    await act(async () => {
      source.onopen?.();
      source.emit(['list:migrations']);
    });
    await waitFor(() => expect(count('/api/v1/dashboard')).toBe(before.dash + 1));
    await waitFor(() => expect(count('/api/model/wave/findMany')).toBe(before.waves + 1));
  });

  it('[UI-024] [UI-001] the detail page refetches its breakdown when the migrations list changes', async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    renderWith(
      <LiveTopicsProvider>
        <WaveDetailView id="w1" />
      </LiveTopicsProvider>,
    );
    await screen.findByText('Analyzed: 2');
    const live = () =>
      FakeEventSource.instances.find((i) => !i.closed && i.url.includes('list%3Amigrations'));
    await waitFor(() => expect(live()).toBeTruthy());
    const source = live() as FakeEventSource;
    const before = count('/api/v1/dashboard');
    await act(async () => {
      source.onopen?.();
      source.emit(['list:migrations']);
    });
    await waitFor(() => expect(count('/api/v1/dashboard')).toBe(before + 1));
  });

  it('[UI-024] the detail page does not claim an empty Wave while the breakdown is unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/model/wave/findMany') return json({ data: waves });
        if (url.pathname === '/api/model/migration/findMany') return json({ data: [] });
        if (url.pathname === '/api/v1/dashboard') {
          return json({
            generatedAt: 'x',
            routes: [],
            wavesTruncated: true,
            waves: [],
            recentRuns: [],
          });
        }
        return json({ type: 'x', title: 'x', status: 404, code: 'not_found' }, 404);
      }),
    );
    renderWith(<WaveDetailView id="w1" />);
    expect(await screen.findByText(/breakdown is not available/)).toBeTruthy();
    expect(screen.queryByText('No repositories in this Wave yet.')).toBeNull();
  });
});
