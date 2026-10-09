import { describe, expect, it } from 'vitest';
import { memoryProviders, TEST_CONTEXT } from './memory.fixture.ts';
import { type AppPort, resetLive } from './reset.ts';

function migrated() {
  const providers = memoryProviders();
  providers.state.restrictions.push({ id: 3, kind: 'push', pattern: '*', users: [], groups: [] });
  (providers.state.repo as Record<string, unknown>).description =
    '[MIGRATED → https://github.example/gm-e2e-org/e2e-e2e-auto-ok] git-migrator e2e fixture';
  providers.state.githubRepos.set('gm-e2e-org/e2e-e2e-auto-ok', {
    description: 'git-migrator e2e fixture',
    homepage: 'https://example.com/e2e',
  });
  return providers;
}

const quiet = () => undefined;

describe('live e2e reset (TST-032)', () => {
  it('[TST-032] deletes the target and undoes the source read-only changes', async () => {
    const providers = migrated();
    const report = await resetLive(TEST_CONTEXT, { ...providers, log: quiet });
    expect(report).toMatchObject({
      targetDeleted: true,
      restrictionsRemoved: 1,
      descriptionRestored: true,
    });
    expect(providers.state.githubRepos.size).toBe(0);
    expect(providers.state.restrictions.map((row) => row.kind)).toEqual(['force', 'delete']);
    expect(providers.state.repo?.description).toBe('git-migrator e2e fixture');
  });

  it('[TST-032] is idempotent: a second run changes nothing', async () => {
    const providers = migrated();
    await resetLive(TEST_CONTEXT, { ...providers, log: quiet });
    const calls = providers.state.calls.length;
    const again = await resetLive(TEST_CONTEXT, { ...providers, log: quiet });
    expect(again).toMatchObject({
      targetDeleted: false,
      restrictionsRemoved: 0,
      descriptionRestored: false,
    });
    // It only reads and finds the target already gone; nothing is written to Bitbucket.
    const writes = providers.state.calls.slice(calls).filter((c) => /^(PUT|DELETE) \/2\.0/.test(c));
    expect(writes).toEqual([]);
  });

  it('[TST-032] leaves a push restriction with principals and the fixture restrictions alone', async () => {
    const providers = migrated();
    providers.state.restrictions.push({
      id: 4,
      kind: 'push',
      pattern: '*',
      users: [{}],
      groups: [],
    });
    await resetLive(TEST_CONTEXT, { ...providers, log: quiet });
    expect(providers.state.restrictions.map((row) => row.id)).toEqual([1, 2, 4]);
  });

  it('[TST-032] sends only the description when it restores it', async () => {
    const providers = migrated();
    const bodies: unknown[] = [];
    const inner = providers.bitbucket;
    const spy = {
      request: (method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, body?: unknown) => {
        if (method === 'PUT') bodies.push(body);
        return inner.request(method, path, body);
      },
    };
    await resetLive(TEST_CONTEXT, { ...providers, bitbucket: spy, log: quiet });
    expect(bodies).toEqual([{ description: 'git-migrator e2e fixture' }]);
  });

  it('[TST-032] uses the own undo and rollback Runs of the app first, then the direct calls', async () => {
    const providers = migrated();
    const runs: string[] = [];
    const app: AppPort = {
      find: async () => ({ id: 'm1', sourceReadOnlyApplied: true, hasTarget: true }),
      run: async (id, kind, confirm) => {
        runs.push(`${id} ${kind} ${confirm ?? ''}`.trim());
        return 'succeeded';
      },
    };
    const report = await resetLive(TEST_CONTEXT, { ...providers, app, log: quiet });
    expect(runs).toEqual(['m1 undo_source_read_only', 'm1 rollback gm-e2e-org/e2e-e2e-auto-ok']);
    expect(report.appRuns).toEqual(['undo_source_read_only: succeeded', 'rollback: succeeded']);
  });

  it('[TST-032] falls back to direct provider calls when the app cannot do it', async () => {
    const providers = migrated();
    const lines: string[] = [];
    const app: AppPort = {
      find: async () => {
        throw new Error('connection refused');
      },
      run: async () => 'failed',
    };
    const report = await resetLive(TEST_CONTEXT, {
      ...providers,
      app,
      log: (line) => lines.push(line),
    });
    expect(report.targetDeleted).toBe(true);
    expect(lines.join('\n')).toMatch(/connection refused.*direct provider calls/);
  });

  it('[TST-032] fails loudly when the target cannot be deleted, but still cleans the source', async () => {
    const providers = migrated();
    const github = {
      asApp: providers.github.asApp,
      asInstallation: async (route: string, params?: Record<string, unknown>) =>
        route.startsWith('DELETE')
          ? { status: 403, json: undefined }
          : providers.github.asInstallation(route, params),
    };
    await expect(resetLive(TEST_CONTEXT, { ...providers, github, log: quiet })).rejects.toThrow(
      /Cannot delete GitHub repository gm-e2e-org\/e2e-e2e-auto-ok \(HTTP 403\)/,
    );
    expect(providers.state.restrictions.map((row) => row.kind)).toEqual(['force', 'delete']);
    expect(providers.state.repo?.description).toBe('git-migrator e2e fixture');
  });

  it('[TST-032] refuses to delete a repository that is not the fixture’s, and still cleans the source', async () => {
    const providers = migrated();
    providers.state.githubRepos.set('gm-e2e-org/e2e-e2e-auto-ok', {
      description: 'someone else’s work',
    });
    await expect(resetLive(TEST_CONTEXT, { ...providers, log: quiet })).rejects.toThrow(
      /Refusing to delete GitHub repository gm-e2e-org\/e2e-e2e-auto-ok/,
    );
    expect(providers.state.githubRepos.size).toBe(1);
    expect(providers.state.restrictions.map((row) => row.kind)).toEqual(['force', 'delete']);
  });

  it('[TST-032] names the workspace, repository and organization before it writes anything', async () => {
    const providers = migrated();
    const lines: string[] = [];
    await resetLive(TEST_CONTEXT, { ...providers, log: (line) => lines.push(line) });
    expect(lines[0]).toBe(
      'resetting Bitbucket workspace gm-e2e, repository e2e-auto-ok (project E2E) and GitHub repository gm-e2e-org/e2e-e2e-auto-ok',
    );
  });
});
