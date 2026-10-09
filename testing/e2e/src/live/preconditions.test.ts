import { describe, expect, it } from 'vitest';
import { memoryProviders, TEST_CONTEXT } from './memory.fixture.ts';
import { assertPreconditions, PreconditionsError } from './preconditions.ts';

async function failuresOf(
  change: (providers: ReturnType<typeof memoryProviders>) => void,
): Promise<string[]> {
  const providers = memoryProviders();
  change(providers);
  try {
    await assertPreconditions(TEST_CONTEXT, providers);
  } catch (error) {
    if (error instanceof PreconditionsError) return [...error.failures];
    throw error;
  }
  return [];
}

describe('live e2e preconditions (TST-031)', () => {
  it('[TST-031] passes for a correctly prepared fixture', async () => {
    expect(await failuresOf(() => undefined)).toEqual([]);
  });

  it('[TST-031] says which Bitbucket repository is missing', async () => {
    const failures = await failuresOf(({ state }) => {
      state.repo = undefined;
    });
    expect(failures).toContain('Bitbucket repository e2e-auto-ok not found in project E2E');
  });

  it('[TST-031] says which App permission is missing', async () => {
    const failures = await failuresOf(({ state }) => {
      const granted = state.installation.permissions as Record<string, string>;
      granted.administration = 'read';
      delete granted.workflows;
    });
    expect(failures).toContain('GitHub App lacks permission administration:write');
    expect(failures).toContain('GitHub App lacks permission workflows:write');
  });

  it('[TST-031] reports every unmet precondition in one error, each with a fix', async () => {
    const failures = await failuresOf(({ state }) => {
      state.branches = ['main'];
      state.tags = [];
      state.variables = [{ key: 'E2E_VAR', value: 'hello', secured: true }];
      state.pullRequests = [{}];
      state.restrictions = [];
      state.installation.repository_selection = 'selected';
    });
    expect(failures).toEqual(
      expect.arrayContaining([
        'Bitbucket repository e2e-auto-ok has no branch develop',
        'Bitbucket repository e2e-auto-ok has no branch feature/one',
        'Bitbucket repository e2e-auto-ok has no tag v1.0.0',
        'Bitbucket repository e2e-auto-ok needs the unsecured variable E2E_VAR=hello',
        'Bitbucket repository e2e-auto-ok must have no secured variables',
        'Bitbucket repository e2e-auto-ok must have no open pull requests',
        'Bitbucket repository e2e-auto-ok needs a "Prevent rewriting history" restriction on main',
        'Bitbucket repository e2e-auto-ok needs a "Prevent deleting this branch" restriction on main',
        'GitHub App must be installed with access to All repositories (it has "selected")',
      ]),
    );
  });

  it('[TST-031] points at the reset when an earlier run left state behind', async () => {
    const failures = await failuresOf(({ state }) => {
      state.restrictions.push({ id: 3, kind: 'push', pattern: '*', users: [], groups: [] });
      (state.repo as Record<string, unknown>).description =
        '[MIGRATED → https://x] git-migrator e2e fixture';
      state.githubRepos.set('gm-e2e-org/e2e-e2e-auto-ok', {});
    });
    expect(failures.filter((failure) => failure.includes('pnpm e2e:live:reset'))).toHaveLength(3);
  });

  it('[TST-031] rejects a token of another account and a non-admin account', async () => {
    expect(
      await failuresOf(({ state }) => {
        state.userAccountId = 'acct-other';
      }),
    ).toEqual([expect.stringContaining('belongs to Bitbucket account acct-other')]);
    const notAdmin = await failuresOf(({ state }) => {
      state.workspacePermission = 'collaborator';
    });
    expect(notAdmin[0]).toMatch(/not an admin of workspace gm-e2e/);
  });

  it('[TST-031] fails closed when a provider cannot answer', async () => {
    const failures = await failuresOf(({ state }) => {
      state.failing.set('/hooks', 500);
      state.failing.set('/deploy-keys', 403);
    });
    expect(failures).toEqual([
      expect.stringContaining('Cannot read the access keys of e2e-auto-ok (HTTP 403)'),
      expect.stringContaining('Cannot read the webhooks of e2e-auto-ok (HTTP 500)'),
    ]);
  });

  it('[TST-031] reports a check that throws instead of passing it', async () => {
    const providers = memoryProviders();
    const boom = { request: () => Promise.reject(new Error('network down')) };
    await expect(
      assertPreconditions(TEST_CONTEXT, { ...providers, bitbucket: boom }),
    ).rejects.toThrow(/A check could not run: network down/);
  });
});
