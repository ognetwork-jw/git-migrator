import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { basicAuthEnv, isolatedGitEnv, runGit } from './client.ts';
import { assertGitPrerequisites } from './preconditions.ts';
import { createBareRepo, pseudoRandomBytes, seedBareRepo, sha256 } from './seed.ts';
import { type FakeGitServer, GIT_SIDES, startFakeGitServer } from './server.ts';

// These tests drive the git CLI; a loaded machine needs more than the 5 s default.
vi.setConfig({ testTimeout: 60_000 });

const TOKEN = 'test-token-value';
const MIB = 1024 * 1024;

let work: string;
let server: FakeGitServer;
let argvLog: string;
let shimDir: string;

/**
 * Runs git with the token only in the child's environment. `git` and `git-lfs` are recording shims
 * (first on PATH) that log every argv, including the git-lfs processes git spawns itself, then exec
 * the real binary; the last test asserts the secret is in none of them.
 */
function git(args: string[], cwd: string, opts: { token?: string | null; check?: boolean } = {}) {
  const token = opts.token === undefined ? TOKEN : opts.token;
  const env = isolatedGitEnv(work, {
    PATH: `${shimDir}:${process.env.PATH}`,
    ARGV_LOG: argvLog,
    ...(token === null ? {} : basicAuthEnv('x-test-user', token)),
  });
  return runGit(args, { cwd, env, check: opts.check });
}

async function installShims(): Promise<void> {
  shimDir = join(work, 'shims');
  argvLog = join(work, 'argv.log');
  await mkdir(shimDir, { recursive: true });
  await writeFile(argvLog, '');
  for (const name of ['git', 'git-lfs']) {
    const real = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
    await writeFile(
      join(shimDir, name),
      `#!/bin/sh\nprintf '%s' "${name}" >> "$ARGV_LOG"\nfor a in "$@"; do printf ' %s' "$a" >> "$ARGV_LOG"; done\nprintf '\\n' >> "$ARGV_LOG"\nexec ${real} "$@"\n`,
    );
    await chmod(join(shimDir, name), 0o755);
  }
}

/** `git clone` with the LFS filter configured (no `git lfs install` needed in a fresh directory). */
const LFS_FILTER = [
  '-c',
  'filter.lfs.clean=git-lfs clean -- %f',
  '-c',
  'filter.lfs.smudge=git-lfs smudge -- %f',
  '-c',
  'filter.lfs.process=git-lfs filter-process',
  '-c',
  'filter.lfs.required=true',
];

async function newClone(url: string, name: string): Promise<string> {
  const dir = join(work, name);
  await git(['clone', '-q', url, dir], work);
  return dir;
}

async function commitFile(dir: string, path: string, content: Buffer | string, msg = 'add') {
  await mkdir(join(dir, path, '..'), { recursive: true });
  await writeFile(join(dir, path), content);
  await git(['add', '-A'], dir);
  await git(['commit', '-q', '-m', msg], dir);
}

beforeAll(async () => {
  assertGitPrerequisites({ lfs: true });
  work = await mkdtemp(join(tmpdir(), 'fake-git-test-'));
  await installShims();
  server = await startFakeGitServer({
    rootDir: join(work, 'root'),
    port: 0,
    source: { tokens: [TOKEN] },
    target: { tokens: [TOKEN], maxBlobBytes: 1 * MIB, maxPushBytes: 64 * MIB },
  });
});

afterAll(async () => {
  await server.close();
  await rm(work, { recursive: true, force: true });
});

describe('fake git server', () => {
  it('[TST-013] serves seeded repositories: clone, ls-remote with annotated and lightweight tags', async () => {
    await createBareRepo(server.repoDir('source', 'acme/app'));
    const seeded = await seedBareRepo(server.repoDir('source', 'acme/app'), {
      commits: 5,
      branches: [{ name: 'develop', commits: 2 }],
      tags: [
        { name: 'v1.0.0', annotated: true, message: 'one\n' },
        { name: 'light', target: 'develop' },
      ],
    });
    const ls = await git(['ls-remote', server.repoUrl('source', 'acme/app')], work);
    const lines = ls.stdout.trim().split('\n');
    expect(lines).toContain(`${seeded.heads.main}\trefs/heads/main`);
    expect(lines).toContain(`${seeded.heads.develop}\trefs/heads/develop`);
    expect(lines).toContain(`${seeded.tags['v1.0.0']}\trefs/tags/v1.0.0`);
    expect(lines).toContain(`${seeded.heads.main}\trefs/tags/v1.0.0^{}`);
    expect(lines).toContain(`${seeded.heads.develop}\trefs/tags/light`);

    const dir = await newClone(server.repoUrl('source', 'acme/app'), 'clone-src');
    const log = await git(['rev-list', '--count', 'main'], dir);
    expect(log.stdout.trim()).toBe('5');
  });

  it('[TST-013] accepts pushes on the target side and keeps the two roots separate', async () => {
    await createBareRepo(server.repoDir('target', 'acme/app'));
    const dir = await newClone(server.repoUrl('source', 'acme/app'), 'clone-for-push');
    await git(['remote', 'add', 'dest', server.repoUrl('target', 'acme/app')], dir);
    await git(['push', '-q', '--mirror', 'dest'], dir);
    const ls = await git(['ls-remote', server.repoUrl('target', 'acme/app')], work);
    expect(ls.stdout).toContain('refs/tags/v1.0.0^{}');
    expect(server.reposDir('source')).not.toBe(server.reposDir('target'));
    const missing = await git(['ls-remote', server.repoUrl('target', 'acme/other')], work, {
      check: false,
    });
    expect(missing.code).not.toBe(0);
  });

  it('[TST-013] rejects missing and wrong credentials with 401', async () => {
    const url = server.repoUrl('source', 'acme/app');
    const bad = await git(['ls-remote', url], work, { token: 'wrong', check: false });
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toMatch(/401|Authentication failed|could not read Username/);
    const none = await git(['ls-remote', url], work, { token: null, check: false });
    expect(none.code).not.toBe(0);
    const res = await fetch(`${url}/info/refs?service=git-upload-pack`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Basic/);
  });

  it('[TST-013] honours a custom username list and runtime token changes', async () => {
    const s = await startFakeGitServer({
      rootDir: join(work, 'root2'),
      port: 0,
      source: { usernames: ['x-bitbucket-api-token-auth'], tokens: ['a'] },
    });
    try {
      await createBareRepo(s.repoDir('source', 'p/r'));
      const ok = Buffer.from('x-bitbucket-api-token-auth:a').toString('base64');
      const wrongUser = Buffer.from('someone:a').toString('base64');
      const url = `${s.repoUrl('source', 'p/r')}/info/refs?service=git-upload-pack`;
      expect((await fetch(url, { headers: { authorization: `Basic ${ok}` } })).status).toBe(200);
      expect((await fetch(url, { headers: { authorization: `Basic ${wrongUser}` } })).status).toBe(
        401,
      );
      s.setTokens('source', ['b']);
      expect((await fetch(url, { headers: { authorization: `Basic ${ok}` } })).status).toBe(401);
      expect((await fetch(`${s.baseUrl}/nope`)).status).toBe(404);
      expect(GIT_SIDES).toEqual(['source', 'target']);
    } finally {
      await s.close();
    }
  });

  it('[TST-013] rejects a push containing a blob over the max blob size like GitHub', async () => {
    await createBareRepo(server.repoDir('target', 'acme/blob'));
    const dir = await newClone(server.repoUrl('target', 'acme/blob'), 'clone-blob');
    await commitFile(dir, 'small.bin', pseudoRandomBytes(10_000), 'small');
    await git(['push', '-q', 'origin', 'HEAD:refs/heads/main'], dir);
    await commitFile(dir, 'data/huge.bin', pseudoRandomBytes(2 * MIB), 'huge');
    const push = await git(['push', 'origin', 'HEAD:refs/heads/main'], dir, { check: false });
    expect(push.code).not.toBe(0);
    expect(push.stderr).toContain(
      "remote: error: File data/huge.bin is 2.00 MB; this exceeds GitHub's file size limit of 1.00 MB",
    );
    expect(push.stderr).toContain('remote: error: GH001: Large files detected.');
    expect(push.stderr).toContain('[remote rejected]');
    expect(push.stderr).toContain('pre-receive hook declined');
    // The target ref is unchanged and new branches with the blob are rejected too.
    const head = await git(['rev-parse', 'refs/heads/main'], server.repoDir('target', 'acme/blob'));
    const local = await git(['rev-parse', 'HEAD~1'], dir);
    expect(head.stdout).toBe(local.stdout);
    const newBranch = await git(['push', 'origin', 'HEAD:refs/heads/other'], dir, { check: false });
    expect(newBranch.code).not.toBe(0);

    server.setLimits('target', { maxBlobBytes: null });
    await git(['push', '-q', 'origin', 'HEAD:refs/heads/main'], dir);
    server.setLimits('target', { maxBlobBytes: 1 * MIB });
  }, 30_000);

  it('[TST-013] rejects a push over the max push size', async () => {
    await createBareRepo(server.repoDir('target', 'acme/pack'));
    const dir = await newClone(server.repoUrl('target', 'acme/pack'), 'clone-pack');
    await commitFile(dir, 'a.bin', pseudoRandomBytes(900_000, 7));
    await commitFile(dir, 'b.bin', pseudoRandomBytes(900_000, 8));
    server.setLimits('target', { maxPushBytes: 500_000 });
    try {
      const push = await git(['push', 'origin', 'HEAD:refs/heads/main'], dir, { check: false });
      expect(push.code).not.toBe(0);
      expect(push.stderr).toContain('HTTP 413');
      const refs = await git(['for-each-ref'], server.repoDir('target', 'acme/pack'));
      expect(refs.stdout.trim()).toBe('');
    } finally {
      server.setLimits('target', { maxPushBytes: 64 * MIB });
    }
    await git(['push', '-q', 'origin', 'HEAD:refs/heads/main'], dir);
  });

  it('[TST-013] stores LFS objects on push and serves them on clone', async () => {
    await createBareRepo(server.repoDir('target', 'acme/lfs'));
    const dir = await newClone(server.repoUrl('target', 'acme/lfs'), 'clone-lfs');
    await git(['lfs', 'install', '--local'], dir);
    await git(['lfs', 'track', '*.dat'], dir);
    const payload = pseudoRandomBytes(3 * MIB, 42); // above maxBlobBytes: only the pointer is a blob
    await commitFile(dir, 'big.dat', payload, 'lfs file');
    await git(['push', '-q', 'origin', 'HEAD:refs/heads/main'], dir);

    const stored = await server.lfsStore('target').get('acme/lfs', sha256(payload));
    expect(stored?.equals(payload)).toBe(true);
    expect(await server.lfsStore('source').get('acme/lfs', sha256(payload))).toBeUndefined();

    const other = join(work, 'clone-lfs-2');
    await git([...LFS_FILTER, 'clone', '-q', server.repoUrl('target', 'acme/lfs'), other], work);
    expect((await readFile(join(other, 'big.dat'))).equals(payload)).toBe(true);
  });

  it('[TST-013] fetches seeded LFS objects and pointers', async () => {
    await createBareRepo(server.repoDir('source', 'acme/seeded'));
    const seeded = await seedBareRepo(
      server.repoDir('source', 'acme/seeded'),
      {
        lfsFiles: [{ path: 'assets/model.bin', bytes: 200_000 }],
        bigBlobs: [{ path: 'blob.bin', bytes: 1_500_000 }],
        commits: 50,
      },
      { store: server.lfsStore('source'), repo: 'acme/seeded' },
    );
    const entry = seeded.lfs['assets/model.bin'];
    expect(entry?.size).toBe(200_000);
    const dir = join(work, 'clone-seeded');
    await git([...LFS_FILTER, 'clone', '-q', server.repoUrl('source', 'acme/seeded'), dir], work);
    expect((await readFile(join(dir, 'assets/model.bin'))).length).toBe(200_000);
    const count = await git(['rev-list', '--count', 'HEAD'], dir);
    expect(count.stdout.trim()).toBe('51');
    // Pushing the plain big blob to the target is rejected, the LFS file is not.
    await createBareRepo(server.repoDir('target', 'acme/seeded'));
    const push = await git(
      ['push', server.repoUrl('target', 'acme/seeded'), 'HEAD:refs/heads/main'],
      dir,
      { check: false },
    );
    expect(push.stderr).toContain('blob.bin');
  });

  describe('LFS batch API', () => {
    beforeAll(async () => {
      await createBareRepo(server.repoDir('target', 'acme/batchy'));
    });
    const auth = { authorization: `Basic ${Buffer.from(`u:${TOKEN}`).toString('base64')}` };
    const lfsUrl = () => `${server.repoUrl('target', 'acme/batchy')}/info/lfs`;
    const post = (path: string, body: unknown, headers: Record<string, string> = auth) =>
      fetch(`${lfsUrl()}${path}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/vnd.git-lfs+json' },
        body: JSON.stringify(body),
      });
    const content = Buffer.from('hello lfs');
    const oid = sha256(content);

    it('[TST-013] requires auth', async () => {
      expect(
        (await post('/objects/batch', { operation: 'download', objects: [] }, {})).status,
      ).toBe(401);
    });

    it('[TST-013] reports missing objects as per-object 404 for download', async () => {
      const res = await post('/objects/batch', {
        operation: 'download',
        transfers: ['basic'],
        objects: [{ oid, size: content.length }],
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/vnd.git-lfs+json');
      const body = (await res.json()) as { objects: { error?: { code: number } }[] };
      expect(body.objects[0]?.error?.code).toBe(404);
    });

    it('[TST-013] uploads, verifies and downloads an object over basic transfer', async () => {
      const batch = (await (
        await post('/objects/batch', {
          operation: 'upload',
          objects: [{ oid, size: content.length }],
        })
      ).json()) as {
        objects: {
          actions: {
            upload: { href: string };
            verify: { href: string };
          };
        }[];
      };
      const actions = batch.objects[0]?.actions;
      expect(actions?.upload).toBeDefined();
      expect((await post('/verify', { oid, size: content.length })).status).toBe(404);
      const bad = await fetch(actions?.upload.href as string, {
        method: 'PUT',
        headers: auth,
        body: 'tampered',
      });
      expect(bad.status).toBe(422);
      const put = await fetch(actions?.upload.href as string, {
        method: 'PUT',
        headers: auth,
        body: content,
      });
      expect(put.status).toBe(200);
      expect((await post('/verify', { oid, size: content.length })).status).toBe(200);
      expect((await post('/verify', { oid, size: 1 })).status).toBe(404);

      const again = (await (
        await post('/objects/batch', {
          operation: 'upload',
          objects: [{ oid, size: content.length }],
        })
      ).json()) as { objects: { actions?: unknown }[] };
      expect(again.objects[0]?.actions).toBeUndefined();

      const dl = (await (
        await post('/objects/batch', {
          operation: 'download',
          objects: [{ oid, size: content.length }],
        })
      ).json()) as {
        objects: { actions: { download: { href: string } } }[];
      };
      const got = await fetch(dl.objects[0]?.actions.download.href as string, { headers: auth });
      expect(Buffer.from(await got.arrayBuffer()).equals(content)).toBe(true);
    });

    it('[TST-013] validates operation, oids and batch size', async () => {
      expect((await post('/objects/batch', { operation: 'bogus', objects: [] })).status).toBe(422);
      const invalid = (await (
        await post('/objects/batch', { operation: 'download', objects: [{ oid: 'xyz', size: 1 }] })
      ).json()) as { objects: { error?: { code: number } }[] };
      expect(invalid.objects[0]?.error?.code).toBe(422);
      const many = Array.from({ length: 101 }, () => ({ oid, size: 1 }));
      expect((await post('/objects/batch', { operation: 'download', objects: many })).status).toBe(
        413,
      );
    });
  });

  describe('LFS edge cases', () => {
    const auth = { authorization: `Basic ${Buffer.from(`u:${TOKEN}`).toString('base64')}` };
    it('[TST-013] answers 404 for LFS requests on a repository that does not exist', async () => {
      const base = `${server.baseUrl}/target/acme/ghost.git/info/lfs`;
      const oid = sha256('x');
      const batch = await fetch(`${base}/objects/batch`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ operation: 'download', objects: [] }),
      });
      expect(batch.status).toBe(404);
      expect(
        (await fetch(`${base}/objects/${oid}`, { method: 'PUT', headers: auth, body: 'x' })).status,
      ).toBe(404);
      expect((await fetch(`${base}/objects/${oid}`, { headers: auth })).status).toBe(404);
    });

    it('[TST-013] builds action links from the configured base URL, not the Host header', async () => {
      const res = await fetch(`${server.repoUrl('target', 'acme/app')}/info/lfs/objects/batch`, {
        method: 'POST',
        headers: { ...auth, host: 'evil.example' },
        body: JSON.stringify({ operation: 'upload', objects: [{ oid: sha256('y'), size: 1 }] }),
      });
      const body = (await res.json()) as {
        objects: { actions: { upload: { href: string; header?: unknown } } }[];
      };
      const upload = body.objects[0]?.actions.upload;
      expect(
        upload?.href.startsWith(`${server.baseUrl}/target/acme/app.git/info/lfs/objects/`),
      ).toBe(true);
      expect(upload?.header).toBeUndefined(); // credentials are not echoed; follow-up requests must authenticate
      expect((await fetch(upload?.href as string, { method: 'PUT', body: 'y' })).status).toBe(401);
    });

    it('[TST-013] rejects an upload whose size differs from the batch announcement', async () => {
      const oid = sha256('abcd');
      await fetch(`${server.repoUrl('target', 'acme/app')}/info/lfs/objects/batch`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ operation: 'upload', objects: [{ oid, size: 99 }] }),
      });
      const put = await fetch(`${server.repoUrl('target', 'acme/app')}/info/lfs/objects/${oid}`, {
        method: 'PUT',
        headers: auth,
        body: 'abcd',
      });
      expect(put.status).toBe(422);
    });
  });

  it('[TST-013] answers 404 for traversal and encoded-traversal repository paths', async () => {
    const basic = `Basic ${Buffer.from(`u:${TOKEN}`).toString('base64')}`;
    const get = (path: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port: server.port, path, headers: { authorization: basic } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
    for (const path of [
      '/target/../source/acme/app.git/info/refs?service=git-upload-pack',
      '/target/acme/%2e%2e/%2e%2e/etc.git/info/refs?service=git-upload-pack',
      '/target/acme/%2E%2E/app.git/info/refs?service=git-upload-pack',
      '/target/acme/../app.git/info/lfs/objects/batch',
      '/target/acme/%2e%2e/app.git/info/lfs/objects/batch',
    ]) {
      expect(await get(path), path).toBe(404);
    }
    expect(() => server.repoDir('target', '../escape')).toThrow();
    expect(() => server.repoDir('target', 'a/%2e%2e/b')).toThrow();
  });

  it('[TST-013] keeps the source side read-only by default', async () => {
    const dir = await newClone(server.repoUrl('source', 'acme/app'), 'clone-ro');
    await commitFile(dir, 'x.txt', 'x');
    const push = await git(['push', 'origin', 'HEAD:refs/heads/new'], dir, { check: false });
    expect(push.code).not.toBe(0);
    expect(push.stderr).toMatch(/403|denied|not found/i);
  });

  describe('blob rejection edge cases', () => {
    it('[TST-013] rejects a big blob buried deep in history and a tag that points straight at a blob', async () => {
      await createBareRepo(server.repoDir('target', 'acme/deep'));
      const dir = await newClone(server.repoUrl('target', 'acme/deep'), 'clone-deep');
      for (let i = 0; i < 4; i++) await commitFile(dir, `f${i}.txt`, `c${i}`);
      await commitFile(dir, 'deep/buried.bin', pseudoRandomBytes(2 * MIB, 3), 'buried');
      await git(['rm', '-q', 'deep/buried.bin'], dir);
      await git(['commit', '-q', '-m', 'remove'], dir);
      for (let i = 4; i < 8; i++) await commitFile(dir, `f${i}.txt`, `c${i}`);
      const deep = await git(['push', 'origin', 'HEAD:refs/heads/main'], dir, { check: false });
      expect(deep.code).not.toBe(0);
      expect(deep.stderr).toContain('File deep/buried.bin is 2.00 MB');

      // A tag that points directly at a blob has no path: the object id is printed instead.
      await writeFile(join(dir, 'tagged.bin'), pseudoRandomBytes(2 * MIB, 5));
      const oid = (await git(['hash-object', '-w', 'tagged.bin'], dir)).stdout.trim();
      await git(['tag', 'blob-tag', oid], dir);
      const tag = await git(['push', 'origin', 'refs/tags/blob-tag'], dir, { check: false });
      expect(tag.code).not.toBe(0);
      expect(tag.stderr).toContain(`File ${oid} is 2.00 MB`);
    });

    it('[TST-013] rejects all refs of a multi-ref push when one ref carries a big blob', async () => {
      await createBareRepo(server.repoDir('target', 'acme/multi'));
      const dir = await newClone(server.repoUrl('target', 'acme/multi'), 'clone-multi');
      await commitFile(dir, 'ok.txt', 'ok');
      await git(['branch', '-M', 'main'], dir);
      await git(['checkout', '-q', '-b', 'heavy'], dir);
      await commitFile(dir, 'heavy.bin', pseudoRandomBytes(2 * MIB, 9), 'heavy');
      const push = await git(['push', 'origin', 'main', 'heavy'], dir, { check: false });
      expect(push.code).not.toBe(0);
      expect(push.stderr).toContain('heavy.bin');
      const refs = await git(['for-each-ref'], server.repoDir('target', 'acme/multi'));
      expect(refs.stdout.trim()).toBe('');
    });

    it('[TST-013] accepts a blob that already exists in the repository store (force push of existing data)', async () => {
      await createBareRepo(server.repoDir('target', 'acme/existing'));
      const dir = await newClone(server.repoUrl('target', 'acme/existing'), 'clone-existing');
      await commitFile(dir, 'a.txt', 'a');
      await git(['checkout', '-q', '-b', 'tmp'], dir);
      await commitFile(dir, 'big.bin', pseudoRandomBytes(2 * MIB, 11), 'big');
      server.setLimits('target', { maxBlobBytes: null });
      await git(['push', '-q', 'origin', 'tmp'], dir);
      await git(['push', '-q', 'origin', ':tmp'], dir);
      server.setLimits('target', { maxBlobBytes: 1 * MIB });
      // The blob is unreachable on the server but still stored: not a new object.
      await git(['push', '-q', 'origin', 'HEAD:refs/heads/again'], dir);
    });
  });

  describe('default branch and history', () => {
    it('[FAC-GIT-001] ls-remote --symref reports a non-main default branch', async () => {
      await createBareRepo(server.repoDir('source', 'acme/trunk'), 'trunk');
      await seedBareRepo(server.repoDir('source', 'acme/trunk'), {
        defaultBranch: 'trunk',
        commits: 2,
      });
      const ls = await git(
        ['ls-remote', '--symref', server.repoUrl('source', 'acme/trunk'), 'HEAD'],
        work,
      );
      expect(ls.stdout).toContain('ref: refs/heads/trunk\tHEAD');
    });

    it('[FAC-GIT-001] ls-remote on an empty repository (unborn HEAD) succeeds and lists no refs', async () => {
      await createBareRepo(server.repoDir('source', 'acme/empty'));
      const ls = await git(['ls-remote', '--symref', server.repoUrl('source', 'acme/empty')], work);
      expect(ls.stdout).not.toContain('refs/heads/');
      const clone = await git(
        ['clone', '-q', server.repoUrl('source', 'acme/empty'), join(work, 'clone-empty')],
        work,
        { check: false },
      );
      expect(clone.code).toBe(0);
    });

    it('[LIF-044] a full push of a long history exceeds a low push limit while first-parent checkpoint pushes each fit', async () => {
      const src = server.repoDir('source', 'acme/long');
      await createBareRepo(src);
      await seedBareRepo(src, { commits: 1200, bytesPerCommit: 1000 }); // about 1.2 MB of pack
      await createBareRepo(server.repoDir('target', 'acme/long'));
      const url = server.repoUrl('target', 'acme/long');
      server.setLimits('target', { maxPushBytes: 500_000 });
      try {
        const full = await git(['push', url, 'main:refs/heads/main'], src, { check: false });
        expect(full.code).not.toBe(0);
        expect(full.stderr).toContain('HTTP 413');
        const refs = await git(['for-each-ref'], server.repoDir('target', 'acme/long'));
        expect(refs.stdout.trim()).toBe('');

        const chain = (await git(['rev-list', '--first-parent', '--reverse', 'main'], src)).stdout
          .trim()
          .split('\n');
        for (let i = 299; i < chain.length; i += 300) {
          await git(['push', '-q', url, `${chain[i]}:refs/heads/main`], src);
        }
        const head = await git(
          ['rev-parse', 'refs/heads/main'],
          server.repoDir('target', 'acme/long'),
        );
        expect(head.stdout.trim()).toBe(chain[chain.length - 1]);
      } finally {
        server.setLimits('target', { maxPushBytes: 64 * MIB });
      }
    });
  });

  it('[TST-013] never put the credential in the argv of any git or git-lfs process', async () => {
    const log = await readFile(argvLog, 'utf8');
    expect(log).toContain('git clone');
    expect(log).toContain('git-lfs');
    expect(log).toContain('git push');
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain(Buffer.from(`x-test-user:${TOKEN}`).toString('base64'));
  });
});
