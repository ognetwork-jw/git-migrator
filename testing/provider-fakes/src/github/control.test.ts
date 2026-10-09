import { describe, expect, it, vi } from 'vitest';
import { createFakeGitHub } from './app.ts';
import { jsonOf, world } from './harness.ts';
import { DEFAULT_GITHUB_PORT, startFakeGitHub } from './start.ts';

// These tests spawn git or servers; a loaded machine needs more than the 5 s default.
vi.setConfig({ testTimeout: 60_000 });

describe('control plane', () => {
  it('[TST-011] POST /__reset drops all state and reseeds the App and installation', async () => {
    const w = world();
    expect(w.fake.state.repos.size).toBe(2);
    const res = await w.fake.app.request('/__reset', {
      method: 'POST',
      body: JSON.stringify({ fixture: 'empty' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fixture: 'empty' });
    expect(w.fake.state.repos.size).toBe(0);
    expect(w.fake.state.users.size).toBe(0);
    expect(w.fake.state.requireOrg('acme').members.size).toBe(0);
    expect(w.fake.state.installations.size).toBe(1);
    expect((await w.call('GET', '/orgs/acme')).body.message).toBe('Bad credentials'); // old tokens are gone
    const again = await w.fake.app.request('/__reset', { method: 'POST' });
    expect(again.status).toBe(200);
  });

  it('[TST-011] logs the API requests it served, and a reset or clearRequests() empties the log', async () => {
    const w = world();
    expect(w.fake.requests()).toEqual([]);
    await w.call('GET', '/orgs/acme');
    await w.call('GET', '/orgs/acme/members');
    const log = w.fake.requests();
    expect(log.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /orgs/acme',
      'GET /orgs/acme/members',
    ]);
    expect(log.every((r) => r.status === 200 && !r.write)).toBe(true);
    // A GraphQL query is a read, a mutation a write.
    const rule = (query: string) => w.call('POST', '/graphql', { body: { query } });
    await rule('query { viewer { login } }').catch(() => undefined);
    await rule('mutation { createBranchProtectionRule(input: {}) { clientMutationId } }').catch(
      () => undefined,
    );
    const graphql = w.fake.requests().filter((r) => r.path === '/graphql');
    expect(graphql.map((r) => r.write)).toEqual([false, true]);
    w.fake.clearRequests();
    expect(w.fake.requests()).toEqual([]);
    await w.call('GET', '/orgs/acme');
    await w.fake.reset('empty');
    expect(w.fake.requests()).toEqual([]);
  });

  it('[TST-011] reset is deterministic: two resets give identical ids', async () => {
    const fake = createFakeGitHub();
    const build = async () => {
      await fake.reset();
      fake.state.addMember('acme', 'alice');
      return fake.state.addRepository('acme', { name: 'r', files: { a: 'x' } });
    };
    const a = await build();
    const aRefs = [...a.git.refs];
    const b = await build();
    expect(b.id).toBe(a.id);
    expect(b.nodeId).toBe(a.nodeId);
    expect([...b.git.refs]).toEqual(aRefs);
  });

  it('[TST-011] unknown fixtures are a 400 listing the known ones; named fixtures run against fresh state', async () => {
    const fake = createFakeGitHub({
      fixtures: {
        demo: (s) => {
          s.addMember('acme', 'zed');
        },
      },
    });
    const bad = await fake.app.request('/__reset', {
      method: 'POST',
      body: JSON.stringify({ fixture: 'nope' }),
    });
    expect(bad.status).toBe(400);
    expect((await jsonOf(bad)).message).toContain('empty, demo');
    await fake.app.request('/__reset', {
      method: 'POST',
      body: JSON.stringify({ fixture: 'demo' }),
    });
    expect(fake.state.requireOrg('acme').members.has('zed')).toBe(true);
    const state = (await (await fake.app.request('/__state')).json()) as { fixture: string };
    expect(state.fixture).toBe('demo');
    await fake.app.request('/__reset', { method: 'POST', body: '{}' });
    expect(fake.state.requireOrg('acme').members.size).toBe(0);
  });

  it('[TST-011] GET /__state shows the world without secrets', async () => {
    const w = world();
    const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIsecretsecretsecretsecretsecretsecretsecret1';
    w.fake.state.addDeployKey(w.repo, { key, title: 't' });
    w.fake.state.addHook(w.repo, { url: 'https://example.test', secret: 'hook-secret-value' });
    w.fake.state.addVariable(w.repo, 'V', 'plain');
    w.fake.state.addSecret(w.repo, 'S');
    const res = await w.call('GET', '/__state', { token: null });
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(w.token);
    expect(text).not.toContain('hook-secret-value');
    expect(text).not.toContain('secretsecret');
    expect(res.body.repositories.map((r: { fullName: string }) => r.fullName)).toEqual([
      'acme/auto-ok',
      'acme/empty',
    ]);
    expect(res.body.repositories[0]).toMatchObject({
      empty: false,
      gitRoot: null,
      cloneUrl: 'http://localhost:4030/target/acme/auto-ok.git',
      secrets: ['S'],
    });
    expect(res.body.repositories[1].empty).toBe(true);
    expect(res.body.tokens).toHaveLength(1);
  });

  it('[TST-011] POST /__config changes limits without resetting state; clearUsage resets counters', async () => {
    const w = world();
    await w.call('GET', '/orgs/acme');
    const cfg = await w.fake.app.request('/__config', {
      method: 'POST',
      body: JSON.stringify({ primary: { limits: { core: 1 } }, clearUsage: true }),
    });
    expect(cfg.status).toBe(200);
    expect(w.fake.state.repos.size).toBe(2);
    expect((await w.call('GET', '/orgs/acme')).status).toBe(200);
    expect((await w.call('GET', '/orgs/acme')).status).toBe(403);
    await w.fake.app.request('/__reset', {
      method: 'POST',
      body: JSON.stringify({ config: 1, primary: { limits: { core: 1 } } }),
    });
    expect(w.fake.config().primary.limits?.core).toBe(1);
    await w.fake.app.request('/__reset', { method: 'POST' });
    expect(w.fake.config().primary).toEqual({});
  });

  it('[TST-011] POST /__token issues an installation token for e2e clients without a JWT', async () => {
    const w = world();
    const res = await w.fake.app.request('/__token', {
      method: 'POST',
      body: JSON.stringify({ ttlSeconds: 60, permissions: { metadata: 'read' } }),
    });
    expect(res.status).toBe(201);
    const { token } = await jsonOf(res);
    expect((await w.call('GET', '/orgs/acme', { token })).status).toBe(200);
    expect((await w.call('POST', '/orgs/acme/repos', { token, body: { name: 'x' } })).status).toBe(
      403,
    );
  });

  it('[TST-011] bad JSON on the control plane and unknown routes are GitHub-shaped errors', async () => {
    const w = world();
    expect((await w.fake.app.request('/__reset', { method: 'POST', body: '{x' })).status).toBe(400);
    const missing = await w.call('GET', '/nope');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ message: 'Not Found', status: '404' });
    expect((await w.call('POST', '/orgs/acme/teams', { body: undefined })).status).toBe(422);
    const bad = await w.fake.app.request('/orgs/acme/teams', {
      method: 'POST',
      headers: { authorization: `Bearer ${w.token}` },
      body: '[1]',
    });
    expect(bad.status).toBe(400);
  });
});

describe('startFakeGitHub', () => {
  it('[DEV-020] defaults to port 4020 on 127.0.0.1 and serves real HTTP on an ephemeral port', async () => {
    expect(DEFAULT_GITHUB_PORT).toBe(4020);
    const running = await startFakeGitHub({ port: 0 });
    try {
      expect(running.hostname).toBe('127.0.0.1');
      expect(running.url).toBe(`http://127.0.0.1:${running.port}`);
      const token = running.token();
      const res = await fetch(`${running.url}/orgs/acme`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = await jsonOf(res);
      expect(body.url).toBe(`${running.url}/orgs/acme`);
      expect(res.headers.get('x-ratelimit-limit')).toBe('5000');
    } finally {
      await running.close();
    }
  });
});

describe('startFakes', () => {
  it('[DEV-020] starts the fake GitHub beside the others when asked, with clone links on the git server target side', async () => {
    const { startFakes, DEFAULT_PORTS } = await import('../start.ts');
    expect(DEFAULT_PORTS.github).toBe(4020);
    const running = await startFakes({ bitbucketPort: 0, githubPort: 0, gitPort: 0 });
    try {
      expect(running.github).toBeDefined();
      const gh = running.github;
      if (!gh) throw new Error('github not started');
      gh.state.addRepository('acme', { name: 'app' });
      const res = await fetch(`http://127.0.0.1:${gh.port}/repos/acme/app`, {
        headers: { authorization: `Bearer ${gh.token()}` },
      });
      expect((await jsonOf(res)).clone_url).toBe(`${running.git?.baseUrl}/target/acme/app.git`);
    } finally {
      await running.close();
    }
  });

  it('[DEV-020] does not start the GitHub fake unless asked', async () => {
    const { startFakes } = await import('../start.ts');
    const running = await startFakes({ bitbucketPort: 0, gitPort: 0 });
    try {
      expect(running.github).toBeUndefined();
    } finally {
      await running.close();
    }
  });
});

describe('git server seam', () => {
  it('[TST-011] repository hooks fire for REST create, rename and delete only', async () => {
    const calls: string[] = [];
    const w = world({
      repositoryHooks: {
        created: (r) => void calls.push(`created ${r.name}`),
        renamed: (r, old) => void calls.push(`renamed ${old} -> ${r.name}`),
        deleted: (r) => void calls.push(`deleted ${r.name}`),
      },
    });
    expect(calls).toEqual([]); // builders do not call hooks
    await w.call('POST', '/orgs/acme/repos', { body: { name: 'a' } });
    await w.call('PATCH', '/repos/acme/a', { body: { name: 'b' } });
    await w.call('PATCH', '/repos/acme/b', { body: { default_branch: 'nope', name: 'c' } });
    await w.call('DELETE', '/repos/acme/b');
    expect(calls).toEqual(['created a', 'renamed a -> b', 'deleted b']);
  });

  it('[TST-013] with the git server, REST create/rename/delete manage the bare repository and LFS existence reads its store', async () => {
    const { startFakes } = await import('../start.ts');
    const { existsSync } = await import('node:fs');
    const running = await startFakes({ bitbucketPort: 0, githubPort: 0, gitPort: 0 });
    try {
      const gh = running.github;
      const git = running.git;
      if (!gh || !git) throw new Error('fakes not started');
      const call = (method: string, path: string, body?: unknown) =>
        fetch(`http://127.0.0.1:${gh.port}${path}`, {
          method,
          headers: { authorization: `Bearer ${gh.token()}`, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      expect((await call('POST', '/orgs/acme/repos', { name: 'app' })).status).toBe(201);
      expect(existsSync(git.repoDir('target', 'acme/app'))).toBe(true);
      const { oid } = await git.lfsStore('target').put('acme/app', 'hello lfs');
      const batch = await fetch(`http://127.0.0.1:${gh.port}/acme/app.git/info/lfs/objects/batch`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`x-access-token:${gh.token()}`).toString('base64')}`,
        },
        body: JSON.stringify({
          operation: 'download',
          objects: [
            { oid, size: 9 },
            { oid: 'f'.repeat(64), size: 1 },
          ],
        }),
      });
      const objects = (await jsonOf(batch)).objects;
      expect(objects[0].size).toBe(9);
      expect(objects[1].error.code).toBe(404);
      expect((await call('PATCH', '/repos/acme/app', { name: 'renamed' })).status).toBe(200);
      expect(existsSync(git.repoDir('target', 'acme/app'))).toBe(false);
      expect(existsSync(git.repoDir('target', 'acme/renamed'))).toBe(true);
      expect((await call('DELETE', '/repos/acme/renamed')).status).toBe(204);
      expect(existsSync(git.repoDir('target', 'acme/renamed'))).toBe(false);
    } finally {
      await running.close();
    }
  });
});
