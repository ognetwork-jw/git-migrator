import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HOSTNAME,
  DEFAULT_PORTS,
  type RunningFakes,
  startFakes,
  startOptionsFromEnv,
} from './start.ts';

// These tests start the git server; a loaded machine needs more than the 5 s default.
vi.setConfig({ testTimeout: 60_000 });

let running: RunningFakes | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('[TST-010] fake Bitbucket over a real socket', () => {
  it('[TST-010] listens on the DEV-020 port by default and serves authenticated REST over HTTP', async () => {
    expect(DEFAULT_PORTS.bitbucket).toBe(4010);
    running = await startFakes({ bitbucketPort: 0, gitPort: 0, hostname: '127.0.0.1' });
    const base = `http://127.0.0.1:${running.bitbucket.port}`;
    running.bitbucket.state.addWorkspace({ slug: 'acme' });
    running.bitbucket.state.addCredentialMembers('acme');
    const auth = `Basic ${Buffer.from('operator@test.local:fake-bitbucket-api-token').toString('base64')}`;
    const ok = await fetch(`${base}/2.0/workspaces/acme/projects`, {
      headers: { Authorization: auth },
    });
    expect(ok.status).toBe(200);
    // next links are absolute and point back at the server the client used
    running.bitbucket.state.addProject('acme', { key: 'A' });
    running.bitbucket.state.addProject('acme', { key: 'B' });
    const page = (await (
      await fetch(`${base}/2.0/workspaces/acme/projects?pagelen=1`, {
        headers: { Authorization: auth },
      })
    ).json()) as {
      next: string;
    };
    expect(page.next.startsWith(base)).toBe(true);
    expect((await fetch(page.next, { headers: { Authorization: auth } })).status).toBe(200);
    expect((await fetch(`${base}/2.0/workspaces/acme/projects`)).status).toBe(401);
    const reset = await fetch(`${base}/__reset`, {
      method: 'POST',
      body: JSON.stringify({ fixture: 'empty' }),
    });
    expect(reset.status).toBe(200);
    expect(
      ((await (await fetch(`${base}/__state`)).json()) as { state: { workspaces: unknown[] } })
        .state.workspaces,
    ).toEqual([]);
  });

  it('[TST-013] starts the git server beside the fake Bitbucket and points clone links at /source', async () => {
    expect(DEFAULT_PORTS.git).toBe(4030);
    running = await startFakes({ bitbucketPort: 0, gitPort: 0, hostname: '127.0.0.1' });
    const git = running.git;
    expect(git).toBeDefined();
    const res = await fetch(
      `${git?.baseUrl}/source/acme/app.git/info/refs?service=git-upload-pack`,
    );
    expect(res.status).toBe(401);
    const state = running.bitbucket.state;
    state.addWorkspace({ slug: 'acme' });
    state.addCredentialMembers('acme');
    state.addProject('acme', { key: 'P' });
    state.addRepository('acme', { slug: 'app', projectKey: 'P' });
    const auth = `Basic ${Buffer.from('operator@test.local:fake-bitbucket-api-token').toString('base64')}`;
    const repo = (await (
      await fetch(`http://127.0.0.1:${running.bitbucket.port}/2.0/repositories/acme/app`, {
        headers: { Authorization: auth },
      })
    ).json()) as { links: { clone: { href: string }[] } };
    expect(repo.links.clone[0]?.href).toBe(`${git?.baseUrl}/source/acme/app.git`);
  });

  it('[TST-010] fails to start when the port is taken', async () => {
    running = await startFakes({ bitbucketPort: 0, gitPort: 0, hostname: '127.0.0.1' });
    await expect(
      startFakes({ bitbucketPort: running.bitbucket.port, git: false, hostname: '127.0.0.1' }),
    ).rejects.toThrow();
  });
});

describe('[TST-010] binding', () => {
  it('[TST-010] binds to loopback unless a hostname is given (the control plane has no auth)', async () => {
    expect(DEFAULT_HOSTNAME).toBe('127.0.0.1');
    running = await startFakes({ bitbucketPort: 0, gitPort: 0 });
    const res = await fetch(`http://127.0.0.1:${running.bitbucket.port}/__state`);
    expect(res.status).toBe(200);
  });
});

describe('[TST-013] shutdown', () => {
  it('[TST-013] close() still closes the git server when closing the fake Bitbucket fails', async () => {
    const fakes = await startFakes({ bitbucketPort: 0, gitPort: 0, githubPort: 0 });
    await fakes.close();
    // A second close fails on the (already closed) Bitbucket server; the others must still be tried.
    const git = fakes.git;
    expect(git).toBeDefined();
    const gitClose = vi.spyOn(git as NonNullable<typeof git>, 'close').mockResolvedValue();
    await expect(fakes.close()).rejects.toThrow();
    expect(gitClose).toHaveBeenCalledTimes(1);
  });
});

describe('[TST-013] entry environment', () => {
  it('[TST-013] FAKE_GIT_BASE_URL is the git server root for both fakes: /source for Bitbucket, /target for GitHub', () => {
    const options = startOptionsFromEnv({ FAKE_GIT_BASE_URL: 'http://localhost:4030/' });
    expect(options.bitbucket?.gitBaseUrl).toBe('http://localhost:4030/source');
    expect(options.github?.gitBaseUrl).toBe('http://localhost:4030/target');
    const none = startOptionsFromEnv({});
    expect(none.bitbucket).toEqual({});
    expect(none.github).toEqual({});
    expect(none.githubPort).toBe(DEFAULT_PORTS.github);
  });

  it('[TST-013] reads ports, host, git root and public URL from the documented variables', () => {
    const options = startOptionsFromEnv({
      FAKE_BITBUCKET_PORT: '5010',
      FAKE_GITHUB_PORT: '5020',
      FAKE_GIT_PORT: '5030',
      FAKE_GIT_ROOT: '/tmp/x',
      FAKES_HOST: '0.0.0.0',
      FAKE_GIT_PUBLIC_URL: 'http://fakes:4030',
    });
    expect(options).toMatchObject({
      bitbucketPort: 5010,
      githubPort: 5020,
      gitPort: 5030,
      gitRootDir: '/tmp/x',
      hostname: '0.0.0.0',
      git: { publicUrl: 'http://fakes:4030' },
    });
  });
});
