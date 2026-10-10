// @vitest-environment jsdom

import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../api/actor.ts';
import { ActorProvider } from '../shell/actor-context.tsx';
import { LiveTopicsProvider } from '../shell/live-topics.tsx';
import { installMatchMedia, renderWithApp } from '../test-render.tsx';
import { EndpointMigrationView, runKindFor } from './endpoint-migration-view.tsx';
import { EndpointsView, migrationHref } from './endpoints-view.tsx';

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
let migration: Record<string, unknown> | null;

const MIGRATION = {
  id: 'm-end',
  status: 'analyzed',
  readiness: 'needs_attention',
  latestAnalysisId: 'an1',
  analysisStaleAt: null,
  route: {
    id: 'r1',
    sourceEndpointId: 'src',
    targetEndpointId: 'dst',
    targetNamespacePath: 'acme',
    sourceEndpoint: { displayName: 'Source' },
    targetEndpoint: { displayName: 'Target' },
  },
};

function mockApi() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      calls.push({ url, ...(init ? { init } : {}) });
      switch (url.pathname) {
        case '/api/model/endpoint/findMany':
          return json({
            data: [
              {
                id: 'src',
                displayName: 'Source',
                providerType: 'bitbucket-cloud',
                baseUrl: 'https://src.example',
                status: 'active',
              },
              {
                id: 'dst',
                displayName: 'Target',
                providerType: 'github',
                baseUrl: 'https://dst.example',
                status: 'active',
              },
            ],
          });
        case '/api/model/route/findMany':
          return json({
            data: [
              {
                id: 'r1',
                sourceEndpointId: 'src',
                targetEndpointId: 'dst',
                targetNamespacePath: 'acme',
              },
            ],
          });
        case '/api/model/repository/count':
          return json({ data: 7 });
        case '/api/model/identity/count':
          return json({ data: 12 });
        case '/api/model/group/count':
          return json({ data: 3 });
        case '/api/model/repository/findMany':
          return json({ data: [{ lastInventoriedAt: '2026-10-01T10:00:00.000Z' }] });
        case '/api/v1/dashboard':
          return json({
            generatedAt: '2026-10-01T00:00:00.000Z',
            routes: [
              {
                routeId: 'r1',
                sourceEndpointId: 'src',
                targetEndpointId: 'dst',
                total: 9,
                byStatus: {},
                byReadiness: {},
                endpointMigration: {
                  migrationId: 'm-end',
                  status: 'analyzed',
                  readiness: 'needs_attention',
                },
              },
            ],
            wavesTruncated: false,
            waves: [],
            recentRuns: [],
          });
        case '/api/model/migration/findMany':
          return json({ data: migration ? [migration] : [] });
        case '/api/model/planItem/findMany':
          return json({
            data: [
              {
                id: 'p1',
                facetKey: 'teams',
                kind: 'pre_task',
                code: 'teams.unmapped-principal',
                fieldPaths: ['/teams[slug=a]/members[principal=identity:1]'],
              },
              {
                id: 's1',
                facetKey: 'teams',
                kind: 'step',
                code: 'facet.teams.apply',
                fieldPaths: [],
              },
              {
                id: 's2',
                facetKey: 'org-variables',
                kind: 'step',
                code: 'facet.org-variables.apply',
                fieldPaths: [],
              },
              {
                id: 'p2',
                facetKey: 'members',
                kind: 'post_task',
                code: 'members.approve-invitations',
                fieldPaths: [],
              },
            ],
          });
        case '/api/v1/migrations/m-end/diff':
          return json({
            analyzedAt: '2026-10-01T00:00:00.000Z',
            facets: [
              {
                facetKey: 'teams',
                source: { teams: [{ slug: 'platform-team' }] },
                desired: { teams: [{ slug: 'platform-team' }] },
                target: { teams: [] },
                parity: { status: 'differs', diffs: [{ path: '/teams[slug=platform-team]' }] },
                expectedDifferences: [],
              },
            ],
          });
        case '/api/model/run/findMany':
          return json({
            data: [
              {
                id: 'run1',
                kind: 'run_anyway',
                status: 'succeeded',
                createdAt: '2026-10-01T09:00:00.000Z',
                startedAt: null,
                finishedAt: '2026-10-01T09:05:00.000Z',
              },
            ],
          });
        case '/api/v1/migrations/m-end/analyze':
          return json({ migrationId: 'm-end', queue: 'analysis-interactive' }, 202);
        case '/api/v1/migrations/m-end/runs':
          return json({ runId: 'run2' }, 202);
        default:
          return json({ type: 'x', title: 'x', status: 404, code: 'not_found' }, 404);
      }
    }),
  );
}
const count = (path: string) => calls.filter((c) => c.url.pathname === path).length;

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
  migration = MIGRATION;
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

describe('[UI-025] endpoints', () => {
  it('[UI-025] lists the Endpoints with counts and the last inventory, and the Routes with a link to the endpoint migration', async () => {
    renderWith(<EndpointsView />);
    expect(await screen.findByText('Source')).toBeTruthy();
    expect(screen.getByText('Target')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('12').length).toBe(2));
    expect(screen.getAllByText('7').length).toBe(2);
    expect(screen.getAllByText(/Oct 1, 2026/).length).toBeGreaterThan(0);
    const link = await screen.findByRole('link', { name: 'Open the endpoint migration' });
    expect(link.getAttribute('href')).toBe('/endpoints/routes/r1/migration');
    expect(migrationHref('a b')).toBe('/endpoints/routes/a%20b/migration');
    expect(await screen.findByText('Needs attention')).toBeTruthy();
  });

  it('[UI-025] is read-only: it offers no way to change an Endpoint or a Route', async () => {
    renderWith(<EndpointsView />);
    await screen.findByText('Source');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('[UI-025] [UI-001] refetches the counts when the inventory reports progress', async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    renderWith(
      <LiveTopicsProvider>
        <EndpointsView />
      </LiveTopicsProvider>,
    );
    await screen.findByText('Source');
    const live = () =>
      FakeEventSource.instances.find((i) => !i.closed && i.url.includes('list%3Arepositories'));
    await waitFor(() => expect(live()).toBeTruthy());
    const before = count('/api/model/group/count');
    await act(async () => {
      live()?.onopen?.();
      live()?.emit(['list:repositories']);
    });
    await waitFor(() => expect(count('/api/model/group/count')).toBeGreaterThan(before));
  });
});

describe('[UI-026] endpoint migration', () => {
  it('[UI-026] shows the findings by kind, the Facet diff and the Runs in the layout of UI-022', async () => {
    renderWith(<EndpointMigrationView routeId="r1" />);
    expect(await screen.findByText('Route Source to Target (acme)')).toBeTruthy();
    expect(await screen.findByText('teams.unmapped-principal')).toBeTruthy();
    expect(screen.getByText('members.approve-invitations')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Tasks before the Run' })).toBeTruthy();
    // The Facet strip: the worst finding per Facet, and a clean Facet with only a Step.
    expect(screen.getByLabelText(/org-variables.*no findings|org-variables/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Facets' }));
    fireEvent.click(await screen.findByRole('button', { name: /teams/ }));
    expect(await screen.findByText('Parity: differs')).toBeTruthy();
    expect((await screen.findAllByText(/platform-team/)).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    expect(await screen.findByText('Succeeded')).toBeTruthy();
    expect(screen.getAllByText('Run anyway').length).toBe(2);
  });

  it('[UI-026] an operator analyzes, and starts a Run anyway when readiness needs attention', async () => {
    renderWith(<EndpointMigrationView routeId="r1" />);
    await screen.findByText('Route Source to Target (acme)');
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    await waitFor(() => expect(count('/api/v1/migrations/m-end/analyze')).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Run anyway' }));
    await waitFor(() => expect(count('/api/v1/migrations/m-end/runs')).toBe(1));
    const post = calls.find((c) => c.url.pathname === '/api/v1/migrations/m-end/runs');
    expect(JSON.parse(String(post?.init?.body))).toEqual({ kind: 'run_anyway' });
    expect(await screen.findByText('Run queued.')).toBeTruthy();
  });

  it('[UI-026] a ready endpoint migration offers Migrate; a blocked or stale one offers no Run', () => {
    expect(runKindFor('analyzed', 'ready', false)).toBe('migrate');
    expect(runKindFor('analyzed', 'needs_attention', false)).toBe('run_anyway');
    expect(runKindFor('analyzed', 'blocked', false)).toBeUndefined();
    expect(runKindFor('analyzed', 'ready', true)).toBeUndefined();
    expect(runKindFor('running', 'ready', false)).toBeUndefined();
    expect(runKindFor('discovered', null, false)).toBeUndefined();
  });

  it('[LIF-077] [UI-026] a legacy endpoint migration of unknown place types the Namespace path to run', async () => {
    migration = {
      ...MIGRATION,
      readiness: 'blocked',
      blockerCodes: ['repository-settings.target-placement-unknown'],
      readinessCounts: { blockers: 1, preTasks: 0 },
      targetPlacementUnknown: true,
    };
    renderWith(<EndpointMigrationView routeId="r1" />);
    await screen.findByText('Route Source to Target (acme)');
    fireEvent.click(screen.getByRole('button', { name: 'Migrate' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/type acme to confirm it/)).toBeTruthy();
    const ok = dialog.getByRole('button', { name: 'Migrate' }) as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    expect(count('/api/v1/migrations/m-end/runs')).toBe(0);
    fireEvent.change(dialog.getByRole('textbox'), { target: { value: 'acme' } });
    expect(ok.disabled).toBe(false);
    fireEvent.click(ok);
    await waitFor(() => expect(count('/api/v1/migrations/m-end/runs')).toBe(1));
    const post = calls.find((c) => c.url.pathname === '/api/v1/migrations/m-end/runs');
    expect(JSON.parse(String(post?.init?.body))).toEqual({ kind: 'migrate', confirm: 'acme' });
    expect(await screen.findByText('Run queued.')).toBeTruthy();
  });

  it('[LIF-005] [UI-026] a legacy endpoint migration with another blocker offers no Run', async () => {
    migration = {
      ...MIGRATION,
      readiness: 'blocked',
      blockerCodes: ['repository-settings.target-placement-unknown', 'teams.missing'],
      readinessCounts: { blockers: 2, preTasks: 0 },
      targetPlacementUnknown: true,
    };
    renderWith(<EndpointMigrationView routeId="r1" />);
    await screen.findByText('Route Source to Target (acme)');
    expect((screen.getByRole('button', { name: 'Migrate' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('[UI-026] a viewer sees the page without the actions', async () => {
    renderWith(<EndpointMigrationView routeId="r1" />, 'viewer');
    await screen.findByText('Route Source to Target (acme)');
    expect(screen.queryByRole('button', { name: 'Analyze' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run anyway' })).toBeNull();
  });

  it('[UI-026] a Route without an endpoint migration says so', async () => {
    migration = null;
    renderWith(<EndpointMigrationView routeId="r1" />);
    expect(await screen.findByText(/has no endpoint migration yet/)).toBeTruthy();
  });

  it('[UI-026] an endpoint migration that was never analyzed has no findings to show', async () => {
    migration = { ...MIGRATION, latestAnalysisId: null, status: 'discovered', readiness: null };
    renderWith(<EndpointMigrationView routeId="r1" />);
    expect(
      await screen.findByText('This endpoint migration has not been analyzed yet.'),
    ).toBeTruthy();
    expect(within(document.body).queryByText('teams.unmapped-principal')).toBeNull();
  });

  it('[UI-026] [UI-001] refetches the Migration and its Runs when they change', async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    renderWith(
      <LiveTopicsProvider>
        <EndpointMigrationView routeId="r1" />
      </LiveTopicsProvider>,
    );
    await screen.findByText('Route Source to Target (acme)', {}, { timeout: 10_000 });
    const live = () =>
      FakeEventSource.instances.find((i) => !i.closed && i.url.includes('migration%3Am-end'));
    await waitFor(() => expect(live()).toBeTruthy(), { timeout: 10_000 });
    const before = count('/api/model/migration/findMany');
    await act(async () => {
      live()?.onopen?.();
      live()?.emit(['migration:m-end']);
    });
    await waitFor(() => expect(count('/api/model/migration/findMany')).toBeGreaterThan(before), {
      timeout: 10_000,
    });
  }, 30_000);
});
