// @vitest-environment jsdom

import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../api/actor.ts';
import { ActorProvider } from '../shell/actor-context.tsx';
import { bodyOf, type Call, callsTo, json, mockApi, problem, rpcOf } from '../test-api.ts';
import { installMatchMedia, renderWithApp } from '../test-render.tsx';
import type { MigrationDetail } from './api.ts';
import { MigrationDetailView } from './detail-view.tsx';
import { diff, diffFacet, migration, run, task } from './fixtures.ts';

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

interface World {
  migration: MigrationDetail | null;
  runs: ReturnType<typeof run>[];
  tasks: ReturnType<typeof task>[];
  diff: ReturnType<typeof diff>;
  /** Overrides for the custom endpoints, by `METHOD path`. */
  responses: Record<string, () => Response>;
}
let world: World;
let calls: readonly Call[] = [];

const fresh = (): World => ({
  migration: migration(),
  runs: [],
  tasks: [],
  diff: diff(),
  responses: {},
});

function start(role: Actor['role'] = 'operator') {
  installMatchMedia();
  // The rows are read when a request arrives, so a test can change the world after rendering.
  const rows = {
    get migration() {
      return world.migration ? [world.migration] : [];
    },
    get run() {
      return world.runs;
    },
    get manualTask() {
      return world.tasks;
    },
    auditEvent: [],
    wave: [{ id: 'w1', name: 'Wave one' }],
  };
  const api = mockApi((url, init) => {
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    const custom = world.responses[key];
    if (custom) return custom();
    if (url.pathname === '/api/v1/migrations/m1/diff') return json(world.diff);
    if (key.startsWith('POST /api/v1/') || key.startsWith('DELETE /api/v1/')) {
      return json({ runId: 'run-new' }, 202);
    }
    return undefined;
  }, rows);
  calls = api.calls;
  return renderWithApp(
    <ActorProvider value={actor(role)}>
      <MigrationDetailView id="m1" />
    </ActorProvider>,
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
}

/** The page has loaded: its title is the source path. */
const ready = () => screen.findByRole('heading', { level: 2, name: 'ws/plat/api' });

const posted = (path: string) => callsTo(calls, 'POST', path);

beforeEach(() => {
  world = fresh();
  followed.length = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('[UI-022] the repository detail header', () => {
  it('[UI-022] shows the source, target, status, readiness and counts, and follows its live topic', async () => {
    start();
    expect(await ready()).toBeTruthy();
    expect(screen.getByText('acme-org/plat-api')).toBeTruthy();
    expect(screen.getByText('Planned')).toBeTruthy();
    expect(screen.getByText('Analyzed')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByText(/0 blockers, 0 pre, 1 post/)).toBeTruthy();
    expect(followed).toContainEqual(['migration:m1']);
  });

  it('[UI-022] a repository that does not exist says so', async () => {
    world.migration = null;
    start();
    expect(await screen.findByText('This repository does not exist.')).toBeTruthy();
  });

  it('[AUTH-020] a viewer sees the page and no action, and cannot change the Wave', async () => {
    start('viewer');
    await ready();
    for (const name of ['Analyze', 'Migrate', 'Mark complete']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByRole('combobox', { name: 'Wave' })).toBeNull();
    expect(screen.getByText('No Wave')).toBeTruthy();
  });

  it('[UI-022] an operator can assign a Wave through the one RPC write allowed', async () => {
    start();
    const select = await screen.findByRole('combobox', { name: 'Wave' });
    fireEvent.mouseDown(select);
    fireEvent.click(await screen.findByText('Wave one'));
    await waitFor(() => {
      const update = calls.find((c) => rpcOf(c.url)?.op === 'update');
      expect(update && bodyOf(update)).toMatchObject({
        where: { id: 'm1' },
        data: { waveId: 'w1' },
      });
    });
  });

  it('[LIF-021] says when the analysis is out of date', async () => {
    world.migration = migration({ analysisStaleAt: '2026-10-02T00:00:00.000Z' });
    start();
    expect(await screen.findByText(/analysis is out of date/)).toBeTruthy();
  });
});

describe('[UI-022] the header actions are wired to their endpoints', () => {
  const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
  const dialog = () => within(screen.getByRole('dialog'));

  it('[UI-022] Analyze posts to the analyze endpoint', async () => {
    start();
    await ready();
    click('Analyze');
    await waitFor(() => expect(posted('/api/v1/migrations/m1/analyze')).toHaveLength(1));
    expect(await screen.findByText('The analysis was queued.')).toBeTruthy();
  });

  it('[LIF-005] Migrate confirms, posts the kind, and links to the new Run', async () => {
    start();
    await ready();
    click('Migrate');
    expect(dialog().getByText(/starts a migration Run to acme-org\/plat-api/)).toBeTruthy();
    fireEvent.click(dialog().getByRole('button', { name: 'Migrate' }));
    await waitFor(() => expect(posted('/api/v1/migrations/m1/runs')).toHaveLength(1));
    expect(bodyOf(posted('/api/v1/migrations/m1/runs')[0])).toEqual({ kind: 'migrate' });
    const link = await screen.findByRole('link', { name: 'Open the Run' });
    expect(link.getAttribute('href')).toBe('/runs/run-new');
  });

  it('[LIF-070] the per-Migration opt-out of source read-only travels as a Run option', async () => {
    start();
    await ready();
    click('Migrate');
    fireEvent.click(dialog().getByRole('checkbox'));
    fireEvent.click(dialog().getByRole('button', { name: 'Migrate' }));
    await waitFor(() => expect(posted('/api/v1/migrations/m1/runs')).toHaveLength(1));
    expect(bodyOf(posted('/api/v1/migrations/m1/runs')[0])).toEqual({
      kind: 'migrate',
      options: { skipSourceReadOnly: true },
    });
  });

  it('[LIF-043] Run anyway names the open pre tasks it skips', async () => {
    world.migration = migration({
      readiness: 'needs_attention',
      readinessCounts: { blockers: 0, preTasks: 2, postTasks: 0 },
    });
    start();
    await ready();
    expect(screen.queryByRole('button', { name: 'Migrate' })).toBeNull();
    click('Run anyway');
    expect(dialog().getByText('2 open tasks will not be done by the Run.')).toBeTruthy();
    fireEvent.click(dialog().getByRole('button', { name: 'Run anyway' }));
    await waitFor(() => expect(posted('/api/v1/migrations/m1/runs')).toHaveLength(1));
    expect(bodyOf(posted('/api/v1/migrations/m1/runs')[0])).toMatchObject({ kind: 'run_anyway' });
  });

  it('[LIF-043] Force adopt needs the exact target full name and sends it with adoptNonEmpty', async () => {
    world.migration = migration({
      readiness: 'blocked',
      blockerCodes: ['target.exists-nonempty'],
    });
    start();
    await ready();
    click('Force adopt target');
    const confirm = dialog().getByRole('button', { name: 'Force adopt and migrate' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    const input = dialog().getByRole('textbox');
    fireEvent.change(input, { target: { value: 'ACME-ORG/plat-api' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'acme-org/plat-api' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(posted('/api/v1/migrations/m1/runs')).toHaveLength(1));
    expect(bodyOf(posted('/api/v1/migrations/m1/runs')[0])).toEqual({
      kind: 'migrate',
      options: { adoptNonEmpty: true },
      confirm: 'acme-org/plat-api',
    });
  });

  const migrated = () =>
    migration({
      status: 'migrated',
      targetRepository: { id: 't1', fullPath: 'acme-org/plat-api' },
      targetCreatedByFramework: true,
    });

  it('[LIF-077] Rollback needs the exact target name typed and posts it as confirm', async () => {
    world.migration = migrated();
    start();
    await ready();
    click('Roll back');
    expect(dialog().getByText(/deletes the target repository acme-org\/plat-api/)).toBeTruthy();
    const confirm = dialog().getByRole('button', { name: 'Roll back' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(dialog().getByRole('textbox'), { target: { value: 'acme-org/plat-api' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(posted('/api/v1/migrations/m1/runs')).toHaveLength(1));
    expect(bodyOf(posted('/api/v1/migrations/m1/runs')[0])).toEqual({
      kind: 'rollback',
      confirm: 'acme-org/plat-api',
    });
  });

  it('[LIF-077] with the source read-only, Rollback first offers to undo it', async () => {
    world.migration = { ...migrated(), sourceReadOnlyApplied: true };
    start();
    await ready();
    click('Roll back');
    expect(dialog().getByText(/must be writable again/)).toBeTruthy();
    fireEvent.change(dialog().getByRole('textbox'), { target: { value: 'acme-org/plat-api' } });
    fireEvent.click(dialog().getByRole('button', { name: 'Undo source read-only' }));
    await waitFor(() => expect(posted('/api/v1/migrations/m1/runs')).toHaveLength(1));
    expect(bodyOf(posted('/api/v1/migrations/m1/runs')[0])).toMatchObject({
      kind: 'undo_source_read_only',
      confirm: 'acme-org/plat-api',
    });
  });

  it('[UI-001] Undo source read-only is a destructive action that asks for the target name', async () => {
    world.migration = { ...migrated(), sourceReadOnlyApplied: true };
    start();
    await ready();
    click('Undo source read-only');
    const confirm = dialog().getByRole('button', { name: 'Undo read-only' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(dialog().getByRole('textbox'), { target: { value: 'acme-org/plat-api' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(posted('/api/v1/migrations/m1/runs')).toHaveLength(1));
  });

  it('[LIF-040] Resync, Verify and Make source read-only each confirm and post their own kind', async () => {
    world.migration = migrated();
    start();
    await ready();
    const kinds: [string, string, string][] = [
      ['Resync', 'Resync', 'resync'],
      ['Verify', 'Verify', 'verify'],
      ['Make source read-only', 'Make read-only', 'source_read_only'],
    ];
    for (const [i, [button, ok, kind]] of kinds.entries()) {
      click(button);
      fireEvent.click(dialog().getByRole('button', { name: ok }));
      await waitFor(() => expect(posted('/api/v1/migrations/m1/runs')).toHaveLength(i + 1));
      expect(bodyOf(posted('/api/v1/migrations/m1/runs')[i])).toMatchObject({ kind });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
  });

  it('[LIF-075] Mark complete needs a reason and posts it; Revoke deletes the completion', async () => {
    start();
    await ready();
    click('Mark complete');
    const ok = dialog().getByRole('button', { name: 'Mark complete' });
    expect((ok as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(dialog().getByRole('textbox'), { target: { value: 'Done by hand' } });
    fireEvent.click(ok);
    await waitFor(() => expect(posted('/api/v1/migrations/m1/complete')).toHaveLength(1));
    expect(bodyOf(posted('/api/v1/migrations/m1/complete')[0])).toEqual({ reason: 'Done by hand' });

    cleanup();
    world.migration = migration({
      status: 'manually_completed',
      targetRepository: { id: 't1', fullPath: 'acme-org/plat-api' },
    });
    start();
    await ready();
    click('Revoke completion');
    fireEvent.click(dialog().getByRole('button', { name: 'Revoke' }));
    await waitFor(() =>
      expect(callsTo(calls, 'DELETE', '/api/v1/migrations/m1/complete')).toHaveLength(1),
    );
  });

  it('[DOM-010] every action waits while a Run is active and points to it', async () => {
    world.migration = migration({ status: 'running' });
    world.runs = [run(1, { status: 'running', finishedAt: null })];
    start();
    await ready();
    const analyze = (await screen.findByRole('button', { name: 'Analyze' })) as HTMLButtonElement;
    expect(analyze.disabled).toBe(true);
    expect(screen.getByText(/queued or running, so other actions wait/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the Run' }).getAttribute('href')).toBe(
      '/runs/run1',
    );
  });
});

describe('[API-011] each Run problem code reads as its own message', () => {
  const cases: [number, string, RegExp][] = [
    [409, 'run_active', /already has a queued or running Run/],
    [409, 'run_not_permitted', /current status does not allow this Run/],
    [422, 'readiness_required', /readiness does not allow this Run/],
    [422, 'confirmation_required', /not the exact target name/],
  ];
  for (const [status, code, text] of cases) {
    it(`[LIF-005] ${code} shows its own text and refreshes the page`, async () => {
      world.responses['POST /api/v1/migrations/m1/runs'] = () => problem(status, code);
      start();
      await ready();
      const before = calls.filter((c) => rpcOf(c.url)?.model === 'migration').length;
      fireEvent.click(screen.getByRole('button', { name: 'Migrate' }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Migrate' }));
      const alert = await within(screen.getByRole('dialog')).findByRole('alert');
      expect(alert.textContent).toMatch(text);
      await waitFor(() =>
        expect(calls.filter((c) => rpcOf(c.url)?.model === 'migration').length).toBeGreaterThan(
          before,
        ),
      );
    });
  }

  it('[API-011] an unknown problem falls back to the generic message', async () => {
    world.responses['POST /api/v1/migrations/m1/analyze'] = () => problem(500, 'internal_error');
    start();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Something went wrong/);
  });
});

describe('[UI-022] the Overview, Tasks, Facets, Runs and Audit tabs', () => {
  it('[UI-022] Overview groups the findings with guidance and leaves plan steps out', async () => {
    start();
    await ready();
    expect(screen.getByRole('region', { name: 'Tasks after the run' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Warnings' })).toBeTruthy();
    expect(screen.queryByText('git-refs.push')).toBeNull();
    expect(screen.getByText('Set secret values')).toBeTruthy();
    expect(screen.getByText(/The source uses a branching model/)).toBeTruthy();
    expect(document.querySelector('pre')?.textContent).toBe(
      'gh secret set API_TOKEN --repo acme-org/plat-api',
    );
  });

  it('[LIF-049] Overview lists a run-origin blocker with its guidance', async () => {
    world.migration = migration({
      runBlockers: [{ code: 'target.exists-nonempty', params: {}, at: '2026-10-02T00:00:00.000Z' }],
    });
    start();
    await ready();
    expect(screen.getByRole('region', { name: 'Blockers' })).toBeTruthy();
    expect(screen.getByText('Found by a Run')).toBeTruthy();
  });

  it('[UI-022] Overview says so when nothing was analyzed or found', async () => {
    world.migration = migration({ latestAnalysis: null });
    start();
    expect(await screen.findByText(/has not been analyzed yet/)).toBeTruthy();
  });

  it('[UI-022] clicking a Facet badge opens that Facet in the Facets tab', async () => {
    start();
    await ready();
    fireEvent.click(
      screen.getByRole('button', { name: /branch-rules: 1 finding, worst is Warnings/ }),
    );
    const panel = await screen.findByRole('region', { name: 'Field fidelity' });
    expect(panel).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Facets', selected: true })).toBeTruthy();
  });

  async function openFacets() {
    start();
    await ready();
    fireEvent.click(screen.getByRole('tab', { name: 'Facets' }));
    fireEvent.click(await screen.findByText('branch-rules', { selector: '#facet-branch-rules' }));
    await screen.findByRole('region', { name: 'Field fidelity' });
  }

  it('[UI-022] the Facets tab shows source, desired and target trees with change markers and fidelity', async () => {
    await openFacets();
    for (const side of ['Source', 'Desired', 'Target']) {
      expect(screen.getByRole('region', { name: side })).toBeTruthy();
    }
    // The target tree differs from the desired one: its changed entries carry a text marker.
    expect(
      within(screen.getByRole('region', { name: 'Target' })).getAllByText('changed').length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('Lossy')).toBeTruthy();
    expect(screen.getByText('branch-rules.x')).toBeTruthy();
  });

  it('[LIF-064] accepting a parity difference posts a manual_accepted Expected Difference with a note', async () => {
    await openFacets();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    const dialog = within(screen.getByRole('dialog'));
    const ok = dialog.getByRole('button', { name: 'Accept' });
    expect((ok as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(dialog.getByRole('textbox'), { target: { value: 'Agreed with the owner' } });
    fireEvent.click(ok);
    await waitFor(() =>
      expect(posted('/api/v1/migrations/m1/expected-differences')).toHaveLength(1),
    );
    expect(bodyOf(posted('/api/v1/migrations/m1/expected-differences')[0])).toEqual({
      facetKey: 'branch-rules',
      path: '/rules[pattern=main]/restrictPushes',
      note: 'Agreed with the owner',
    });
  });

  it('[LIF-063] Expected Differences have revoke buttons, except the ones the system owns', async () => {
    await openFacets();
    const revoke = screen.getByRole('button', {
      name: 'Revoke the expected difference at /description',
    });
    expect(screen.getAllByText('Managed by the system')).toHaveLength(1);
    fireEvent.click(revoke);
    await waitFor(() =>
      expect(callsTo(calls, 'DELETE', '/api/v1/expected-differences/ed1')).toHaveLength(1),
    );
  });

  it('[AUTH-020] a viewer sees the Facets without accept or revoke buttons', async () => {
    start('viewer');
    await ready();
    fireEvent.click(screen.getByRole('tab', { name: 'Facets' }));
    fireEvent.click(await screen.findByText('branch-rules', { selector: '#facet-branch-rules' }));
    await screen.findByRole('region', { name: 'Field fidelity' });
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Revoke/ })).toBeNull();
  });

  it('[UI-022] the Facets tab says when there is nothing to compare', async () => {
    world.diff = { ...diff(), facets: [] };
    start();
    await ready();
    fireEvent.click(screen.getByRole('tab', { name: 'Facets' }));
    expect(await screen.findByText(/nothing to compare yet/)).toBeTruthy();
    expect(diffFacet().facetKey).toBe('branch-rules');
  });

  async function openTasks() {
    start();
    await ready();
    fireEvent.click(screen.getByRole('tab', { name: /^Tasks/ }));
    await screen.findByText('1 of 1 tasks are open.');
  }

  it('[LIF-006] a task shows its guidance with a copy button and can be marked done', async () => {
    world.tasks = [task(1)];
    await openTasks();
    expect(screen.getByRole('button', { name: /^Copy / })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(posted('/api/v1/migrations/m1/tasks/t1/done')).toHaveLength(1));
  });

  it('[LIF-006] dismiss asks for a note and posts it; reopen posts reopen', async () => {
    world.tasks = [task(1)];
    await openTasks();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByRole('textbox'), { target: { value: 'Not needed' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(posted('/api/v1/migrations/m1/tasks/t1/dismiss')).toHaveLength(1));
    expect(bodyOf(posted('/api/v1/migrations/m1/tasks/t1/dismiss')[0])).toEqual({
      note: 'Not needed',
    });
    cleanup();
    world.tasks = [
      task(1, {
        status: 'done',
        completedAt: '2026-10-03T00:00:00.000Z',
        completedBy: { displayName: 'Ben' },
      }),
    ];
    start();
    await ready();
    fireEvent.click(screen.getByRole('tab', { name: /^Tasks/ }));
    fireEvent.click(await screen.findByText('Done'));
    expect(await screen.findByText(/by Ben/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(posted('/api/v1/migrations/m1/tasks/t1/reopen')).toHaveLength(1));
  });

  it('[API-012] saving a task note is the RPC write of the note field only', async () => {
    world.tasks = [task(1)];
    await openTasks();
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), {
      target: { value: 'Asked the owner' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() => {
      const update = calls.find(
        (c) => rpcOf(c.url)?.model === 'manualTask' && rpcOf(c.url)?.op === 'update',
      );
      expect(update && bodyOf(update)).toEqual({
        where: { id: 't1' },
        data: { note: 'Asked the owner' },
      });
    });
  });

  it('[LIF-006] a task refused by the server shows the task message, not a raw code', async () => {
    world.tasks = [task(1)];
    world.responses['POST /api/v1/migrations/m1/tasks/t1/done'] = () =>
      problem(422, 'validation_failed');
    await openTasks();
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/cannot be marked done by hand/);
  });

  it('[AUTH-020] a viewer sees tasks and notes but no task buttons', async () => {
    world.tasks = [task(1, { note: 'Asked the owner' })];
    start('viewer');
    await ready();
    fireEvent.click(screen.getByRole('tab', { name: /^Tasks/ }));
    await screen.findByText('1 of 1 tasks are open.');
    expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull();
    expect(screen.getByText('Asked the owner')).toBeTruthy();
  });

  it('[UI-022] the Runs tab lists the history with a link to each Run', async () => {
    world.runs = [run(1), run(2, { kind: 'verify', status: 'failed' })];
    start();
    await ready();
    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    const link = await screen.findByRole('link', { name: 'Verify' });
    expect(link.getAttribute('href')).toBe('/runs/run2');
    expect(screen.getByText('Failed')).toBeTruthy();
  });

  it('[AUTH-022] the Audit tab explains what it lists and says when it is empty', async () => {
    start();
    await ready();
    fireEvent.click(screen.getByRole('tab', { name: 'Audit' }));
    expect(await screen.findByText('No audit events for this repository.')).toBeTruthy();
    const audit = calls.find((c) => rpcOf(c.url)?.model === 'auditEvent');
    expect(JSON.parse(audit?.url.searchParams.get('q') ?? '{}').where.OR).toHaveLength(2);
  });
});
