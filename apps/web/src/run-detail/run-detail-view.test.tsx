// @vitest-environment jsdom

import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../api/actor.ts';
import { ActorProvider } from '../shell/actor-context.tsx';
import { type Call, callsTo, json, mockApi, problem, rpcOf } from '../test-api.ts';
import { installMatchMedia, renderWithApp } from '../test-render.tsx';
import {
  LOG_PAGE,
  type MutationRow,
  type RunDetail,
  type RunLogRow,
  type RunStepRow,
  runRootKey,
} from './api.ts';
import { filterLines, ROW_HEIGHT, rankOf, VIEW_HEIGHT, visibleRange } from './log-viewer.tsx';
import { elapsed, errorSummary, RunDetailView } from './run-detail-view.tsx';

vi.setConfig({ testTimeout: 30_000 });

const followed: string[][] = [];
vi.mock('../shell/live-topics.tsx', () => ({
  useLiveTopics: (topics: readonly string[]) => {
    followed.push([...topics]);
  },
}));

const actor = (role: Actor['role']): Actor => ({
  id: 'a1',
  displayName: 'Ada',
  email: null,
  role,
  disabled: false,
});

const runRow = (extra: Partial<RunDetail> = {}): RunDetail => ({
  id: 'r1',
  migrationId: 'm1',
  kind: 'migrate',
  status: 'running',
  createdAt: '2026-10-02T10:00:00.000Z',
  startedAt: '2026-10-02T10:00:01.000Z',
  finishedAt: null,
  cancelRequestedAt: null,
  hasMutations: true,
  error: null,
  triggeredBy: { displayName: 'Ada' },
  migration: { id: 'm1', sourceRepository: { fullPath: 'ws/plat/api' } },
  ...extra,
});

const step = (n: number, extra: Partial<RunStepRow> = {}): RunStepRow => ({
  id: `s${n}`,
  stepKey: `step.${n}`,
  facetKey: null,
  order: n,
  status: 'succeeded',
  attempts: 1,
  startedAt: '2026-10-02T10:00:01.000Z',
  finishedAt: '2026-10-02T10:01:31.000Z',
  ...extra,
});

/** Log ids are zero-padded so their order is their sort order, as with UUIDv7. */
const line = (n: number, extra: Partial<RunLogRow> = {}): RunLogRow => ({
  id: `l${String(n).padStart(6, '0')}`,
  stepId: 's1',
  ts: '2026-10-02T10:00:02.000Z',
  level: 'info',
  message: `message ${n}`,
  ...extra,
});

const mutation = (n: number, extra: Partial<MutationRow> = {}): MutationRow => ({
  id: `mu${n}`,
  side: 'target',
  facetKey: 'branch-rules',
  action: 'create',
  paths: ['/rules[pattern=main]'],
  undoneAt: null,
  state: 'recorded',
  createdAt: '2026-10-02T10:00:03.000Z',
  ...extra,
});

interface World {
  run: RunDetail | null;
  steps: RunStepRow[];
  log: RunLogRow[];
  mutations: MutationRow[];
  cancel: () => Response;
}
let world: World;
let calls: readonly Call[] = [];
let client: QueryClient;

function start(role: Actor['role'] = 'operator') {
  installMatchMedia();
  const rows = {
    get run() {
      return world.run ? [world.run] : [];
    },
    get runStep() {
      return world.steps;
    },
    get mutation() {
      return world.mutations;
    },
  };
  const api = mockApi((url, init) => {
    if (init?.method === 'POST' && url.pathname === '/api/v1/runs/r1/cancel') return world.cancel();
    return undefined;
  }, rows);
  calls = api.calls;
  // The log is read by id, after the last line the page has: answer that from the world.
  const delegate = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const rpc = rpcOf(url);
    if (rpc?.model === 'runLog' && rpc.op === 'findMany') {
      (api.calls as Call[]).push({ url, ...(init ? { init } : {}) });
      const args = JSON.parse(url.searchParams.get('q') ?? '{}') as {
        where: { id?: { gt: string } };
        take: number;
      };
      const after = args.where.id?.gt ?? '';
      return json({ data: world.log.filter((l) => l.id > after).slice(0, args.take) });
    }
    return delegate(input, init);
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithApp(
    <ActorProvider value={actor(role)}>
      <RunDetailView id="r1" />
    </ActorProvider>,
    client,
  );
}

beforeEach(() => {
  world = {
    run: runRow(),
    steps: [step(1), step(2, { status: 'running', finishedAt: null })],
    log: [line(1), line(2, { level: 'warn' }), line(3, { level: 'error' })],
    mutations: [mutation(1)],
    cancel: () => json({ runId: 'r1', outcome: 'requested' }),
  };
  followed.length = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('[UI-023] the log viewer helpers', () => {
  it('[UI-023] ranks levels and treats an unknown level as info', () => {
    expect(rankOf('ERROR')).toBe(3);
    expect(rankOf('warn')).toBe(2);
    expect(rankOf('whatever')).toBe(1);
  });

  it('[UI-023] filters lines to a level and above', () => {
    const lines = [
      line(1, { level: 'debug' }),
      line(2),
      line(3, { level: 'warn' }),
      line(4, { level: 'error' }),
    ];
    expect(filterLines(lines, 'all')).toHaveLength(4);
    expect(filterLines(lines, 'info')).toHaveLength(3);
    expect(filterLines(lines, 'warn')).toHaveLength(2);
    expect(filterLines(lines, 'error').map((l) => l.level)).toEqual(['error']);
  });

  it('[UI-023] renders only the window in view plus a margin', () => {
    expect(visibleRange(0, 100_000)).toEqual({
      start: 0,
      end: Math.ceil(VIEW_HEIGHT / ROW_HEIGHT) + 10,
    });
    const middle = visibleRange(50_000 * ROW_HEIGHT, 100_000);
    expect(middle.end - middle.start).toBeLessThan(60);
    expect(visibleRange(0, 3).end).toBe(3);
  });

  it('[UI-023] measures elapsed time, and nothing before a start', () => {
    expect(elapsed(null, null, 0)).toBeNull();
    expect(elapsed('2026-10-02T10:00:00.000Z', '2026-10-02T10:01:30.000Z', 0)).toEqual({
      unit: 'minutes',
      count: 2,
    });
    expect(
      elapsed('2026-10-02T10:00:00.000Z', null, Date.parse('2026-10-02T10:00:05.000Z')),
    ).toEqual({ unit: 'seconds', count: 5 });
    expect(elapsed('garbage', null, 0)).toBeNull();
  });

  it('[UI-023] summarizes a Run error to its code or message, never the raw object', () => {
    expect(errorSummary({ code: 'git.push-too-large', stack: 'secret' })).toBe(
      'git.push-too-large',
    );
    expect(errorSummary({ message: 'boom' })).toBe('boom');
    expect(errorSummary({ stack: 'x' })).toBeUndefined();
    expect(errorSummary('x')).toBeUndefined();
    expect(errorSummary(null)).toBeUndefined();
  });
});

describe('[UI-023] the Run page', () => {
  it('[UI-023] shows the Run, its steps with status and duration, and the Mutations it made', async () => {
    start();
    expect(await screen.findByRole('link', { name: 'Back to ws/plat/api' })).toBeTruthy();
    expect(screen.getByText('Migrate')).toBeTruthy();
    expect(screen.getAllByText('Running').length).toBeGreaterThan(0);
    expect((await screen.findAllByText('step.1')).length).toBeGreaterThan(0);
    expect(screen.getByText('2 minutes')).toBeTruthy();
    expect(screen.getByText('Succeeded')).toBeTruthy();
    expect(await screen.findByText('/rules[pattern=main]')).toBeTruthy();
    expect(screen.getByText('Created')).toBeTruthy();
    expect(followed).toContainEqual(['run:r1']);
  });

  it('[UI-023] a Run that does not exist says so', async () => {
    world.run = null;
    start();
    expect(await screen.findByText('This Run does not exist.')).toBeTruthy();
  });

  it('[UI-023] says so when the Run changed nothing yet and has no steps', async () => {
    world.steps = [];
    world.mutations = [];
    start();
    expect(await screen.findByText('No steps yet.')).toBeTruthy();
    expect(await screen.findByText('This Run has not changed anything yet.')).toBeTruthy();
  });

  it('[UI-023] shows a failed Run with a safe summary of its error', async () => {
    world.run = runRow({
      status: 'failed',
      finishedAt: '2026-10-02T10:02:00.000Z',
      error: { code: 'git.push-too-large', stack: 'do not show' },
    });
    start();
    expect(await screen.findByText('The Run failed: git.push-too-large')).toBeTruthy();
    expect(document.body.textContent).not.toContain('do not show');
  });
});

describe('[UI-023] the live log', () => {
  it('[UI-023] shows the log lines with their level and step', async () => {
    start();
    const log = await screen.findByRole('log', { name: 'Log' });
    await waitFor(() => expect(within(log).getByText('message 1')).toBeTruthy());
    expect(within(log).getByText('message 3')).toBeTruthy();
    expect(screen.getByText('3 of 3 lines')).toBeTruthy();
  });

  it('[UI-023] the level filter hides lines below the chosen level', async () => {
    start();
    const log = await screen.findByRole('log', { name: 'Log' });
    await waitFor(() => expect(within(log).getByText('message 1')).toBeTruthy());
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Show log lines of level' }));
    fireEvent.click(await screen.findByText('Errors only'));
    await waitFor(() => expect(within(log).queryByText('message 1')).toBeNull());
    expect(within(log).getByText('message 3')).toBeTruthy();
    expect(screen.getByText('1 of 3 lines')).toBeTruthy();
  });

  it('[UI-023] a long log renders only the lines in view', async () => {
    world.log = Array.from({ length: 5000 }, (_, i) => line(i + 1));
    start();
    await screen.findByText('5000 of 5000 lines');
    const log = screen.getByRole('log', { name: 'Log' });
    const rendered = log.querySelectorAll('div.absolute').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(80);
  });

  it('[JOB-060] a live update fetches only the lines after the last one it has', async () => {
    world.log = [line(1), line(2)];
    start();
    await screen.findByText('2 of 2 lines');
    world.log = [...world.log, line(3)];
    await act(async () => {
      await client.invalidateQueries({ queryKey: runRootKey('r1') });
    });
    await screen.findByText('3 of 3 lines');
    const fetches = calls
      .filter((c) => rpcOf(c.url)?.model === 'runLog')
      .map((c) => JSON.parse(c.url.searchParams.get('q') ?? '{}').where);
    expect(fetches[0]).toEqual({ runId: 'r1' });
    expect(fetches.at(-1)).toEqual({ runId: 'r1', id: { gt: line(2).id } });
  });

  it('[UI-023] pages through a log longer than one request', async () => {
    world.log = Array.from({ length: LOG_PAGE + 20 }, (_, i) => line(i + 1));
    start();
    await screen.findByText(`${LOG_PAGE + 20} of ${LOG_PAGE + 20} lines`);
  });

  it('[UI-023] turning Follow off keeps the checkbox state', async () => {
    start();
    const follow = (await screen.findByRole('checkbox', {
      name: 'Follow the end',
    })) as HTMLInputElement;
    expect(follow.checked).toBe(true);
    fireEvent.click(follow);
    expect(follow.checked).toBe(false);
  });
});

describe('[LIF-040] cancelling a Run', () => {
  it('[LIF-040] an operator can cancel a running Run and is told the cancel was requested', async () => {
    start();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel the Run' }));
    await waitFor(() => expect(callsTo(calls, 'POST', '/api/v1/runs/r1/cancel')).toHaveLength(1));
    expect((await screen.findAllByText(/Cancellation was requested/)).length).toBeGreaterThan(0);
  });

  it('[LIF-040] a cancel that found the Run already finished says so', async () => {
    world.cancel = () => problem(409, 'conflict');
    start();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel the Run' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/already finished/);
  });

  it('[AUTH-020] a viewer has no Cancel button', async () => {
    start('viewer');
    await screen.findAllByText('step.1');
    expect(screen.queryByRole('button', { name: 'Cancel the Run' })).toBeNull();
  });

  it('[LIF-040] a finished Run has no Cancel button', async () => {
    world.run = runRow({ status: 'succeeded', finishedAt: '2026-10-02T10:02:00.000Z' });
    start();
    await screen.findAllByText('step.1');
    expect(screen.queryByRole('button', { name: 'Cancel the Run' })).toBeNull();
  });

  it('[LIF-040] a Run whose cancel was already requested says so', async () => {
    world.run = runRow({ cancelRequestedAt: '2026-10-02T10:00:30.000Z' });
    start();
    expect((await screen.findAllByText(/Cancellation was requested/)).length).toBeGreaterThan(0);
  });
});
