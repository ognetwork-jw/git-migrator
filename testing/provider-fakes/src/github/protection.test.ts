import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { type AddressInfo, connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  basicAuthEnv,
  createBareRepo,
  isolatedGitEnv,
  POLICY_FLAG_FILE,
  runGit,
} from '../git/index.ts';
import { type RunningFakes, startFakes } from '../start.ts';
import { jsonOf, must, world } from './harness.ts';
import { createRule, deleteRule, type RuleInput } from './rules.ts';
import type { GitHubState } from './state.ts';

// These tests spawn git or servers; a loaded machine needs more than the 5 s default.
vi.setConfig({ testTimeout: 60_000 });

/** Two Apps on `acme`: the framework App (`own`) and another one (`other`), both with contents:write. */
function actors(state: GitHubState) {
  const other = state.addApp({
    slug: 'other',
    permissions: { contents: 'write', metadata: 'read', administration: 'write' },
  });
  const inst = state.addInstallation(
    {
      account: 'acme',
      permissions: { contents: 'write', metadata: 'read', administration: 'write' },
    },
    other,
  );
  return { own: state.ownApp, other, otherInstallation: inst.id };
}

const writer = { contents: 'write', metadata: 'read' } as const;
const admin = { contents: 'write', metadata: 'read', administration: 'write' } as const;

describe('branch protection over REST refs', () => {
  const PROTECTED: RuleInput = { allowsForcePushes: false, allowsDeletions: false };

  it('[FAC-BRR-002] force push: unlisted writer rejected, bypass-listed accepted (ADR-0040)', async () => {
    const w = world();
    const { own, other, otherInstallation } = actors(w.fake.state);
    createRule(w.fake.state, w.repo, 'main', {
      ...PROTECTED,
      bypassForcePushActorIds: [own.nodeId],
    });
    const main = w.repo.git.refs.get('refs/heads/main') as string;
    const feature = w.repo.git.refs.get('refs/heads/feature/x') as string;
    await w.call('PATCH', '/repos/acme/auto-ok/git/refs/heads/main', {
      body: { sha: feature },
      token: w.fake.token({ permissions: writer }),
    });
    const patch = { body: { sha: main, force: true } };
    const unlisted = w.fake.token({ installationId: otherInstallation, permissions: writer });
    const denied = await w.call('PATCH', '/repos/acme/auto-ok/git/refs/heads/main', {
      ...patch,
      token: unlisted,
    });
    expect(denied.status).toBe(422);
    expect(denied.body.message).toContain('Cannot force-push to this branch');
    expect(w.repo.git.refs.get('refs/heads/main')).toBe(feature);
    const listed = w.fake.token({ permissions: writer });
    expect(
      (
        await w.call('PATCH', '/repos/acme/auto-ok/git/refs/heads/main', {
          ...patch,
          token: listed,
        })
      ).status,
    ).toBe(200);
    expect(other.slug).toBe('other');
  });

  it('[FAC-BRR-002] allowsForcePushes lets every writer force push, whatever the bypass list says', async () => {
    const w = world();
    const { otherInstallation } = actors(w.fake.state);
    createRule(w.fake.state, w.repo, 'main', { allowsForcePushes: true });
    const main = w.repo.git.refs.get('refs/heads/main') as string;
    const feature = w.repo.git.refs.get('refs/heads/feature/x') as string;
    const t = w.fake.token({ installationId: otherInstallation, permissions: writer });
    await w.call('PATCH', '/repos/acme/auto-ok/git/refs/heads/main', {
      body: { sha: feature },
      token: t,
    });
    expect(
      (
        await w.call('PATCH', '/repos/acme/auto-ok/git/refs/heads/main', {
          body: { sha: main, force: true },
          token: t,
        })
      ).status,
    ).toBe(200);
  });

  it('[FAC-BRR-002] admins bypass unless isAdminEnforced; then the lists decide', async () => {
    const w = world();
    const { otherInstallation } = actors(w.fake.state);
    const rule = createRule(w.fake.state, w.repo, 'main', PROTECTED);
    const main = w.repo.git.refs.get('refs/heads/main') as string;
    const feature = w.repo.git.refs.get('refs/heads/feature/x') as string;
    const adminToken = w.fake.token({ installationId: otherInstallation, permissions: admin });
    const call = (sha: string, force: boolean) =>
      w.call('PATCH', '/repos/acme/auto-ok/git/refs/heads/main', {
        body: { sha, force },
        token: adminToken,
      });
    expect((await call(feature, false)).status).toBe(200);
    expect((await call(main, true)).status).toBe(200); // admin, not enforced
    await call(feature, false);
    rule.isAdminEnforced = true;
    expect((await call(main, true)).status).toBe(422);
    rule.bypassForcePushActorIds = [
      must([...w.fake.state.apps.values()].find((a) => a.slug === 'other')).nodeId,
    ];
    expect((await call(main, true)).status).toBe(200);
  });

  it('[FAC-BRR-002] deletion is blocked by allowsDeletions: false for non-admins, allowed when true', async () => {
    const w = world();
    const rule = createRule(w.fake.state, w.repo, 'feature/*', PROTECTED);
    const t = w.fake.token({ permissions: writer });
    const del = () =>
      w.call('DELETE', '/repos/acme/auto-ok/git/refs/heads/feature/x', { token: t });
    const denied = await del();
    expect(denied.status).toBe(422);
    expect(denied.body.message).toContain('Cannot delete this branch');
    rule.allowsDeletions = true;
    expect((await del()).status).toBe(204);
  });

  it('[FAC-BRR-002] creation is blocked by blocksCreations unless listed in the push allowances (ADR-0041)', async () => {
    const w = world();
    const { own, otherInstallation } = actors(w.fake.state);
    const sha = w.repo.git.refs.get('refs/heads/main') as string;
    createRule(w.fake.state, w.repo, 'rel/*', {
      blocksCreations: true,
      restrictsPushes: true,
      pushActorIds: [own.nodeId],
    });
    const create = (token: string, n: number) =>
      w.call('POST', '/repos/acme/auto-ok/git/refs', {
        body: { ref: `refs/heads/rel/${n}`, sha },
        token,
      });
    const unlisted = w.fake.token({ installationId: otherInstallation, permissions: writer });
    const denied = await create(unlisted, 1);
    expect(denied.status).toBe(422);
    expect(denied.body.message).toContain('creations being restricted');
    expect((await create(w.fake.token({ permissions: writer }), 2)).status).toBe(201);
    expect((await create(unlisted, 3)).status, 'admin bypass is for admins only').toBe(422);
    expect(
      (await create(w.fake.token({ installationId: otherInstallation, permissions: admin }), 4))
        .status,
    ).toBe(201);
    // blocksCreations false: restrictsPushes alone does not stop creation
    createRule(w.fake.state, w.repo, 'only/*', {
      restrictsPushes: true,
      pushActorIds: [own.nodeId],
    });
    expect(
      (
        await w.call('POST', '/repos/acme/auto-ok/git/refs', {
          body: { ref: 'refs/heads/only/1', sha },
          token: unlisted,
        })
      ).status,
    ).toBe(201);
  });

  it('[FAC-BRR-002] restrictsPushes stops updates by unlisted actors', async () => {
    const w = world();
    const { own, otherInstallation } = actors(w.fake.state);
    createRule(w.fake.state, w.repo, 'main', { restrictsPushes: true, pushActorIds: [own.nodeId] });
    const feature = w.repo.git.refs.get('refs/heads/feature/x') as string;
    const patch = (token: string) =>
      w.call('PATCH', '/repos/acme/auto-ok/git/refs/heads/main', { body: { sha: feature }, token });
    const denied = await patch(
      w.fake.token({ installationId: otherInstallation, permissions: writer }),
    );
    expect(denied.status).toBe(422);
    expect(denied.body.message).toContain('not allowed to push');
    expect((await patch(w.fake.token({ permissions: writer }))).status).toBe(200);
  });
});

describe('branch protection and access over git push', () => {
  let running: RunningFakes | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  async function setup(onCgiSpawn?: (info: { repo: string; operation: 'read' | 'write' }) => void) {
    running = await startFakes({
      bitbucketPort: 0,
      githubPort: 0,
      gitPort: 0,
      ...(onCgiSpawn ? { git: { target: { onCgiSpawn } } } : {}),
    });
    const gh = must(running.github);
    const git = must(running.git);
    const home = await mkdtemp(join(tmpdir(), 'gh-protect-'));
    const { own, otherInstallation } = actors(gh.state);
    const api = (method: string, path: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${gh.port}${path}`, {
        method,
        headers: { authorization: `Bearer ${gh.token()}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    expect((await api('POST', '/orgs/acme/repos', { name: 'app', private: true })).status).toBe(
      201,
    );
    const repo = must(gh.state.findRepo('acme', 'app'));
    const url = git.repoUrl('target', 'acme/app');
    const work = join(home, 'work');
    await mkdir(work);
    const run = (args: string[], token?: string, check = true) =>
      runGit(args, {
        cwd: work,
        check,
        env: isolatedGitEnv(home, token ? basicAuthEnv('x-access-token', token) : {}),
      });
    await run(['init', '-q', '-b', 'main']);
    const commit = async (name: string) => {
      await writeFile(join(work, name), `${name}\n`);
      await run(['add', '.']);
      await run(['commit', '-q', '-m', name]);
    };
    await commit('a');
    const tokens = {
      adminOwn: gh.token({ permissions: admin }),
      writerOwn: gh.token({ permissions: writer }),
      writerOther: gh.token({ installationId: otherInstallation, permissions: writer }),
      adminOther: gh.token({ installationId: otherInstallation, permissions: admin }),
    };
    await run(['push', '-q', url, 'HEAD:refs/heads/main'], tokens.writerOwn);
    return { gh, git, repo, url, run, commit, tokens, own, home };
  }

  it('[FAC-BRR-002] force push over git: unlisted rejected, bypass-listed accepted, admin bypass unless enforced', async () => {
    const t = await setup();
    const rule = createRule(t.gh.state, t.repo, 'main', {
      allowsForcePushes: false,
      bypassForcePushActorIds: [t.own.nodeId],
    });
    await t.run(['reset', '-q', '--hard', 'HEAD~0']);
    await t.run(['commit', '-q', '--amend', '-m', 'rewritten']); // diverges from the remote main
    const force = (token: string) =>
      t.run(['push', '-q', '--force', t.url, 'HEAD:refs/heads/main'], token, false);
    const denied = await force(t.tokens.writerOther);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain('Protected branch update failed for refs/heads/main');
    expect(denied.stderr).toContain('Cannot force-push to this branch');
    expect((await force(t.tokens.writerOwn)).code).toBe(0);
    await t.run(['commit', '-q', '--amend', '-m', 'rewritten again']);
    expect((await force(t.tokens.adminOther)).code, 'admin, rule not enforced for admins').toBe(0);
    rule.isAdminEnforced = true;
    await t.run(['commit', '-q', '--amend', '-m', 'rewritten thrice']);
    expect((await force(t.tokens.adminOther)).code).not.toBe(0);
    expect((await force(t.tokens.adminOwn)).code, 'listed admin').toBe(0);
  });

  it('[FAC-BRR-002] deleting a protected branch and creating a restricted one are rejected over git', async () => {
    const t = await setup();
    createRule(t.gh.state, t.repo, 'main', { allowsDeletions: false });
    createRule(t.gh.state, t.repo, 'rel/*', {
      blocksCreations: true,
      pushActorIds: [t.own.nodeId],
    });
    const del = await t.run(['push', t.url, ':refs/heads/main'], t.tokens.writerOther, false);
    expect(del.code).not.toBe(0);
    expect(del.stderr).toContain('Cannot delete this branch');
    const create = await t.run(
      ['push', t.url, 'HEAD:refs/heads/rel/1'],
      t.tokens.writerOther,
      false,
    );
    expect(create.code).not.toBe(0);
    expect(create.stderr).toContain('creations being restricted');
    expect(
      (await t.run(['push', '-q', t.url, 'HEAD:refs/heads/rel/1'], t.tokens.writerOwn, false)).code,
    ).toBe(0);
    expect(
      (await t.run(['push', '-q', t.url, 'HEAD:refs/heads/free'], t.tokens.writerOther, false))
        .code,
    ).toBe(0);
  });

  it('[FAC-BRR-002] restricted pushes: fast-forward by an unlisted actor is rejected', async () => {
    const t = await setup();
    createRule(t.gh.state, t.repo, 'main', { restrictsPushes: true, pushActorIds: [t.own.nodeId] });
    await t.commit('b');
    const denied = await t.run(
      ['push', t.url, 'HEAD:refs/heads/main'],
      t.tokens.writerOther,
      false,
    );
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain('not allowed to push');
    expect(
      (await t.run(['push', '-q', t.url, 'HEAD:refs/heads/main'], t.tokens.writerOwn, false)).code,
    ).toBe(0);
  });

  it('[FAC-BRR-002] the policy flag follows every rule mutation path and clears with the last rule', async () => {
    const t = await setup();
    const flag = join(t.git.repoDir('target', 'acme/app'), POLICY_FLAG_FILE);
    const gql = (query: string) =>
      fetch(`http://127.0.0.1:${t.gh.port}/graphql`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t.gh.token()}` },
        body: JSON.stringify({ query }),
      }).then((r) => jsonOf(r));
    const rest = (method: string, path: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${t.gh.port}${path}`, {
        method,
        headers: { authorization: `Bearer ${t.gh.token()}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    expect(existsSync(flag)).toBe(false);
    const created = await gql(
      `mutation { createBranchProtectionRule(input:{repositoryId:"${t.repo.nodeId}", pattern:"a"}) { branchProtectionRule { id } } }`,
    );
    expect(existsSync(flag)).toBe(true);
    const id = created.data.createBranchProtectionRule.branchProtectionRule.id;
    const builder = createRule(t.gh.state, t.repo, 'b', {});
    await gql(
      `mutation { deleteBranchProtectionRule(input:{branchProtectionRuleId:"${id}"}) { clientMutationId } }`,
    );
    expect(existsSync(flag), 'one rule left').toBe(true);
    deleteRule(t.gh.state, t.repo, builder);
    expect(existsSync(flag), 'last rule removed').toBe(false);
    const put = {
      required_status_checks: null,
      enforce_admins: false,
      required_pull_request_reviews: null,
      restrictions: null,
    };
    expect((await rest('PUT', '/repos/acme/app/branches/main/protection', put)).status).toBe(404); // no such branch yet
    t.repo.git.commitFiles('refs/heads/main', { a: 'a' }, 'init'); // REST protection needs a branch in the REST ref table
    expect((await rest('PUT', '/repos/acme/app/branches/main/protection', put)).status).toBe(200);
    expect(existsSync(flag)).toBe(true);
    expect((await rest('DELETE', '/repos/acme/app/branches/main/protection')).status).toBe(204);
    expect(existsSync(flag)).toBe(false);
  });

  it('[FAC-BRR-002] a rule added while a push is in flight is enforced (the flag is read when the hook runs)', async () => {
    let spawnSeen: () => void = () => {};
    const spawned = new Promise<void>((resolve) => {
      spawnSeen = resolve;
    });
    const t = await setup((info) => {
      if (info.operation === 'write') spawnSeen();
    });
    createRule(t.gh.state, t.repo, 'other', {}); // the flag exists now; remove it so the push starts unflagged
    deleteRule(t.gh.state, t.repo, must(t.repo.rules[0]));
    await t.commit('b');
    // A proxy that forwards the receive-pack request headers at once and holds the body.
    const upstream = new URL(t.git.baseUrl);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let headersForwarded: () => void = () => {};
    const forwarded = new Promise<void>((resolve) => {
      headersForwarded = resolve;
    });
    const proxy = createServer((client) => {
      const up = connect(Number(upstream.port), upstream.hostname);
      let holding = false;
      const queue: Buffer[] = [];
      client.on('data', (chunk: Buffer) => {
        if (holding) return void queue.push(chunk);
        const text = chunk.toString('latin1');
        const end = text.indexOf('\r\n\r\n');
        if (text.startsWith('POST ') && text.includes('git-receive-pack') && end >= 0) {
          holding = true;
          up.write(chunk.subarray(0, end + 4));
          queue.push(chunk.subarray(end + 4));
          headersForwarded();
          void gate.then(() => {
            holding = false;
            for (const q of queue.splice(0)) up.write(q);
          });
        } else up.write(chunk);
      });
      up.on('data', (d) => client.write(d));
      client.on('close', () => up.destroy());
      up.on('close', () => client.destroy());
      client.on('error', () => {});
      up.on('error', () => {});
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const proxied = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/target/acme/app.git`;
      const push = t.run(['push', proxied, 'HEAD:refs/heads/main'], t.tokens.writerOther, false);
      await forwarded;
      await spawned; // git http-backend / receive-pack is running and waits for the pack
      expect(existsSync(join(t.git.repoDir('target', 'acme/app'), POLICY_FLAG_FILE))).toBe(false);
      createRule(t.gh.state, t.repo, 'main', {
        restrictsPushes: true,
        pushActorIds: [t.own.nodeId],
      });
      release();
      const result = await push;
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('not allowed to push');
    } finally {
      release();
      proxy.close();
    }
  });

  it('[FAC-BRR-002] rules created before the bare repository is seeded are enforced after syncPolicy', async () => {
    const t = await setup();
    const pre = t.gh.state.addRepository('acme', { name: 'pre' });
    createRule(t.gh.state, pre, 'main', { blocksCreations: true, pushActorIds: [t.own.nodeId] });
    await createBareRepo(t.git.repoDir('target', 'acme/pre'));
    const url = t.git.repoUrl('target', 'acme/pre');
    const flag = join(t.git.repoDir('target', 'acme/pre'), POLICY_FLAG_FILE);
    expect(existsSync(flag)).toBe(false);
    t.gh.syncPolicy(pre);
    expect(existsSync(flag)).toBe(true);
    const denied = await t.run(['push', url, 'HEAD:refs/heads/main'], t.tokens.writerOther, false);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain('creations being restricted');
    pre.rules.length = 0;
    t.gh.syncPolicy();
    expect(existsSync(flag)).toBe(false);
  });

  it('[FAC-BRR-002] a rule created while the REST create or rename is in flight still sets the flag', async () => {
    const t = await setup();
    const hooks = must(t.gh.state.options.repositoryHooks);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.gh.state.options.repositoryHooks = {
      ...hooks,
      created: async (r) => {
        await gate;
        await hooks.created?.(r);
      },
    };
    const api = (method: string, path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${t.gh.port}${path}`, {
        method,
        headers: { authorization: `Bearer ${t.gh.token()}` },
        body: JSON.stringify(body),
      });
    const creating = api('POST', '/orgs/acme/repos', { name: 'racy' });
    while (!t.gh.state.findRepo('acme', 'racy')) await new Promise((r) => setTimeout(r, 5));
    const racy = must(t.gh.state.findRepo('acme', 'racy'));
    createRule(t.gh.state, racy, 'main', {});
    release();
    expect((await creating).status).toBe(201);
    expect(existsSync(join(t.git.repoDir('target', 'acme/racy'), POLICY_FLAG_FILE))).toBe(true);
    // rename: the last rule is removed and another one created during the hook
    let release2: () => void = () => {};
    const gate2 = new Promise<void>((resolve) => {
      release2 = resolve;
    });
    t.gh.state.options.repositoryHooks = {
      ...hooks,
      renamed: async (r, old) => {
        await gate2;
        await hooks.renamed?.(r, old);
      },
    };
    const renaming = api('PATCH', '/repos/acme/racy', { name: 'renamed' });
    while (racy.name !== 'renamed') await new Promise((r) => setTimeout(r, 5));
    deleteRule(t.gh.state, racy, must(racy.rules[0]));
    createRule(t.gh.state, racy, 'dev', {});
    release2();
    expect((await renaming).status).toBe(200);
    expect(existsSync(join(t.git.repoDir('target', 'acme/renamed'), POLICY_FLAG_FILE))).toBe(true);
  });

  it('[FAC-BRR-002] refs/pull/* pushes are denied on an unprotected repository too', async () => {
    const t = await setup();
    expect(t.repo.rules).toHaveLength(0);
    const denied = await t.run(['push', t.url, 'HEAD:refs/pull/1/head'], t.tokens.writerOwn, false);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toContain('deny updating a hidden ref');
    expect(
      (await t.run(['push', '-q', t.url, 'HEAD:refs/heads/ok'], t.tokens.writerOwn, false)).code,
    ).toBe(0);
  });

  it('[TST-013] /__reset removes the bare repository and the policy flag', async () => {
    const t = await setup();
    createRule(t.gh.state, t.repo, 'main', {});
    const dir = t.git.repoDir('target', 'acme/app');
    expect(existsSync(join(dir, POLICY_FLAG_FILE))).toBe(true);
    await t.gh.reset();
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(dir, POLICY_FLAG_FILE))).toBe(false);
  });

  it('[TST-013] git access follows the token: Contents level, repository restriction, expiry, unknown tokens', async () => {
    const t = await setup();
    const read = t.gh.token({ permissions: { contents: 'read', metadata: 'read' } });
    await t.commit('b');
    expect((await t.run(['ls-remote', t.url], read, false)).code).toBe(0);
    const push = await t.run(['push', t.url, 'HEAD:refs/heads/main'], read, false);
    expect(push.code).not.toBe(0);
    expect(push.stderr).toMatch(/403/);
    const none = t.gh.token({ permissions: { metadata: 'read' } });
    expect((await t.run(['ls-remote', t.url], none, false)).code).not.toBe(0);
    t.gh.state.addRepository('acme', { name: 'other' });
    const onlyOther = t.gh.token({
      repositoryIds: [must(t.gh.state.findRepo('acme', 'other')).id],
    });
    const hidden = await t.run(['ls-remote', t.url], onlyOther, false);
    expect(hidden.code).not.toBe(0);
    expect(hidden.stderr).toMatch(/404|not found/i);
    expect((await t.run(['ls-remote', t.url], 'ghs_unknown', false)).code).not.toBe(0);
    expect((await t.run(['ls-remote', t.url], undefined, false)).code).not.toBe(0);
  });

  it('[TST-013] /__reset empties the git server: recreated repositories start empty and forget LFS objects', async () => {
    const t = await setup();
    const { oid } = await t.git.lfsStore('target').put('acme/app', 'lfs data');
    const repoOf = () => must(t.gh.state.findRepo('acme', 'app'));
    expect(await t.gh.reset()).toBeUndefined();
    expect(t.gh.state.repos.size).toBe(0);
    const api = (method: string, path: string, body?: unknown, token = t.gh.token()) =>
      fetch(`http://127.0.0.1:${t.gh.port}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    expect((await api('POST', '/orgs/acme/repos', { name: 'app' })).status).toBe(201);
    const ls = await t.run(['ls-remote', t.url], t.gh.token(), false);
    expect(ls.code).toBe(0);
    expect(ls.stdout).toBe('');
    expect(await t.git.lfsStore('target').size('acme/app', oid)).toBeUndefined();
    const batch = await api('POST', '/acme/app.git/info/lfs/objects/batch', {
      operation: 'download',
      objects: [{ oid, size: 8 }],
    });
    expect((await jsonOf(batch)).objects[0].error.code).toBe(404);
    expect(repoOf().git.isEmpty).toBe(true);
  });

  it('[TST-013] creating a repository again replaces a leftover bare repository', async () => {
    const t = await setup();
    const { oid } = await t.git.lfsStore('target').put('acme/app', 'x');
    // Delete the record behind the hook's back, as a crashed run would leave things.
    t.gh.state.deleteRepository(must(t.gh.state.findRepo('acme', 'app')));
    const res = await fetch(`http://127.0.0.1:${t.gh.port}/orgs/acme/repos`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.gh.token()}` },
      body: JSON.stringify({ name: 'app' }),
    });
    expect(res.status).toBe(201);
    expect((await t.run(['ls-remote', t.url], t.gh.token(), false)).stdout).toBe('');
    expect(await t.git.lfsStore('target').size('acme/app', oid)).toBeUndefined();
  });

  it('[TST-011] a failing repositoryHooks.created rolls the REST record back', async () => {
    const w = world({ repositoryHooks: { created: () => Promise.reject(new Error('disk full')) } });
    const res = await w.call('POST', '/orgs/acme/repos', { body: { name: 'x' } });
    expect(res.status).toBe(500);
    expect(w.fake.state.findRepo('acme', 'x')).toBeUndefined();
  });
});
