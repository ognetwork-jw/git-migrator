import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isAdapterError, type Logger } from '@git-migrator/adapter-sdk';
import {
  createBareRepo,
  type FakeGitServer,
  type SeedSpec,
  seedBareRepo,
  startFakeGitServer,
} from '@git-migrator/provider-fakes';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isGitCommandError } from './errors.ts';
import type { SpawnFunction } from './exec.ts';
import { type LfsBatchClient, verifyLfsParity } from './lfs.ts';
import type { GitQuota } from './quota.ts';
import { GitService, type GitServiceOptions } from './service.ts';

// These tests drive the real git and git-lfs CLIs against the fake git server (TST-006, TST-013).
vi.setConfig({ testTimeout: 90_000 });

const TOKEN = 'tok-9f8e7d6c5b4a-secret';
const USER = 'x-migrator';
const credential = { username: USER, password: TOKEN };
const KIB = 1024;

let work: string;
let server: FakeGitServer;

interface Call {
  args: string[];
  env: Record<string, string>;
  /** Mode bits of the credential file at spawn time, when the command had one. */
  credentialMode?: number;
}

function recordingSpawn(
  calls: Call[],
  replace?: (args: string[]) => string[] | undefined,
): SpawnFunction {
  return (command, args, options) => {
    const call: Call = { args: [...args], env: { ...(options.env as Record<string, string>) } };
    const askpass = call.env.GIT_ASKPASS;
    if (askpass !== undefined) {
      try {
        call.credentialMode = statSync(join(dirname(askpass), 'credential')).mode & 0o777;
      } catch {
        // the command has no credential session
      }
    }
    calls.push(call);
    const fake = replace?.(call.args);
    if (fake !== undefined) return nodeSpawn('sh', fake, options);
    return nodeSpawn(command, args, options);
  };
}

/** The `GIT_CONFIG_*` entries of a recorded command, as a map. */
function configOf(call: Call | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const count = Number(call?.env.GIT_CONFIG_COUNT ?? 0);
  for (let i = 0; i < count; i++) {
    out[call?.env[`GIT_CONFIG_KEY_${i}`] as string] = call?.env[`GIT_CONFIG_VALUE_${i}`] as string;
  }
  return out;
}

/** Live (non-zombie) members of a process group; zombies are not reaped inside a container. */
function liveGroupMembers(pgid: number): string[] {
  const out = execFileSync('ps', ['-eo', 'pgid=,stat=,args='], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([group, stat]) => Number(group) === pgid && !stat?.startsWith('Z'))
    .map((parts) => parts.join(' '));
}

function capturingLogger(): Logger & { records: unknown[] } {
  const records: unknown[] = [];
  const push = (fields: Record<string, unknown>, message?: string) => {
    records.push({ fields, message });
  };
  return { records, debug: push, info: push, warn: push, error: push };
}

function recordingQuota(): GitQuota & { units: number[] } {
  const units: number[] = [];
  return {
    units,
    async acquire(n) {
      units.push(n);
    },
  };
}

async function scratch(): Promise<string> {
  const dir = join(work, `scratch-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function serviceFor(
  scratchDir: string,
  extra: Partial<GitServiceOptions> = {},
): { service: GitService; quota: ReturnType<typeof recordingQuota>; calls: Call[] } {
  const quota = recordingQuota();
  const calls: Call[] = [];
  const service = new GitService({
    quota,
    scratchDir,
    spawn: recordingSpawn(calls),
    ...extra,
  });
  return { service, quota, calls };
}

async function source(name: string, spec: SeedSpec) {
  const repo = `acme/${name}`;
  await createBareRepo(server.repoDir('source', repo));
  const seeded = await seedBareRepo(server.repoDir('source', repo), spec, {
    store: server.lfsStore('source'),
    repo,
  });
  return { repo, url: server.repoUrl('source', repo), seeded };
}

async function target(name: string) {
  const repo = `acme/${name}`;
  await createBareRepo(server.repoDir('target', repo));
  return { repo, url: server.repoUrl('target', repo) };
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'git-pkg-test-'));
  server = await startFakeGitServer({
    rootDir: join(work, 'srv'),
    port: 0,
    source: { tokens: [TOKEN] },
    target: { tokens: [TOKEN], maxBlobBytes: null },
  });
});

afterAll(async () => {
  await server.close();
  await rm(work, { recursive: true, force: true });
});

describe('ls-remote against the fake git server', () => {
  it('[FAC-GIT-001] lists branches and tags, records annotated tags as tag object and peeled commit, and reads the HEAD symref', async () => {
    const src = await source('lsr', {
      commits: 2,
      branches: [{ name: 'dev' }],
      tags: [{ name: 'v1', annotated: true }, { name: 'v0' }],
    });
    const { service, quota } = serviceFor(await scratch());
    const result = await service.lsRemote({ url: src.url, credential });
    expect(result.headSymref).toBe('refs/heads/main');
    const byName = new Map(result.refs.map((ref) => [ref.name, ref]));
    expect(byName.get('refs/heads/main')).toEqual({
      name: 'refs/heads/main',
      sha: src.seeded.heads.main,
    });
    expect(byName.get('refs/heads/dev')?.sha).toBe(src.seeded.heads.dev);
    expect(byName.get('refs/tags/v0')).toEqual({
      name: 'refs/tags/v0',
      sha: src.seeded.heads.main,
    });
    expect(byName.get('refs/tags/v1')).toEqual({
      name: 'refs/tags/v1',
      sha: src.seeded.tags.v1,
      peeled: src.seeded.heads.main,
    });
    expect(src.seeded.tags.v1).not.toBe(src.seeded.heads.main);
    expect(result.refs.some((ref) => ref.name.endsWith('^{}'))).toBe(false);
    expect(quota.units).toEqual([1]);
  });

  it('[FAC-GIT-001] an empty repository has no refs', async () => {
    const empty = await target('lsr-empty');
    const { service } = serviceFor(await scratch());
    expect((await service.lsRemote({ url: empty.url, credential })).refs).toEqual([]);
  });

  it('[ADP-050] a wrong token is an unauthorized AdapterError that never contains the token', async () => {
    const src = await source('lsr-bad', { commits: 1 });
    const { service } = serviceFor(await scratch());
    const bad = { username: USER, password: 'wrong-token-value-123' };
    const error = await service
      .lsRemote({ url: src.url, credential: bad })
      .catch((e: unknown) => e);
    expect(isAdapterError(error)).toBe(true);
    expect((error as { code: string }).code).toBe('unauthorized');
    expect(String((error as Error).message)).not.toContain(bad.password);
  });

  it('[JOB-041] a denied quota acquire raises rate_limited and starts no git process', async () => {
    const src = await source('lsr-quota', { commits: 1 });
    const calls: Call[] = [];
    const retryAt = new Date(Date.now() + 30_000);
    const service = new GitService({
      scratchDir: await scratch(),
      spawn: recordingSpawn(calls),
      quota: {
        async acquire() {
          const { AdapterError } = await import('@git-migrator/adapter-sdk');
          throw new AdapterError({
            code: 'rate_limited',
            provider: 'git',
            message: 'denied',
            retryAt,
          });
        },
      },
    });
    const error = await service.lsRemote({ url: src.url, credential }).catch((e: unknown) => e);
    expect((error as { code: string }).code).toBe('rate_limited');
    expect((error as { retryAt: Date }).retryAt).toBe(retryAt);
    expect(calls).toEqual([]);
  });
});

describe('mirror, blob scan and credential hygiene', () => {
  it('[ADP-071] credentials appear in no argv, environment, config file or scratch file, and the askpass files are removed', async () => {
    const src = await source('hygiene', {
      commits: 2,
      tags: [{ name: 'v1', annotated: true }],
      lfsFiles: [{ path: 'asset.bin', bytes: 2000 }],
    });
    const dst = await target('hygiene');
    const scratchDir = await scratch();
    const { service, calls } = serviceFor(scratchDir);
    const dir = join(scratchDir, 'mirror');
    await service.lsRemote({ url: src.url, credential });
    await service.mirror({ url: src.url, credential, dir });
    await service.fetchLfs({ dir, url: src.url, credential });
    await service.pushLfs({ dir, url: dst.url, credential });
    await service.pushRefs({ dir, url: dst.url, credential, defaultBranch: 'main' });

    expect(calls.length).toBeGreaterThan(5);
    for (const call of calls) {
      expect(call.args.join('\0')).not.toContain(TOKEN);
      expect(call.args.join('\0')).not.toContain(
        Buffer.from(`${USER}:${TOKEN}`).toString('base64'),
      );
      for (const value of Object.values(call.env)) expect(value).not.toContain(TOKEN);
      expect(call.args.join(' ')).not.toMatch(/https?:\/\/[^/\s]*@/);
    }
    const remoteCalls = calls.filter((call) => call.env.GIT_ASKPASS !== undefined);
    expect(remoteCalls.length).toBeGreaterThan(5);
    // Commands without a credential session are local ones.
    for (const call of calls.filter((c) => c.env.GIT_ASKPASS === undefined)) {
      expect(['count-objects', 'lfs', 'for-each-ref', 'cat-file', 'rev-list', 'version']).toContain(
        call.args[0],
      );
    }
    // The credential file is private while commands run.
    expect(new Set(remoteCalls.map((call) => call.credentialMode))).toEqual(new Set([0o600]));
    for (const call of remoteCalls) {
      expect(call.env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(configOf(call)['credential.helper']).toBe('');
      expect(configOf(call)['http.lowSpeedTime']).toBe('60');
    }
    // Nothing on disk holds the credential.
    for (const file of filesUnder(scratchDir)) {
      const bytes = readFileSync(file);
      expect(bytes.includes(TOKEN), file).toBe(false);
    }
    expect(readFileSync(join(dir, 'config'), 'utf8')).not.toMatch(/@|token|password/i);
    expect(await readdir(scratchDir)).not.toContainEqual(expect.stringContaining('askpass'));
  });

  it('[LIF-040] mirrors every branch and tag, and a second call updates the existing mirror', async () => {
    const src = await source('mirror', {
      commits: 3,
      branches: [{ name: 'dev', commits: 2 }],
      tags: [{ name: 'v1', annotated: true }, { name: 'v0' }],
    });
    const scratchDir = await scratch();
    const { service, quota } = serviceFor(scratchDir);
    const dir = join(scratchDir, 'm');
    const first = await service.mirror({ url: src.url, credential, dir });
    expect(first.updated).toBe(false);
    expect(first.sizeBytes).toBeGreaterThan(0);
    const again = await service.mirror({ url: src.url, credential, dir });
    expect(again.updated).toBe(true);
    expect(quota.units).toEqual([3, 3]);
    const scan = await service.scanBlobs({ dir });
    expect(scan.blockers).toEqual([]);
    // The mirror holds exactly the source refs.
    const target2 = await target('mirror-copy');
    const report = await service.pushRefs({
      dir,
      url: target2.url,
      credential,
      defaultBranch: 'main',
    });
    expect(report.pushes.length).toBeGreaterThan(0);
    const check = await service.lsRemote({ url: target2.url, credential });
    expect(Object.fromEntries(check.refs.map((r) => [r.name, r.sha]))).toEqual({
      'refs/heads/main': src.seeded.heads.main,
      'refs/heads/dev': src.seeded.heads.dev,
      'refs/tags/v0': src.seeded.tags.v0,
      'refs/tags/v1': src.seeded.tags.v1,
    });
  });

  it('[FAC-GIT-004] blobs over maxBlobBytes are blockers with path and size, blobs over the warning size are warnings, LFS content is ignored', async () => {
    const src = await source('blobs', {
      commits: 1,
      bigBlobs: [
        { path: 'data/huge.bin', bytes: 60 * KIB },
        { path: 'data/medium.bin', bytes: 30 * KIB },
        { path: 'small.txt', content: 'tiny' },
      ],
      lfsFiles: [{ path: 'lfs/video.bin', bytes: 200 * KIB }],
    });
    const scratchDir = await scratch();
    const { service } = serviceFor(scratchDir);
    const dir = join(scratchDir, 'm');
    await service.mirror({ url: src.url, credential, dir });
    const scan = await service.scanBlobs({
      dir,
      maxBlobBytes: 50 * KIB,
      warnBlobBytes: 20 * KIB,
    });
    expect(
      scan.blockers.map((b) => [b.code, b.params.path, b.params.size, b.params.limit]),
    ).toEqual([['git-refs.blob-too-large', 'data/huge.bin', 60 * KIB, 50 * KIB]]);
    expect(scan.warnings.map((b) => [b.code, b.params.path, b.params.size])).toEqual([
      ['git-refs.blob-large', 'data/medium.bin', 30 * KIB],
    ]);
    expect(scan.largestBlobBytes).toBe(60 * KIB);
    // Without a target limit there are no blockers.
    const open = await service.scanBlobs({ dir, warnBlobBytes: 20 * KIB });
    expect(open.blockers).toEqual([]);
    expect(open.warnings).toHaveLength(2);
  });
});

describe('LFS', () => {
  it('[FAC-GIT-005] fetches every LFS object from the source, pushes them to the target and finds them through the batch API', async () => {
    const src = await source('lfs', {
      commits: 2,
      lfsFiles: [
        { path: 'a.bin', bytes: 4 * KIB },
        { path: 'b.bin', bytes: 9 * KIB },
      ],
    });
    const dst = await target('lfs');
    const scratchDir = await scratch();
    const { service, quota, calls } = serviceFor(scratchDir);
    const dir = join(scratchDir, 'm');
    await service.mirror({ url: src.url, credential, dir });

    const before = await service.listLfsObjects(dir);
    expect(before.map((o) => o.oid).sort()).toEqual(
      Object.values(src.seeded.lfs)
        .map((o) => o.oid)
        .sort(),
    );
    expect(before.every((o) => !o.downloaded)).toBe(true);
    expect(before.reduce((n, o) => n + o.size, 0)).toBe(13 * KIB);

    const fetched = await service.fetchLfs({ dir, url: src.url, credential });
    expect(fetched).toEqual({ objects: 2, units: 1 });
    const fetchCall = calls.find((c) => c.args[0] === 'lfs' && c.args[1] === 'fetch');
    const config = configOf(fetchCall);
    expect(config['lfs.url']).toBe(`${src.url}/info/lfs`);
    expect(config[`lfs.${src.url}/info/lfs.locksverify`]).toBe('false');
    expect(config['remote.origin.lfsurl']).toBe(`${src.url}/info/lfs`);
    expect(config['lfs.concurrenttransfers']).toBe('8');
    expect(config['remote.origin.url']).toBe(src.url);
    const after = await service.listLfsObjects(dir);
    expect(after.every((o) => o.downloaded)).toBe(true);
    // Nothing left to download: no command, no quota.
    quota.units.length = 0;
    expect(await service.fetchLfs({ dir, url: src.url, credential })).toEqual({
      objects: 0,
      units: 0,
    });
    expect(quota.units).toEqual([]);

    // Not on the target yet.
    const batch = batchClient(dst.url);
    const missingBefore = await verifyLfsParity(batch, before);
    expect([...missingBefore.missing].sort()).toEqual(before.map((o) => o.oid).sort());

    const pushed = await service.pushLfs({ dir, url: dst.url, credential });
    expect(pushed).toEqual({ objects: 2, units: 1 });
    for (const object of before) {
      expect(await server.lfsStore('target').size(dst.repo, object.oid)).toBe(object.size);
    }
    const parity = await verifyLfsParity(batch, before);
    expect(parity).toEqual({ checked: 2, missing: [], failed: [] });
  });

  it('[JOB-041] LFS transfers cost one quota unit per 100 objects', async () => {
    const files = Array.from({ length: 101 }, (_, i) => ({
      path: `f${i}.bin`,
      content: `object ${i}`,
    }));
    const src = await source('lfs-many', { commits: 1, lfsFiles: files });
    const dst = await target('lfs-many');
    const scratchDir = await scratch();
    const { service, quota } = serviceFor(scratchDir);
    const dir = join(scratchDir, 'm');
    await service.mirror({ url: src.url, credential, dir });
    quota.units.length = 0;
    expect(await service.fetchLfs({ dir, url: src.url, credential })).toEqual({
      objects: 101,
      units: 2,
    });
    expect(await service.pushLfs({ dir, url: dst.url, credential })).toEqual({
      objects: 101,
      units: 2,
    });
    expect(quota.units).toEqual([2, 2]);
    const parity = await verifyLfsParity(batchClient(dst.url), await service.listLfsObjects(dir));
    expect(parity.missing).toEqual([]);
    expect(parity.checked).toBe(101);
  });
});

/** An LFS batch client for the fake target, standing in for the adapter's ProviderHttpClient. */
function batchClient(repoUrl: string): LfsBatchClient {
  return {
    async download(objects) {
      const response = await fetch(`${repoUrl}/info/lfs/objects/batch`, {
        method: 'POST',
        headers: {
          'content-type': 'application/vnd.git-lfs+json',
          accept: 'application/vnd.git-lfs+json',
          authorization: `Basic ${Buffer.from(`${USER}:${TOKEN}`).toString('base64')}`,
        },
        body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { objects: never[] }).objects;
    },
  };
}

describe('batched push', () => {
  const BYTES_PER_COMMIT = 40 * KIB;

  async function pushHistory(
    name: string,
    options: Partial<GitServiceOptions>,
    targetLimit: number | null,
  ) {
    const src = await source(name, {
      commits: 12,
      bytesPerCommit: BYTES_PER_COMMIT,
      branches: [{ name: 'dev', commits: 2 }, { name: 'topic' }],
      tags: [{ name: 'v1', annotated: true }, { name: 'v2' }],
    });
    const dst = await target(name);
    server.setLimits('target', { maxPushBytes: targetLimit });
    const scratchDir = await scratch();
    const { service, quota, calls } = serviceFor(scratchDir, options);
    const dir = join(scratchDir, 'm');
    await service.mirror({ url: src.url, credential, dir });
    return { src, dst, service, quota, calls, dir };
  }

  it('[LIF-044] pushes the default branch in checkpoints that respect a small maxPushBytes, then branches, then tags', async () => {
    const maxPushBytes = 120 * KIB;
    const t = await pushHistory('batched', { maxPushBytes }, 160 * KIB);
    const events: string[] = [];
    const report = await t.service.pushRefs({
      dir: t.dir,
      url: t.dst.url,
      credential,
      defaultBranch: 'main',
      onPush: (event) => events.push(event.kind),
    });
    const kinds = report.pushes.map((p) => p.kind);
    expect(events).toEqual(kinds);
    const defaultPushes = report.pushes.filter((p) => p.kind === 'default-branch');
    // 12 commits of 40 KiB with a 120 KiB cap: at least four checkpoints.
    expect(defaultPushes.length).toBeGreaterThanOrEqual(4);
    for (const push of report.pushes) expect(push.estimatedBytes).toBeLessThanOrEqual(maxPushBytes);
    // Order: default branch checkpoints, then branch groups, then tags.
    const firstBranch = kinds.indexOf('branches');
    const firstTag = kinds.indexOf('tags');
    expect(kinds.lastIndexOf('default-branch')).toBeLessThan(firstBranch);
    expect(firstBranch).toBeLessThan(firstTag);
    const remote = await t.service.lsRemote({ url: t.dst.url, credential });
    expect(Object.fromEntries(remote.refs.map((r) => [r.name, r.sha]))).toEqual({
      'refs/heads/main': t.src.seeded.heads.main,
      'refs/heads/dev': t.src.seeded.heads.dev,
      'refs/heads/topic': t.src.seeded.heads.topic,
      'refs/tags/v1': t.src.seeded.tags.v1,
      'refs/tags/v2': t.src.seeded.tags.v2,
    });
    // Every push costs 3 units (plus 1 for the target ls-remote and 3 for the clone).
    const pushUnits = t.quota.units.slice(2, 2 + report.pushes.length);
    expect(pushUnits).toEqual(report.pushes.map(() => 3));
    expect(t.calls.filter((c) => c.args.includes('push'))).toHaveLength(
      report.pushes.reduce((n, p) => n + p.attempts, 0),
    );
    // push.followTags is off and nothing is atomic across groups.
    for (const call of t.calls.filter((c) => c.args.includes('push'))) {
      expect(call.args).toContain('push.followTags=false');
      expect(call.args).not.toContain('--atomic');
      expect(call.args).not.toContain('--mirror');
    }
  });

  it('[LIF-044] the pack-objects estimator batches the same way', async () => {
    const t = await pushHistory(
      'batched-po',
      { maxPushBytes: 120 * KIB, estimator: 'pack-objects' },
      160 * KIB,
    );
    const report = await t.service.pushRefs({
      dir: t.dir,
      url: t.dst.url,
      credential,
      defaultBranch: 'main',
    });
    expect(report.pushes.filter((p) => p.kind === 'default-branch').length).toBeGreaterThanOrEqual(
      4,
    );
    for (const push of report.pushes) expect(push.estimatedBytes).toBeLessThanOrEqual(120 * KIB);
    const remote = await t.service.lsRemote({ url: t.dst.url, credential });
    expect(remote.refs.find((r) => r.name === 'refs/heads/main')?.sha).toBe(
      t.src.seeded.heads.main,
    );
  });

  it('[LIF-044] a second push of an unchanged mirror sends nothing', async () => {
    const t = await pushHistory('batched-twice', { maxPushBytes: 120 * KIB }, null);
    await t.service.pushRefs({ dir: t.dir, url: t.dst.url, credential, defaultBranch: 'main' });
    const again = await t.service.pushRefs({
      dir: t.dir,
      url: t.dst.url,
      credential,
      defaultBranch: 'main',
    });
    expect(again.pushes).toEqual([]);
    expect(again.upToDate).toHaveLength(5);
  });

  it('[LIF-044] without a small limit the default branch goes in one push', async () => {
    const t = await pushHistory('batched-one', {}, null);
    const report = await t.service.pushRefs({
      dir: t.dir,
      url: t.dst.url,
      credential,
      defaultBranch: 'main',
    });
    expect(report.pushes.filter((p) => p.kind === 'default-branch')).toHaveLength(1);
  });

  it('[LIF-042] a single commit above the limit is pushed alone and a provider rejection is push-too-large without retries', async () => {
    const src = await source('too-large', { commits: 2, bytesPerCommit: 80 * KIB });
    const dst = await target('too-large');
    server.setLimits('target', { maxPushBytes: 50 * KIB });
    const scratchDir = await scratch();
    const { service, calls } = serviceFor(scratchDir, { maxPushBytes: 30 * KIB });
    const dir = join(scratchDir, 'm');
    await service.mirror({ url: src.url, credential, dir });
    const error = await service
      .pushRefs({ dir, url: dst.url, credential, defaultBranch: 'main' })
      .catch((e: unknown) => e);
    expect(isGitCommandError(error)).toBe(true);
    expect((error as { reason: string }).reason).toBe('push-too-large');
    expect((error as { code: string }).code).toBe('blocked_by_provider');
    expect(calls.filter((c) => c.args.includes('push'))).toHaveLength(1);
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });

  it('[LIF-044] a failed push is retried up to three times with jittered exponential backoff', async () => {
    const src = await source('retry', { commits: 2 });
    const dst = await target('retry');
    server.setLimits('target', { maxPushBytes: null });
    const scratchDir = await scratch();
    const calls: Call[] = [];
    let failures = 2;
    const delays: number[] = [];
    const quota = recordingQuota();
    const service = new GitService({
      quota,
      scratchDir,
      random: () => 0.5,
      backoffBaseMs: 1000,
      sleep: async (ms) => {
        delays.push(ms);
      },
      spawn: recordingSpawn(calls, (args) => {
        if (args.includes('push') && failures > 0) {
          failures--;
          return ['-c', 'echo "error: RPC failed; HTTP 503 curl 22" >&2; exit 1'];
        }
        return undefined;
      }),
    });
    const dir = join(scratchDir, 'm');
    await service.mirror({ url: src.url, credential, dir });
    const report = await service.pushRefs({ dir, url: dst.url, credential, defaultBranch: 'main' });
    expect(report.pushes[0]?.attempts).toBe(3);
    expect(delays).toEqual([500, 1000]);
    // clone 3, target ls-remote 1, then 3 units for each of the 3 push attempts.
    expect(quota.units).toEqual([3, 1, 3, 3, 3]);

    // A permanent failure is not retried, and after three retries the error surfaces.
    const dst2 = await target('retry-2');
    failures = 10;
    delays.length = 0;
    const error = await service
      .pushRefs({ dir, url: dst2.url, credential, defaultBranch: 'main' })
      .catch((e: unknown) => e);
    expect(isGitCommandError(error)).toBe(true);
    expect(delays).toEqual([500, 1000, 2000]);
    expect(calls.filter((c) => c.args.includes('push')).length).toBe(3 + 4);
  });

  it('[LIF-043] deleteRefs removes refs on the target', async () => {
    const t = await pushHistory('delete', {}, null);
    await t.service.pushRefs({ dir: t.dir, url: t.dst.url, credential, defaultBranch: 'main' });
    await t.service.deleteRefs({
      dir: t.dir,
      url: t.dst.url,
      credential,
      refs: ['refs/heads/topic', 'refs/tags/v2'],
    });
    const remote = await t.service.lsRemote({ url: t.dst.url, credential });
    expect(remote.refs.map((r) => r.name)).not.toContain('refs/heads/topic');
    expect(remote.refs.map((r) => r.name)).not.toContain('refs/tags/v2');
    expect(remote.refs.map((r) => r.name)).toContain('refs/heads/dev');
  });

  it('[LIF-044] pushing an empty mirror does nothing', async () => {
    const src = await source('empty-src', { commits: 1 });
    const dst = await target('empty-dst');
    const scratchDir = await scratch();
    const { service } = serviceFor(scratchDir);
    const dir = join(scratchDir, 'm');
    await service.mirror({ url: src.url, credential, dir });
    // A mirror without branches or tags.
    await rm(join(dir, 'packed-refs'), { force: true });
    await rm(join(dir, 'refs'), { recursive: true, force: true });
    await mkdir(join(dir, 'refs', 'heads'), { recursive: true });
    expect(
      await service.pushRefs({ dir, url: dst.url, credential, defaultBranch: 'main' }),
    ).toEqual({
      pushes: [],
      upToDate: [],
    });
  });
});

describe('push rejections', () => {
  it('[LIF-044] a diverged ref is a non-retryable conflict naming the ref, after exactly one attempt, with no token in the error or the logs', async () => {
    const src = await source('diverged', { commits: 3 });
    const dst = await target('diverged');
    await seedBareRepo(server.repoDir('target', dst.repo), { commits: 2, bytesPerCommit: 10 });
    server.setLimits('target', { maxPushBytes: null });
    const scratchDir = await scratch();
    const logger = capturingLogger();
    const delays: number[] = [];
    const { service, calls } = serviceFor(scratchDir, {
      logger,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    const dir = join(scratchDir, 'm');
    await service.mirror({ url: src.url, credential, dir });
    const error = await service
      .pushRefs({ dir, url: dst.url, credential, defaultBranch: 'main' })
      .catch((e: unknown) => e);
    expect(isGitCommandError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'conflict', reason: 'rejected', retryable: false });
    expect((error as Error).message).toContain('refs/heads/main');
    expect((error as Error).message).toContain('[rejected]');
    expect(calls.filter((c) => c.args.includes('push'))).toHaveLength(1);
    expect(delays).toEqual([]);
    const everything =
      JSON.stringify(logger.records) + (error as Error).message + String((error as Error).stack);
    expect(everything).not.toContain(TOKEN);
    expect(logger.records.length).toBeGreaterThan(0);
    // Forcing overwrites the diverged ref (the adoptNonEmpty reconcile).
    await service.pushRefs({ dir, url: dst.url, credential, defaultBranch: 'main', force: true });
    const remote = await service.lsRemote({ url: dst.url, credential });
    expect(remote.refs.find((r) => r.name === 'refs/heads/main')?.sha).toBe(src.seeded.heads.main);
  });

  it('[LIF-043] deleteRefs accepts only plain branch and tag names and never touches framework branches', async () => {
    const { service } = serviceFor(await scratch());
    const base = { dir: work, url: 'http://127.0.0.1:9/x.git', credential };
    for (const ref of [
      'main',
      'refs/heads/*',
      'refs/heads/a:b',
      '+refs/heads/main',
      'refs/heads/git-migrator/codeowners',
      'refs/pull/1/head',
      'refs/heads/../x',
      'refs/heads/',
      'refs/tags/v1.lock',
      'refs/heads/a b',
    ]) {
      const error = await service
        .deleteRefs({ ...base, refs: ['refs/heads/ok', ref] })
        .catch((e: unknown) => e);
      expect(error, ref).toMatchObject({ code: 'invalid' });
    }
  });
});

describe('LFS endpoint pinning', () => {
  it('[FAC-GIT-005] a .lfsconfig in the repository cannot redirect LFS fetch or push to another repository', async () => {
    const other = await target('lfs-other');
    const dst = await target('lfs-hostile-dst');
    const hostile = (url: string) => `[lfs]\n\turl = ${url}/info/lfs\n`;
    const src = await source('lfs-hostile', {
      commits: 1,
      lfsFiles: [{ path: 'a.bin', bytes: 3 * KIB }],
      bigBlobs: [{ path: '.lfsconfig', content: hostile(other.url) }],
    });
    const scratchDir = await scratch();
    const { service } = serviceFor(scratchDir);
    const dir = join(scratchDir, 'm');
    await service.mirror({ url: src.url, credential, dir });
    const [object] = await service.listLfsObjects(dir);
    expect(object).toBeDefined();

    // Fetch comes from the source, not from the repository the file names.
    await service.fetchLfs({ dir, url: src.url, credential });
    expect((await service.listLfsObjects(dir))[0]?.downloaded).toBe(true);

    // Push lands in the intended target only.
    await service.pushLfs({ dir, url: dst.url, credential });
    const oid = (object as { oid: string }).oid;
    expect(await server.lfsStore('target').size(dst.repo, oid)).toBe(3 * KIB);
    expect(await server.lfsStore('target').size(other.repo, oid)).toBeUndefined();
  });
});

describe('stalled remotes', () => {
  let silent: Server;
  let silentPort: number;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    silent = createServer((socket) => {
      // accept the connection and never answer
      sockets.add(socket);
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    silentPort = (silent.address() as { port: number }).port;
  });
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => silent.close(resolve));
  });

  it('[ADP-060] a remote that stops answering is killed after the inactivity limit as a retryable transient error and leaves no process', async () => {
    const pids: number[] = [];
    const calls: Call[] = [];
    const inner = recordingSpawn(calls);
    const quota = recordingQuota();
    const service = new GitService({
      quota,
      scratchDir: await scratch(),
      stallTimeoutMs: 600,
      spawn: (command, args, options) => {
        const child = inner(command, args, options);
        if (child.pid !== undefined) pids.push(child.pid);
        return child;
      },
    });
    const started = Date.now();
    const error = await service
      .lsRemote({ url: `http://127.0.0.1:${silentPort}/stall.git`, credential })
      .catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(isGitCommandError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'transient', retryable: true });
    expect((error as Error).message).toContain('stalled');
    expect(pids.length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const pid of pids) {
      // The whole group is gone too (git-remote-http).
      expect(liveGroupMembers(pid), `group ${pid}`).toEqual([]);
    }
    const config = configOf(calls[0]);
    expect(config['http.lowSpeedLimit']).toBe('1000');
    expect(config['lfs.activitytimeout']).toBeDefined();
  });

  it('[ADP-060] aborting a stalled ls-remote kills the helpers and reports a non-retryable cancelled error', async () => {
    const pids: number[] = [];
    const inner = recordingSpawn([]);
    const service = new GitService({
      quota: recordingQuota(),
      scratchDir: await scratch(),
      spawn: (command, args, options) => {
        const child = inner(command, args, options);
        if (child.pid !== undefined) pids.push(child.pid);
        return child;
      },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const error = await service
      .lsRemote({
        url: `http://127.0.0.1:${silentPort}/abort.git`,
        credential,
        signal: controller.signal,
      })
      .catch((e: unknown) => e);
    expect(isGitCommandError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'transient', reason: 'cancelled', retryable: false });
    expect((error as Error).name).not.toBe('AbortError');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) expect(liveGroupMembers(pid), `group ${pid}`).toEqual([]);
  });

  it('[ADP-060] aborting a stalled push kills its process group and is not retried', async () => {
    const src = await source('abort-push', { commits: 2 });
    const dst = await target('abort-push');
    server.setLimits('target', { maxPushBytes: null });
    const scratchDir = await scratch();
    const pids: number[] = [];
    const delays: number[] = [];
    const calls: Call[] = [];
    const inner = recordingSpawn(calls, (args) =>
      args.includes('push') ? ['-c', 'sleep 30 & sleep 30'] : undefined,
    );
    const service = new GitService({
      quota: recordingQuota(),
      scratchDir,
      sleep: async (ms) => {
        delays.push(ms);
      },
      spawn: (command, args, options) => {
        const child = inner(command, args, options);
        if (args.includes('push') && child.pid !== undefined) pids.push(child.pid);
        return child;
      },
    });
    const dir = join(scratchDir, 'm');
    await service.mirror({ url: src.url, credential, dir });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 700);
    const error = await service
      .pushRefs({
        dir,
        url: dst.url,
        credential,
        defaultBranch: 'main',
        signal: controller.signal,
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: 'cancelled', retryable: false });
    expect(delays).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pids).toHaveLength(1);
    expect(liveGroupMembers(pids[0] as number)).toEqual([]);
  });
});

describe('URL normalisation', () => {
  it('[ADP-071] a URL with an upper-case host still gets its credential from askpass', async () => {
    const src = await source('upper', { commits: 1 });
    const { service } = serviceFor(await scratch());
    const upper = src.url.replace('127.0.0.1', 'LOCALHOST');
    const result = await service.lsRemote({ url: upper, credential });
    expect(result.refs.map((r) => r.name)).toContain('refs/heads/main');
  });
});

describe('multi-byte ref names', () => {
  it('[LIF-044] a thousand and a half non-ASCII branch names reach the target intact', async () => {
    const names = Array.from(
      { length: 1500 },
      (_, i) =>
        `\u65e5\u672c\u8a9e/\u30d6\u30e9\u30f3\u30c1-${String(i).padStart(4, '0')}-${'\u65e5\u672c\u8a9e'.repeat(8)}`,
    );
    const src = await source('utf8', {
      commits: 1,
      branches: names.map((name) => ({ name })),
    });
    const dst = await target('utf8');
    server.setLimits('target', { maxPushBytes: null });
    const scratchDir = await scratch();
    const { service } = serviceFor(scratchDir);
    const dir = join(scratchDir, 'm');
    await service.mirror({ url: src.url, credential, dir });
    const report = await service.pushRefs({ dir, url: dst.url, credential, defaultBranch: 'main' });
    expect(report.pushes.filter((p) => p.kind === 'branches')).toHaveLength(30);
    const remote = await service.lsRemote({ url: dst.url, credential });
    const sent = remote.refs.map((r) => r.name).filter((n) => n.startsWith('refs/heads/'));
    expect(JSON.stringify(sent)).not.toContain('\ufffd');
    expect(sent.sort()).toEqual(['refs/heads/main', ...names.map((n) => `refs/heads/${n}`)].sort());
    const byName = (a: [string, string], b: [string, string]) => (a[0] < b[0] ? -1 : 1);
    const expected = Object.entries(src.seeded.heads).sort(byName);
    expect(
      remote.refs
        .filter((r) => r.name.startsWith('refs/heads/'))
        .map((r): [string, string] => [r.name.slice(11), r.sha])
        .sort(byName),
    ).toEqual(expected);
  }, 120_000);
});

describe('LFS incomplete pushes', () => {
  it('[FAC-GIT-005] a .lfsconfig cannot allow an incomplete push: a missing local object fails the push', async () => {
    const dst = await target('lfs-incomplete-dst');
    const src = await source('lfs-incomplete', {
      commits: 1,
      lfsFiles: [{ path: 'a.bin', bytes: 2 * KIB }],
      bigBlobs: [{ path: '.lfsconfig', content: '[lfs]\n\tallowincompletepush = true\n' }],
    });
    const scratchDir = await scratch();
    const { service, calls } = serviceFor(scratchDir);
    const dir = join(scratchDir, 'm');
    await service.mirror({ url: src.url, credential, dir });
    // The object was never fetched, so the mirror cannot supply it.
    const error = await service.pushLfs({ dir, url: dst.url, credential }).catch((e: unknown) => e);
    expect(isGitCommandError(error)).toBe(true);
    const push = calls.find((c) => c.args[0] === 'lfs' && c.args[1] === 'push');
    expect(configOf(push)['lfs.allowincompletepush']).toBe('false');
  });
});
