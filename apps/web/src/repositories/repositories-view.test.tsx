// @vitest-environment jsdom

import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../api/actor.ts';
import { ActorProvider } from '../shell/actor-context.tsx';
import { installMatchMedia, renderWithApp } from '../test-render.tsx';
import type { RepositoryRow } from './api.ts';
import { RepositoriesView } from './repositories-view.tsx';

// antd tables are slow to render in jsdom, more so when the whole suite runs at once.
vi.setConfig({ testTimeout: 30_000 });

const actor = (role: Actor['role']): Actor => ({
  id: 'a1',
  displayName: 'Ada',
  email: null,
  role,
  disabled: false,
});

const row = (n: number, extra: Partial<RepositoryRow> = {}): RepositoryRow => ({
  id: `m${n}`,
  status: 'analyzed',
  readiness: 'ready',
  readinessCounts: { blockers: 0, preTasks: 1, postTasks: 2 },
  plannedTargetName: `plat-repo-${n}`,
  blockerCodes: [],
  waveId: null,
  sourceRepository: {
    id: `r${n}`,
    name: `repo-${n}`,
    fullPath: `acme/plat/repo-${n}`,
    sizeBytes: String(2 * 1024 ** 3),
    sizeClass: 'standard',
  },
  wave: null,
  latestAnalysis: {
    createdAt: '2026-10-01T10:00:00.000Z',
    items: [{ facetKey: 'branch-rules', kind: 'pre_task' }],
  },
  runs: [],
  ...extra,
});

const ALL = Array.from({ length: 12 }, (_, i) => row(i + 1));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  readonly url: URL;
  readonly init?: RequestInit;
}
let calls: Call[] = [];
let source: readonly RepositoryRow[] = ALL;

function mockApi(extra?: (url: URL, init?: RequestInit) => Response | undefined) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      calls.push({ url, ...(init ? { init } : {}) });
      const custom = extra?.(url, init);
      if (custom) return custom;
      const q = url.searchParams.get('q');
      const args = q ? (JSON.parse(q) as { skip?: number; take?: number }) : {};
      switch (url.pathname) {
        case '/api/v1/routes':
          return json({ items: [{ id: 'r1', sourceEndpointId: 'e1', targetEndpointId: 'e2' }] });
        case '/api/model/migration/findMany':
          return json({
            data: source.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 50)),
          });
        case '/api/model/migration/count':
          return json({ data: source.length });
        case '/api/model/namespace/findMany':
          return json({ data: [{ id: 'ns1', name: 'Platform', slug: 'plat' }] });
        case '/api/model/wave/findMany':
          return json({ data: [{ id: 'w1', name: 'Wave one' }] });
        default:
          return json({ type: 'x', title: 'x', status: 404, code: 'not_found' }, 404);
      }
    }),
  );
}

const lists = () => calls.filter((c) => c.url.pathname === '/api/model/migration/findMany');
const lastArgs = () =>
  JSON.parse(lists().at(-1)?.url.searchParams.get('q') as string) as {
    where: Record<string, unknown>;
    orderBy: Record<string, unknown>[];
    skip: number;
    take: number;
  };
const posts = () => calls.filter((c) => c.init?.method === 'POST');

const twoRoutes = (url: URL) =>
  url.pathname === '/api/v1/routes'
    ? json({
        items: [
          { id: 'r1', sourceEndpointId: 'e1', targetEndpointId: 'e2' },
          { id: 'r2', sourceEndpointId: 'e3', targetEndpointId: 'e2' },
        ],
      })
    : undefined;

const fresh = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderView = (role: Actor['role'] = 'operator', props = {}) =>
  renderWithApp(
    <ActorProvider value={actor(role)}>
      <RepositoriesView pageSize={5} {...props} />
    </ActorProvider>,
    fresh(),
  );

beforeEach(() => {
  installMatchMedia(false);
  source = ALL;
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

const rowOf = (text: string) =>
  screen.getAllByRole('row').find((r) => within(r).queryByText(text)) as HTMLElement;
// A role query over 50 antd rows takes seconds in jsdom; the attribute selector is instant.
const checkbox = (path: string) =>
  document.querySelector(`input[aria-label="Select ${path}"]`) as HTMLInputElement;

describe('[UI-021] repositories list', () => {
  it('[UI-021] asks the server for the first 50 unmigrated repositories and shows the columns', async () => {
    mockApi();
    renderView();
    expect(await screen.findByText('acme/plat/repo-1')).toBeTruthy();
    const args = lastArgs();
    expect(args.take).toBe(5);
    expect(args.skip).toBe(0);
    expect(args.where).toMatchObject({ scope: 'repository', routeId: 'r1' });
    expect(args.where.status).toEqual({ notIn: ['verified', 'manually_completed'] });
    expect(screen.getByText('12 repositories')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(6); // header + one page of 5, not all 12

    const first = rowOf('acme/plat/repo-1');
    expect(within(first).getByText('plat-repo-1')).toBeTruthy();
    expect(within(first).getByText('Analyzed')).toBeTruthy();
    expect(within(first).getByText('Ready')).toBeTruthy();
    expect(within(first).getByText('0 blockers, 1 pre, 2 post')).toBeTruthy();
    expect(within(first).getByText('branch-rules')).toBeTruthy();
    expect(within(first).getByText('2.0 GiB')).toBeTruthy();
    expect(within(first).getByText('No Wave')).toBeTruthy();
    expect(within(first).getByText('Never')).toBeTruthy();
    // The date comes from formatDateTime (UI-001).
    expect(within(first).getByText(/2026/)).toBeTruthy();
  });

  it('[UI-021] paging asks the server for the next page', async () => {
    mockApi();
    renderView();
    await screen.findByText('acme/plat/repo-1');
    fireEvent.click(screen.getByTitle('2'));
    expect(await screen.findByText('acme/plat/repo-6')).toBeTruthy();
    expect(lastArgs().skip).toBe(5);
    expect(screen.queryByText('acme/plat/repo-1')).toBeNull();
  });

  it('[UI-021] sorting sends the order to the server and returns to page 1', async () => {
    mockApi();
    renderView();
    await screen.findByText('acme/plat/repo-1');
    fireEvent.click(screen.getByTitle('2'));
    await screen.findByText('acme/plat/repo-6');
    fireEvent.click(screen.getByRole('columnheader', { name: /Planned target name/ }));
    await waitFor(() => expect(lastArgs().orderBy[0]).toEqual({ plannedTargetName: 'asc' }));
    expect(lastArgs().skip).toBe(0);
    fireEvent.click(screen.getByRole('columnheader', { name: /Planned target name/ }));
    await waitFor(() => expect(lastArgs().orderBy[0]).toEqual({ plannedTargetName: 'desc' }));
  });

  it('[UI-021] filters are sent to the server and reset the page', async () => {
    mockApi();
    renderView();
    await screen.findByText('acme/plat/repo-1');
    fireEvent.click(screen.getByTitle('2'));
    await screen.findByText('acme/plat/repo-6');

    fireEvent.click(screen.getByLabelText('Has open tasks'));
    await waitFor(() => expect(lastArgs().where.manualTasks).toEqual({ some: { status: 'open' } }));
    expect(lastArgs().skip).toBe(0);

    const search = screen.getByRole('searchbox', { name: 'Search name and path' });
    fireEvent.change(search, { target: { value: 'repo-7' } });
    fireEvent.keyDown(search, { key: 'Enter', keyCode: 13 });
    await waitFor(() =>
      expect(lastArgs().where.sourceRepository).toMatchObject({
        OR: [{ name: { contains: 'repo-7' } }, { fullPath: { contains: 'repo-7' } }],
      }),
    );

    const blocker = screen.getByRole('searchbox', { name: 'Blocker code' });
    fireEvent.change(blocker, { target: { value: 'naming.collision' } });
    fireEvent.keyDown(blocker, { key: 'Enter', keyCode: 13 });
    await waitFor(() => expect(lastArgs().where.blockerCodes).toEqual({ has: 'naming.collision' }));
  });

  it('[UI-021] the status, readiness, size, Wave and project filters offer the server values', async () => {
    mockApi();
    renderView();
    await screen.findByText('acme/plat/repo-1');
    // The project and Wave options come from the Model API, not from the shown page.
    await waitFor(() => {
      expect(calls.some((c) => c.url.pathname === '/api/model/namespace/findMany')).toBe(true);
      expect(calls.some((c) => c.url.pathname === '/api/model/wave/findMany')).toBe(true);
    });
    for (const name of ['Status', 'Readiness', 'Size class', 'Wave', 'Source project', 'Route']) {
      expect(screen.getByRole('combobox', { name })).toBeTruthy();
    }
  });

  it('[UI-021] selection persists across pages', async () => {
    mockApi();
    renderView('operator', {
      bulkBar: (selection: { ids: readonly string[] }) => (
        <span data-testid="bulk">{selection.ids.join(',')}</span>
      ),
    });
    await screen.findByText('acme/plat/repo-1');
    fireEvent.click(checkbox('acme/plat/repo-1'));
    fireEvent.click(checkbox('acme/plat/repo-2'));
    fireEvent.click(screen.getByTitle('2'));
    await screen.findByText('acme/plat/repo-6');
    fireEvent.click(checkbox('acme/plat/repo-6'));
    expect(screen.getByText('3 selected')).toBeTruthy();
    expect(screen.getByTestId('bulk').textContent).toBe('m1,m2,m6');

    // Back on page 1 the rows selected earlier are still checked; unchecking one removes only it.
    fireEvent.click(screen.getByTitle('1'));
    await screen.findByText('acme/plat/repo-1');
    expect(checkbox('acme/plat/repo-1').checked).toBe(true);
    fireEvent.click(checkbox('acme/plat/repo-1'));
    expect(screen.getByTestId('bulk').textContent).toBe('m2,m6');

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it('[UI-021] selection survives a filter change and says how many selected rows the filters hide', async () => {
    mockApi((url) => {
      const q = url.searchParams.get('q') ?? '';
      // The hidden-rows check asks for the selected ids inside the filters: none of them match.
      if (url.pathname === '/api/model/migration/count' && q.includes('"AND"')) {
        return json({ data: 0 });
      }
      return undefined;
    });
    renderView();
    await screen.findByText('acme/plat/repo-1');
    fireEvent.click(checkbox('acme/plat/repo-1'));
    expect(screen.getByText('1 selected')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Has open tasks'));
    await waitFor(() => expect(lastArgs().where.manualTasks).toBeDefined());
    expect(await screen.findByText('1 selected (1 hidden by filters)')).toBeTruthy();
    const check = calls.find((c) => (c.url.searchParams.get('q') ?? '').includes('"AND"'));
    expect(JSON.parse(check?.url.searchParams.get('q') as string).where.AND[1]).toEqual({
      id: { in: ['m1'] },
    });
  });

  it('[UI-021] changing the Route clears the selection', async () => {
    mockApi(twoRoutes);
    renderView();
    await screen.findByText('acme/plat/repo-1');
    fireEvent.click(checkbox('acme/plat/repo-1'));
    expect(screen.getByText('1 selected')).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Route' }));
    fireEvent.click(await screen.findByTitle('r2'));
    await waitFor(() => expect(lastArgs().where.routeId).toBe('r2'));
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it('[UI-021] a link to an unknown Route says so and shows the first Route', async () => {
    mockApi(twoRoutes);
    renderView('operator', { initialRouteId: 'gone', initialFilters: { status: 'failed' } });
    expect(await screen.findByText('Route gone was not found. Showing r1 instead.')).toBeTruthy();
    expect(lastArgs().where.routeId).toBe('r1');
  });

  it('[UI-021] the page can open pre-filtered (links from the dashboard)', async () => {
    mockApi(twoRoutes);
    renderView('operator', { initialRouteId: 'r2', initialFilters: { status: 'failed' } });
    await screen.findByText('acme/plat/repo-1');
    expect(lastArgs().where).toMatchObject({ routeId: 'r2', status: 'failed' });
  });

  it('[UI-021] [UI-022] the Facet strip has a badge for a clean Facet too', async () => {
    source = [
      row(1, {
        latestAnalysis: {
          createdAt: '2026-10-01T10:00:00.000Z',
          items: [
            { facetKey: 'refs', kind: 'step' },
            { facetKey: 'hooks', kind: 'blocker' },
          ],
        },
      }),
    ];
    mockApi();
    renderView();
    await screen.findByText('acme/plat/repo-1');
    expect(screen.getByLabelText('refs: no findings')).toBeTruthy();
    expect(screen.getByLabelText('hooks: 1 blocker')).toBeTruthy();
  });

  it('[UI-021] [LIF-005] Migrate is offered on a ready row, Run anyway on a needs-attention row, neither on a blocked one', async () => {
    source = [
      row(1, { readiness: 'ready' }),
      row(2, { readiness: 'needs_attention' }),
      row(3, { readiness: 'blocked' }),
      row(4, { readiness: 'ready', status: 'running' }),
    ];
    mockApi();
    renderView();
    await screen.findByText('acme/plat/repo-1');
    const names = (path: string) =>
      within(rowOf(path))
        .getAllByRole('button')
        .map((b) => b.textContent);
    expect(names('acme/plat/repo-1')).toEqual(['Analyze', 'Migrate']);
    expect(names('acme/plat/repo-2')).toEqual(['Analyze', 'Run anyway']);
    expect(names('acme/plat/repo-3')).toEqual(['Analyze']);
    expect(names('acme/plat/repo-4')).toEqual(['Analyze']);
  });

  it('[UI-021] [LIF-005] Migrate asks for confirmation, then posts a migrate Run', async () => {
    source = [row(1, { readiness: 'ready' })];
    mockApi((url, init) =>
      init?.method === 'POST' ? json({ runId: 'run1', migrationId: url.pathname }, 202) : undefined,
    );
    renderView();
    await screen.findByText('acme/plat/repo-1');
    fireEvent.click(screen.getByRole('button', { name: 'Migrate' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Migrate acme/plat/repo-1?')).toBeTruthy();
    expect(posts()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Migrate' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.url.pathname).toBe('/api/v1/migrations/m1/runs');
    expect(JSON.parse(posts()[0]?.init?.body as string)).toEqual({ kind: 'migrate' });
    expect(await screen.findByText('Request accepted.')).toBeTruthy();
  });

  it('[UI-021] [LIF-006] Run anyway confirms, names the open tasks it skips and posts a run_anyway Run', async () => {
    source = [
      row(2, { readiness: 'needs_attention', readinessCounts: { blockers: 0, preTasks: 3 } }),
    ];
    mockApi((url, init) =>
      init?.method === 'POST' ? json({ runId: 'run2', migrationId: url.pathname }, 202) : undefined,
    );
    renderView();
    await screen.findByText('acme/plat/repo-2');
    fireEvent.click(screen.getByRole('button', { name: 'Run anyway' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('3 open tasks will not be done by the Run.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Run anyway' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Run anyway' }),
    );
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.url.pathname).toBe('/api/v1/migrations/m2/runs');
    expect(JSON.parse(posts()[0]?.init?.body as string)).toEqual({ kind: 'run_anyway' });
  });

  it.each([
    [409, 'run_active', 'already has a queued or running Run'],
    [409, 'conflict', 'cannot start a Run right now'],
    [409, 'run_not_permitted', 'current status does not allow this Run'],
    [422, 'readiness_required', 'readiness changed'],
    [422, 'validation_failed', 'was not accepted for this repository'],
  ])(
    '[UI-021] [DOM-010] [LIF-005] a %i %s answer to a Run has its own message',
    async (status, code, text) => {
      source = [row(1, { readiness: 'ready' })];
      mockApi((_url, init) =>
        init?.method === 'POST' ? json({ type: 'x', title: 'x', status, code }, status) : undefined,
      );
      renderView();
      await screen.findByText('acme/plat/repo-1');
      fireEvent.click(screen.getByRole('button', { name: 'Migrate' }));
      fireEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Migrate' }),
      );
      expect((await screen.findByRole('alert')).textContent).toContain(text);
      expect(screen.queryByText('Request accepted.')).toBeNull();
    },
  );

  it('[UI-021] a conflict on Analyze has its own message', async () => {
    source = [row(1)];
    mockApi((_url, init) =>
      init?.method === 'POST'
        ? json({ type: 'x', title: 'x', status: 409, code: 'conflict' }, 409)
        : undefined,
    );
    renderView();
    await screen.findByText('acme/plat/repo-1');
    fireEvent.click(within(rowOf('acme/plat/repo-1')).getByRole('button', { name: 'Analyze' }));
    expect((await screen.findByRole('alert')).textContent).toContain('source is missing');
  });

  it('[UI-021] [LIF-090] an operator gets the bulk bar by default and a viewer does not', async () => {
    mockApi();
    renderView('operator');
    await screen.findByText('acme/plat/repo-1');
    expect(screen.getByRole('group', { name: 'Bulk actions' })).toBeTruthy();
    cleanup();
    mockApi();
    renderView('viewer');
    await screen.findByText('acme/plat/repo-1');
    expect(screen.queryByRole('group', { name: 'Bulk actions' })).toBeNull();
  });

  it('[UI-021] a viewer sees the list without row actions', async () => {
    mockApi();
    renderView('viewer');
    await screen.findByText('acme/plat/repo-1');
    expect(screen.queryByRole('button', { name: 'Analyze' })).toBeNull();
    expect(screen.queryByText('Actions')).toBeNull();
  });

  it('[UI-021] an API error is shown with its problem message', async () => {
    mockApi((url) =>
      url.pathname === '/api/model/migration/findMany'
        ? json({ type: 'x', title: 'x', status: 403, code: 'forbidden' }, 403)
        : undefined,
    );
    renderView();
    expect((await screen.findByRole('alert')).textContent).toContain('Your role does not allow');
  });

  it('[UI-021] says so when there are no Routes', async () => {
    mockApi((url) => (url.pathname === '/api/v1/routes' ? json({ items: [] }) : undefined));
    renderView();
    expect(await screen.findByText(/There are no Routes yet/)).toBeTruthy();
  });
});
