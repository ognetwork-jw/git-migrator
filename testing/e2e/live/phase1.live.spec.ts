/**
 * T-095, TST-030 to TST-031: the Phase-1 flow of TST-021 with the targets switched by
 * `GM_E2E_TARGET` (`global-setup.ts`).
 *
 * - `fakes` (dry mode, CI): the stack of the UI tier. The spec, the checks and the Octokit and
 *   Bitbucket clients run the same code paths, so they stay type-checked and working. The fakes
 *   do not implement a few endpoints; `ctx.skipChecks` names them and only this mode honours it.
 * - `live` (a human, `pnpm test:e2e:live`): real Bitbucket and GitHub test accounts
 *   (docs/e2e-setup.md). The assertions on the providers use only their public APIs with the
 *   App and API-token credentials; the spec never reads the fakes' state or the database.
 */
import { expect, test } from '@playwright/test';
import { runPhase1 } from '../harness/phase1-flow.ts';
import type { E2eContext } from '../src/live/context.ts';
import { asArray, asRecord } from '../src/live/ports.ts';
import { assertPreconditions, repoPath } from '../src/live/preconditions.ts';
import { contextFromEnv, portsFor } from '../src/live/runtime.ts';

const ctx: E2eContext = contextFromEnv(process.env);
const ports = portsFor(ctx);
const { fixture } = ctx;
const planned = { owner: ctx.github.org, repo: fixture.targetName };
/** Endpoints the fakes lack (dry mode only). */
const gaps = new Set(ctx.target === 'fakes' ? (ctx.skipChecks ?? []) : []);

test.describe.configure({ mode: 'serial' });

test('[TST-031] every precondition of the fixture holds before the test acts', async () => {
  await assertPreconditions(ctx, ports);
});

test('[TST-030] the Phase-1 flow through the browser: refresh, find, migrate, watch the Run, verify', async ({
  context,
  page,
}, testInfo) => {
  await runPhase1(context, page, testInfo, {
    operator: ctx.operatorEmail,
    // The fakes tier signs in with its own throw-away password; the live run with the secret.
    password: ctx.target === 'live' ? process.env.GM_TEST_USER_PASSWORD : undefined,
    repoText: `${fixture.projectKey}/${fixture.slug}`,
    slow: ctx.target === 'live' ? 6 : 1,
    // A trace records the sign-in password and real provider data; the live run keeps none.
    trace: ctx.target !== 'live',
  });
});

/** Branch name -> commit hash on the source. */
async function sourceBranches(): Promise<Map<string, string>> {
  const answer = await ports.bitbucket.request('GET', `${repoPath(ctx)}/refs/branches?pagelen=100`);
  expect(answer.status, 'Bitbucket branches').toBe(200);
  return new Map(
    asArray(asRecord(answer.json).values).map((value) => {
      const row = asRecord(value);
      return [String(row.name), String(asRecord(row.target).hash)] as const;
    }),
  );
}

/** Refs of one kind on the target: name -> {type, sha} of the ref's object. */
async function targetRefs(kind: 'heads' | 'tags') {
  const answer = await ports.github.asInstallation(
    'GET /repos/{owner}/{repo}/git/matching-refs/{ref}',
    { ...planned, ref: kind },
  );
  expect(answer.status, `GitHub ${kind}`).toBe(200);
  return new Map(
    asArray(answer.json).map((value) => {
      const row = asRecord(value);
      const object = asRecord(row.object);
      return [
        String(row.ref).replace(`refs/${kind}/`, ''),
        { type: String(object.type), sha: String(object.sha) },
      ] as const;
    }),
  );
}

test('[TST-030] GitHub holds the migrated repository with the settings of the source', async () => {
  const repo = await ports.github.asInstallation('GET /repos/{owner}/{repo}', planned);
  expect(repo.status, `GitHub repository ${planned.owner}/${planned.repo}`).toBe(200);
  const data = asRecord(repo.json);
  expect(data.private).toBe(true);
  expect(String(data.description ?? '')).toBe(fixture.description);
  expect(String(data.homepage ?? '')).toBe(fixture.website);
  // "Allow only private forks" on the source: forking stays allowed on the private target.
  expect(data.allow_forking, 'forking setting').toBe(true);
});

test('[TST-030] GitHub has identical branches and tags (Octokit with the App credentials)', async () => {
  const source = await sourceBranches();
  expect([...source.keys()].sort(), 'branches of the source').toEqual([...fixture.branches].sort());
  // The fake REST API does not see what the git server received, so only the live mode reads refs.
  test.skip(gaps.has('github-refs'), 'the fake GitHub REST API does not list pushed refs');
  const heads = await targetRefs('heads');
  expect([...heads.keys()].sort(), 'branches on both sides').toEqual([...source.keys()].sort());
  for (const [name, hash] of source) expect(heads.get(name)?.sha, `branch ${name}`).toBe(hash);

  const tags = await targetRefs('tags');
  expect([...tags.keys()].sort(), 'tags').toEqual([...fixture.tags].sort());
  if (!gaps.has('bitbucket-tags')) {
    const answer = await ports.bitbucket.request('GET', `${repoPath(ctx)}/refs/tags?pagelen=100`);
    expect(answer.status, 'Bitbucket tags').toBe(200);
    const sourceTags = new Map(
      asArray(asRecord(answer.json).values).map((value) => {
        const row = asRecord(value);
        return [String(row.name), String(asRecord(row.target).hash)] as const;
      }),
    );
    expect([...sourceTags.keys()].sort()).toEqual([...tags.keys()].sort());
    // A lightweight tag points at the commit itself; an annotated one at a tag object whose
    // commit the REST listing of the source reports, so only the first kind compares hashes.
    for (const [name, ref] of tags) {
      if (ref.type === 'commit') expect(ref.sha, `tag ${name}`).toBe(sourceTags.get(name));
    }
  }
});

test('[TST-030] GitHub has a protection rule on main: no force push, no deletion', async () => {
  test.skip(gaps.has('github-protection'), 'the fake GitHub has no branch main for the REST read');
  const protection = await ports.github.asInstallation(
    'GET /repos/{owner}/{repo}/branches/{branch}/protection',
    { ...planned, branch: 'main' },
  );
  expect(protection.status, 'protection rule on main').toBe(200);
  const rule = asRecord(protection.json);
  expect(asRecord(rule.allow_force_pushes).enabled).toBe(false);
  expect(asRecord(rule.allow_deletions).enabled).toBe(false);
});

test('[TST-030] GitHub has the deploy key and the variable', async () => {
  const keys = await ports.github.asInstallation('GET /repos/{owner}/{repo}/keys', planned);
  expect(keys.status, 'deploy keys').toBe(200);
  expect(asArray(keys.json).map((key) => asRecord(key).title)).toContain(fixture.deployKeyTitle);

  if (!gaps.has('github-variables')) {
    const variables = await ports.github.asInstallation(
      'GET /repos/{owner}/{repo}/actions/variables',
      planned,
    );
    expect(variables.status, 'Actions variables').toBe(200);
    const rows = asArray(asRecord(variables.json).variables).map(asRecord);
    expect(rows.find((row) => row.name === fixture.variable.name)?.value).toBe(
      fixture.variable.value,
    );
  }
});

test('[TST-030] the LFS object arrived as a pointer file', async () => {
  test.skip(gaps.has('github-contents'), 'the fake GitHub REST API does not serve pushed files');
  const file = await ports.github.asInstallation('GET /repos/{owner}/{repo}/contents/{path}', {
    ...planned,
    path: 'assets/sample.bin',
  });
  expect(file.status, 'assets/sample.bin').toBe(200);
  const content = Buffer.from(String(asRecord(file.json).content ?? ''), 'base64').toString('utf8');
  expect(content).toMatch(/^version https:\/\/git-lfs\.github\.com\/spec\/v1/);
});

test('[TST-030] the source is read-only: a push restriction on * and a MIGRATED description prefix', async () => {
  const restrictions = await ports.bitbucket.request(
    'GET',
    `${repoPath(ctx)}/branch-restrictions?pagelen=100`,
  );
  expect(restrictions.status).toBe(200);
  expect(
    asArray(asRecord(restrictions.json).values)
      .map(asRecord)
      .some((row) => row.kind === 'push' && row.pattern === '*'),
  ).toBe(true);
  const repo = await ports.bitbucket.request('GET', repoPath(ctx));
  expect(repo.status).toBe(200);
  expect(String(asRecord(repo.json).description)).toMatch(/^\[MIGRATED → /);
});
