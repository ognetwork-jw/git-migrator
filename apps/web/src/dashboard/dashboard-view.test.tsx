// @vitest-environment jsdom

import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../api/actor.ts';
import { ActorProvider } from '../shell/actor-context.tsx';
import { LiveTopicsProvider } from '../shell/live-topics.tsx';
import { installMatchMedia, renderWithApp } from '../test-render.tsx';
import type { Dashboard, Quota } from './api.ts';
import { DashboardView } from './dashboard-view.tsx';

vi.setConfig({ testTimeout: 30_000 });

const actor = (role: Actor['role']): Actor => ({
  id: 'a1',
  displayName: 'Ada',
  email: null,
  role,
  disabled: false,
});

const dashboard = (extra: Partial<Dashboard> = {}): Dashboard => ({
  generatedAt: '2026-10-09T10:00:00.000Z',
  routes: [
    {
      routeId: 'route-1',
      sourceEndpointId: 'e1',
      targetEndpointId: 'e2',
      total: 30,
      byStatus: { discovered: 10, analyzed: 12, migrated: 8, failed: 0 },
      byReadiness: { ready: 9, needs_attention: 4, blocked: 2, unanalyzed: 15 },
      endpointMigration: { migrationId: 'em1', status: 'analyzed', readiness: 'needs_attention' },
    },
  ],
  wavesTruncated: false,
  waves: [
    {
      id: 'w1',
      name: 'Wave one',
      targetDate: '2026-11-01T00:00:00.000Z',
      total: 4,
      byStatus: { migrated: 1, verified: 1, analyzed: 2 },
    },
  ],
  recentRuns: [
    {
      id: 'run1',
      migrationId: 'm1',
      kind: 'migrate',
      status: 'succeeded',
      createdAt: '2026-10-09T09:00:00.000Z',
      startedAt: '2026-10-09T09:01:00.000Z',
      finishedAt: '2026-10-09T09:30:00.000Z',
    },
    {
      id: 'run2',
      migrationId: 'm2',
      kind: 'run_anyway',
      status: 'running',
      createdAt: '2026-10-09T09:40:00.000Z',
      startedAt: null,
      finishedAt: null,
    },
  ],
  ...extra,
});

const bucket = (extra: Partial<Quota['buckets'][number]> = {}): Quota['buckets'][number] => ({
  bucketKey: 'e1:acct:core',
  endpointId: 'e1',
  accountKey: 'acct',
  resourceGroup: 'core',
  limit: 1000,
  effectiveLimit: 1000,
  windowSeconds: 3600,
  used: 250,
  pools: { backgroundLimit: 500, usedBackground: 100, usedInteractive: 150 },
  remaining: 750,
  resetAt: '2026-10-09T11:00:00.000Z',
  blockedUntil: null,
  nearLimit: false,
  backgroundRatePerSecond: 0.1,
  backlog: 12,
  backgroundEtaSeconds: 3 * 3600,
  ...extra,
});

const quota = (extra: Partial<Quota> = {}): Quota => ({
  generatedAt: '2026-10-09T10:00:00.000Z',
  backlogTotal: 12,
  backlogTruncated: false,
  buckets: [bucket()],
  ...extra,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let calls: { url: URL; init?: RequestInit }[] = [];
let dash: Dashboard;
let quotaBody: Quota;

function mockApi(extra?: (url: URL, init?: RequestInit) => Response | undefined) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      calls.push({ url, ...(init ? { init } : {}) });
      const custom = extra?.(url, init);
      if (custom) return custom;
      if (url.pathname === '/api/v1/dashboard') return json(dash);
      if (url.pathname === '/api/v1/quota') return json(quotaBody);
      if (url.pathname === '/api/v1/inventory/refresh') return json({ endpoints: ['e1'] }, 202);
      return json({ type: 'x', title: 'x', status: 404, code: 'not_found' }, 404);
    }),
  );
}

const fresh = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderView = (role: Actor['role'] = 'operator', client = fresh()) =>
  renderWithApp(
    <ActorProvider value={actor(role)}>
      <LiveTopicsProvider>
        <DashboardView />
      </LiveTopicsProvider>
    </ActorProvider>,
    client,
  );

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

beforeEach(() => {
  installMatchMedia(false);
  dash = dashboard();
  quotaBody = quota();
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
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

describe('[UI-020] dashboard', () => {
  it('[UI-020] shows counts per status and readiness for each Route and the endpoint migration', async () => {
    mockApi();
    renderView();
    const card = (await screen.findByText('Route route-1')).closest('.ant-card') as HTMLElement;
    const status = within(card).getByRole('region', { name: 'By status' });
    expect(within(status).getByText('Analyzed').closest('.ant-statistic')?.textContent).toContain(
      '12',
    );
    expect(within(status).getByText('Total').closest('.ant-statistic')?.textContent).toContain(
      '30',
    );
    expect(within(status).queryByText('Failed')).toBeNull(); // zero counts are left out
    const readiness = within(card).getByRole('region', { name: 'By readiness' });
    expect(within(readiness).getByText('Ready').closest('.ant-statistic')?.textContent).toContain(
      '9',
    );
    expect(
      within(readiness).getByText('Not analyzed').closest('.ant-statistic')?.textContent,
    ).toContain('15');
    const endpoint = within(card).getByRole('region', { name: 'Endpoint migration' });
    expect(within(endpoint).getByText('Analyzed')).toBeTruthy();
    expect(within(endpoint).getByText('Needs attention')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Open the list' }).getAttribute('href')).toBe(
      '/repositories?route=route-1',
    );
  });

  it('[UI-020] the status and readiness cards open the list with those filters', async () => {
    mockApi();
    renderView();
    const link = async (name: string) =>
      (await screen.findByRole('link', { name })).getAttribute('href');
    expect(await link('Analyzed')).toBe('/repositories?route=route-1&status=analyzed');
    expect(await link('Total')).toBe('/repositories?route=route-1&status=all');
    expect(await link('Needs attention')).toBe(
      '/repositories?route=route-1&status=all&readiness=needs_attention',
    );
    expect(screen.queryByRole('link', { name: 'Not analyzed' })).toBeNull();
  });

  it('[UI-020] shows the progress of each Wave and says when the list of Waves is cut off', async () => {
    dash = dashboard({ wavesTruncated: true });
    mockApi();
    renderView();
    expect(await screen.findByText('Wave one')).toBeTruthy();
    expect(screen.getByText('2 of 4 done')).toBeTruthy();
    expect(
      screen.getByRole('progressbar', { name: 'Wave one' }).getAttribute('aria-valuenow'),
    ).toBe('50');
    expect(screen.getByText('Only the first 1 Waves are shown.')).toBeTruthy();
  });

  it('[UI-020] shows no truncation notice for a complete Wave list', async () => {
    mockApi();
    renderView();
    await screen.findByText('Wave one');
    expect(screen.queryByText(/Only the first/)).toBeNull();
  });

  it('[UI-020] [JOB-047] shows a gauge per quota bucket with the background backlog and ETA', async () => {
    mockApi();
    renderView();
    expect(await screen.findByText('e1 / acct / core')).toBeTruthy();
    const gauge = screen.getByRole('progressbar', { name: 'Quota used in e1 / acct / core' });
    expect(gauge.getAttribute('aria-valuenow')).toBe('25');
    expect(screen.getByText('250 of 1000 used', { exact: false })).toBeTruthy();
    expect(screen.getByText(/12 analyses queued\. About 3 h to drain the queue/)).toBeTruthy();
    expect(screen.queryByText(/partial/)).toBeNull();
    // The gauges come from GET /quota, not from the dashboard response.
    expect(calls.some((c) => c.url.pathname === '/api/v1/quota')).toBe(true);
  });

  it('[UI-020] [JOB-047] says when a bucket is blocked or has no background capacity, and when the backlog is partial', async () => {
    quotaBody = quota({
      backlogTruncated: true,
      buckets: [
        bucket({
          blockedUntil: '2026-10-09T10:30:00.000Z',
          nearLimit: true,
          backgroundEtaSeconds: null,
          used: 1000,
        }),
        bucket({
          bucketKey: 'e1:acct:search',
          resourceGroup: 'search',
          backlog: 0,
          nearLimit: true,
        }),
      ],
    });
    mockApi();
    renderView();
    expect(await screen.findByText(/Blocked until/)).toBeTruthy();
    expect(screen.getByText(/No background capacity, so no estimate/)).toBeTruthy();
    expect(screen.getByText(/Nothing queued/)).toBeTruthy();
    expect(screen.getByText('Near limit')).toBeTruthy();
    expect(screen.getByText(/per-bucket backlogs and estimates are partial/)).toBeTruthy();
  });

  it('[UI-020] a failed quota call does not hide the rest of the dashboard', async () => {
    mockApi((url) =>
      url.pathname === '/api/v1/quota'
        ? json({ type: 'x', title: 'x', status: 503, code: 'not_ready' }, 503)
        : undefined,
    );
    renderView();
    expect((await screen.findByRole('alert')).textContent).toContain('Quota could not be loaded');
    expect(screen.getByText('Wave one')).toBeTruthy();
  });

  it('[UI-020] lists the recent Runs with kind, status and dates', async () => {
    mockApi();
    renderView();
    const table = (await screen.findByText('Recent Runs')).closest('.ant-card') as HTMLElement;
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText('Migrate')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('Succeeded')).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText('Run anyway')).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText('Running')).toBeTruthy();
    expect(
      within(rows[1] as HTMLElement)
        .getAllByRole('link')[0]
        ?.getAttribute('href'),
    ).toBe('/repositories/m1');
  });

  it('[UI-020] an operator can refresh the inventory and a viewer has no button', async () => {
    mockApi();
    renderView('operator');
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh inventory' }));
    expect(await screen.findByText('Inventory refresh queued.')).toBeTruthy();
    const post = calls.find((c) => c.init?.method === 'POST');
    expect(post?.url.pathname).toBe('/api/v1/inventory/refresh');
    cleanup();
    mockApi();
    renderView('viewer');
    await screen.findByText('Wave one');
    expect(screen.queryByRole('button', { name: 'Refresh inventory' })).toBeNull();
  });

  it('[UI-020] says so when there are no Routes, Waves or Runs', async () => {
    dash = dashboard({ routes: [], waves: [], recentRuns: [] });
    quotaBody = quota({ buckets: [] });
    mockApi();
    renderView();
    expect(await screen.findByText(/There are no Routes yet/)).toBeTruthy();
    expect(screen.getByText('No Waves yet.')).toBeTruthy();
    expect(screen.getByText('No Runs yet.')).toBeTruthy();
    expect(screen.getByText('No quota buckets are in use yet.')).toBeTruthy();
  });

  it('[UI-020] shows the API error when the dashboard cannot load', async () => {
    mockApi((url) =>
      url.pathname === '/api/v1/dashboard'
        ? json({ type: 'x', title: 'x', status: 403, code: 'forbidden' }, 403)
        : undefined,
    );
    renderView();
    expect((await screen.findByRole('alert')).textContent).toContain('Your role does not allow');
  });

  it('[UI-020] [JOB-060] follows the lists and quota on the shell connection and refetches on events', async () => {
    mockApi();
    renderView();
    await screen.findByText('Wave one');
    await waitFor(() => {
      const open = FakeEventSource.instances.filter((s) => !s.closed);
      expect(open).toHaveLength(1); // one connection for the whole page
      expect(open[0]?.url).toContain('topics=list%3Amigrations,list%3Aruns,quota');
    });
    const source = FakeEventSource.instances.find((s) => !s.closed) as FakeEventSource;
    const count = (path: string) => calls.filter((c) => c.url.pathname === path).length;
    const before = { dash: count('/api/v1/dashboard'), quota: count('/api/v1/quota') };
    await act(async () => {
      source.onopen?.();
      source.emit(['quota']);
    });
    await waitFor(() => expect(count('/api/v1/quota')).toBe(before.quota + 1));
    expect(count('/api/v1/dashboard')).toBe(before.dash);
    await act(async () => {
      source.emit(['list:migrations']);
    });
    await waitFor(() => expect(count('/api/v1/dashboard')).toBe(before.dash + 1));
  });
});
