import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Config, resolveConfig } from '@git-migrator/config';
import { adminDatabaseUrl, createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { migrateBullmqSchema } from '@git-migrator/jobs';
import { createLogger } from '@git-migrator/observability';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrate } from './db-commands.ts';
import { waitForDatabase } from './wait-for-database.ts';
import {
  parseRole,
  runWorkerProcess,
  STARTUP_EXIT_MS,
  startWorker,
  type WorkerHandle,
} from './worker.ts';

const YAML = `
environment: test
endpoints:
  - id: bitbucket-main
    provider: bitbucket-cloud
    options: { workspace: acme }
  - id: github-main
    provider: github
    options: { org: acme-org, appId: 1, installationId: 2 }
routes:
  - id: bb-to-gh
    source: bitbucket-main
    target: github-main
    targetNamespace: acme-org
`;

let t: TestDatabase;
let config: Config;
let env: Record<string, string>;
let scratch: string;
let handles: WorkerHandle[] = [];
const log = createLogger({ level: 'silent' });

beforeAll(async () => {
  t = await createTestDatabase('gm_t028a_');
  await migrateBullmqSchema(t.connectionString);
  const url = new URL(t.connectionString);
  config = resolveConfig({
    text: YAML,
    env: {
      GM_POSTGRES_HOST: url.hostname,
      GM_POSTGRES_PORT: url.port,
      GM_POSTGRES_DATABASE: t.name,
      GM_POSTGRES_USER: decodeURIComponent(url.username),
      GM_POSTGRES_SSLMODE: 'disable',
    },
  });
  scratch = await mkdtemp(join(tmpdir(), 'gm-worker-'));
  env = {
    GM_ENVIRONMENT: 'test',
    GM_SCRATCH_DIR: scratch,
    POSTGRES_PASSWORD: decodeURIComponent(url.password),
  };
}, 120_000);

afterEach(async () => {
  await Promise.all(handles.map((h) => h.stop()));
  handles = [];
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
  await t?.drop();
}, 60_000);

const until = async (check: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

async function start(role: 'standard' | 'large' | 'all', lockName = 'worker-test') {
  const handle = await startWorker({
    config,
    env,
    role,
    log,
    healthPort: 0,
    metricsPort: false,
    leaderIntervalMs: 100,
    leaderLockName: lockName,
  });
  handles.push(handle);
  return handle;
}

describe('worker entrypoint', () => {
  it('[DEP-002] parses --role as standard, large or all, defaulting to all', () => {
    expect(parseRole([])).toBe('all');
    expect(parseRole(['--role', 'standard'])).toBe('standard');
    expect(parseRole(['--role', 'large'])).toBe('large');
    expect(() => parseRole(['--role', 'huge'])).toThrow('--role must be one of');
    expect(() => parseRole(['--role'])).toThrow('--role must be one of');
  });

  it('[DEP-030] reports ready after the queue workers start and not after stop', async () => {
    const worker = await start('standard');
    const base = `http://127.0.0.1:${worker.healthPort}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    expect(worker.queues).toHaveLength(6);
    await worker.stop();
    handles = [];
    await expect(fetch(`${base}/readyz`)).rejects.toThrow();
  }, 60_000);

  it('[ARC-023] the scheduler leader registers the job schedulers from config', async () => {
    const worker = await start('standard', 'worker-schedulers');
    expect(worker.leader?.isLeader).toBe(true);
    const inventory = await worker.runtime.queue('inventory').getJobSchedulers(0, -1);
    expect(inventory.map((s) => s.key).sort()).toEqual([
      'inventory:bitbucket-main',
      'inventory:github-main',
    ]);
    const maintenance = await worker.runtime.queue('maintenance').getJobSchedulers(0, -1);
    expect(maintenance.map((s) => s.key).sort()).toEqual([
      'analysis-feeder',
      'prune',
      'run-reaper',
    ]);
  }, 60_000);

  it('[ARC-023] of two workers exactly one leads, and the other takes over on stop', async () => {
    const first = await start('standard', 'worker-two');
    const second = await start('all', 'worker-two');
    expect([first.leader?.isLeader, second.leader?.isLeader].filter(Boolean)).toHaveLength(1);
    const leader = first.leader?.isLeader ? first : second;
    const follower = leader === first ? second : first;
    await leader.stop();
    await until(() => follower.leader?.isLeader === true);
  }, 60_000);

  it('[JOB-010] a large worker consumes only the large Run queue and does not lead', async () => {
    const worker = await start('large');
    expect(worker.queues).toEqual(['runs-large']);
    expect(worker.leader).toBeUndefined();
  }, 60_000);

  it('[JOB-046] processes maintenance.prune end to end through QuotaService.prune()', async () => {
    const worker = await start('standard', 'worker-prune');
    await t.db.pool.query(
      "INSERT INTO app.quota_event (bucket_key, pool, at) VALUES ('e:a:g', 'background', now() - interval '20 hours')",
    );
    const job = await worker.runtime.enqueue('maintenance', 'maintenance.prune', {});
    await until(async () => (await job.isCompleted()) === true);
    const result = (await worker.runtime.queue('maintenance').getJob(job.id as string))
      ?.returnvalue as { events: number };
    expect(result.events).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('[JOB-015] cleans old scratch directories at start-up', async () => {
    await mkdir(join(scratch, 'stale-run'));
    const longAgo = new Date(Date.now() - 3 * 86_400_000);
    await utimes(join(scratch, 'stale-run'), longAgo, longAgo);
    await start('large');
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(scratch, 'stale-run'))).toBe(false);
  }, 60_000);

  it('[DEP-050] serves metrics when a metrics port is given and exposes the provider environment', async () => {
    const worker = await startWorker({
      config,
      env,
      role: 'large',
      log,
      healthPort: 0,
      metricsPort: 0,
    });
    handles.push(worker);
    expect(worker.providerEnvironment.quota).toBeDefined();
    expect(worker.providerEnvironment.capture).toBeDefined();
  }, 60_000);

  it('[DEP-030] during a graceful stop /readyz is 503 and /healthz is 200 until the drain ends', async () => {
    let started = false;
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const worker = await startWorker({
      config,
      env,
      role: 'standard',
      log,
      healthPort: 0,
      metricsPort: false,
      leaderIntervalMs: 100,
      leaderLockName: 'worker-drain',
      handlers: {
        'maintenance.prune': async () => {
          started = true;
          await gate;
        },
      },
    });
    const base = `http://127.0.0.1:${worker.healthPort}`;
    await worker.runtime.enqueue('maintenance', 'maintenance.prune', {});
    await until(() => started);
    const stopping = worker.stop();
    await until(async () => (await fetch(`${base}/readyz`)).status === 503);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    finish();
    await stopping;
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
  }, 60_000);
});

describe('cold start (DEP-030, ADR-0213)', () => {
  const bareName = `gm_t028c_${Math.random().toString(16).slice(2, 10)}`;
  const adminUrl = adminDatabaseUrl();
  let bareConfig: Config;
  let bareEnv: Record<string, string>;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${bareName}"`);
    await admin.end();
    const url = new URL(adminUrl);
    bareConfig = resolveConfig({
      text: YAML,
      env: {
        GM_POSTGRES_HOST: url.hostname,
        GM_POSTGRES_PORT: url.port,
        GM_POSTGRES_DATABASE: bareName,
        GM_POSTGRES_USER: decodeURIComponent(url.username),
        GM_POSTGRES_SSLMODE: 'disable',
      },
    });
    bareEnv = { ...env, POSTGRES_PASSWORD: decodeURIComponent(url.password) };
  }, 60_000);

  afterAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${bareName}" WITH (FORCE)`);
    await admin.end();
  }, 60_000);

  const freePort = async (): Promise<number> => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise((resolve) => server.close(resolve));
    return port;
  };

  it('[DEP-030] waits for an unmigrated database, answers /healthz, and becomes ready after migrate', async () => {
    const port = await freePort();
    const starting = startWorker({
      config: bareConfig,
      env: bareEnv,
      role: 'large',
      log,
      healthPort: port,
      metricsPort: false,
      databaseWait: { initialDelayMs: 100, maxDelayMs: 200, timeoutMs: 60_000 },
    });
    const base = `http://127.0.0.1:${port}`;
    await until(async () => {
      try {
        return (await fetch(`${base}/healthz`)).status === 200;
      } catch {
        return false;
      }
    });
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    await runMigrate(bareConfig, bareEnv);
    const worker = await starting;
    handles.push(worker);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  }, 120_000);

  it('[DEP-030] gives up with one clear error when the database never gets ready', async () => {
    const url = new URL(adminUrl);
    const unreachable = resolveConfig({
      text: YAML,
      env: {
        GM_POSTGRES_HOST: url.hostname,
        GM_POSTGRES_PORT: String(await freePort()),
        GM_POSTGRES_DATABASE: bareName,
        GM_POSTGRES_USER: 'x',
        GM_POSTGRES_SSLMODE: 'disable',
      },
    });
    await expect(
      startWorker({
        config: unreachable,
        env: { ...env, POSTGRES_PASSWORD: 'secret-pw' },
        role: 'large',
        log,
        healthPort: 0,
        metricsPort: false,
        databaseWait: { initialDelayMs: 20, maxDelayMs: 40, timeoutMs: 300 },
      }),
    ).rejects.toThrow(/database is not ready: database unreachable \(ECONNREFUSED\)/);
  }, 60_000);
});

describe('wait for the database', () => {
  it('[DEP-030] reports an unmigrated schema without leaking the connection string', async () => {
    const bad = `postgresql://u:topsecret@127.0.0.1:1/none`;
    const lines: string[] = [];
    const sink = createLogger({
      level: 'debug',
      destination: { write: (line: string) => void lines.push(line) },
    });
    await expect(
      waitForDatabase({
        connectionString: bad,
        log: sink,
        timeoutMs: 200,
        initialDelayMs: 20,
        maxDelayMs: 40,
      }),
    ).rejects.toThrow('The database is not ready');
    expect(lines.join('')).not.toContain('topsecret');
  }, 30_000);

  it('[DEP-030] waits for ever in a development loop, until aborted, logging every 30 s at most', async () => {
    const lines: string[] = [];
    const sink = createLogger({
      level: 'debug',
      destination: { write: (line: string) => void lines.push(line) },
    });
    const controller = new AbortController();
    const waiting = waitForDatabase({
      connectionString: 'postgresql://u:p@127.0.0.1:1/none',
      log: sink,
      timeoutMs: 50, // ignored when indefinite
      initialDelayMs: 20,
      maxDelayMs: 40,
      indefinite: true,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    controller.abort(new Error('stop waiting'));
    await expect(waiting).rejects.toThrow('stop waiting');
    expect(lines.length).toBe(1); // one line now, the next only after 30 s
  }, 30_000);

  it('[DEP-030] SIGTERM during start-up closes what has started and rejects', async () => {
    const adminUrl = adminDatabaseUrl();
    const name = `gm_t028d_${Math.random().toString(16).slice(2, 10)}`;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    try {
      const url = new URL(adminUrl);
      const bare = resolveConfig({
        text: YAML,
        env: {
          GM_POSTGRES_HOST: url.hostname,
          GM_POSTGRES_PORT: url.port,
          GM_POSTGRES_DATABASE: name,
          GM_POSTGRES_USER: decodeURIComponent(url.username),
          GM_POSTGRES_SSLMODE: 'disable',
        },
      });
      const controller = new AbortController();
      const starting = startWorker({
        config: bare,
        env: { ...env, POSTGRES_PASSWORD: decodeURIComponent(url.password) },
        role: 'large',
        log,
        healthPort: 0,
        metricsPort: false,
        signal: controller.signal,
        databaseWait: { initialDelayMs: 100, maxDelayMs: 200, timeoutMs: 60_000 },
      });
      await new Promise((resolve) => setTimeout(resolve, 800));
      controller.abort();
      await expect(starting).rejects.toThrow();
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    }
  }, 60_000);
});

describe('worker process life cycle (DEP-030, ADR-0213)', () => {
  /** Drives `runWorkerProcess` with a fake signal source and a recorded exit. */
  function harness() {
    let listener: () => void = () => undefined;
    const exits: number[] = [];
    return {
      exits,
      sigterm: () => listener(),
      options: {
        onShutdownSignal: (fn: () => void) => {
          listener = fn;
        },
        exit: (code: number) => void exits.push(code),
        log,
      },
    };
  }

  it('[DEP-030] SIGTERM after start-up waits for the drain however long it takes, then exits 0', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { exits, sigterm, options } = harness();
      let drained = false;
      const running = runWorkerProcess({
        ...options,
        start: async () => ({
          // A Run finishing a long step: the drain takes 5 minutes.
          stop: () =>
            new Promise<void>((resolve) =>
              setTimeout(() => {
                drained = true;
                resolve();
              }, 300_000),
            ),
        }),
      });
      await running;
      sigterm();
      await vi.advanceTimersByTimeAsync(STARTUP_EXIT_MS + 1_000);
      expect(exits).toEqual([]); // no forced exit at 30 s
      await vi.advanceTimersByTimeAsync(300_000);
      expect(drained).toBe(true);
      expect(exits).toEqual([0]);
      sigterm(); // a second signal changes nothing
      await vi.advanceTimersByTimeAsync(1);
      expect(exits).toEqual([0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('[DEP-030] SIGTERM during a start-up stage that cannot be interrupted exits 1 after 30 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { exits, sigterm, options } = harness();
      void runWorkerProcess({ ...options, start: () => new Promise(() => undefined) });
      await vi.advanceTimersByTimeAsync(1);
      sigterm();
      await vi.advanceTimersByTimeAsync(STARTUP_EXIT_MS - 1);
      expect(exits).toEqual([]);
      await vi.advanceTimersByTimeAsync(2);
      expect(exits).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('[DEP-030] SIGTERM during start-up that aborts cleanly exits 0, a failed start-up exits 1', async () => {
    const aborted = harness();
    const startingAborted = runWorkerProcess({
      ...aborted.options,
      start: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    aborted.sigterm();
    await startingAborted;
    expect(aborted.exits).toEqual([0]);

    const failed = harness();
    await runWorkerProcess({
      ...failed.options,
      start: async () => {
        throw new Error('database is not ready');
      },
    });
    expect(failed.exits).toEqual([1]);
  });

  it('[DEP-030] SIGTERM to a started worker with a job running past the start-up limit drains and exits 0', async () => {
    const { exits, sigterm, options } = harness();
    let started = false;
    let finished = false;
    await runWorkerProcess({
      ...options,
      startupExitMs: 100, // far shorter than the job: it must not apply after start-up
      start: async (signal) => {
        const worker = await startWorker({
          config,
          env,
          role: 'standard',
          log,
          healthPort: 0,
          metricsPort: false,
          leaderIntervalMs: 100,
          leaderLockName: 'worker-sigterm',
          signal,
          handlers: {
            'maintenance.prune': async () => {
              started = true;
              await new Promise((resolve) => setTimeout(resolve, 1_000));
              finished = true;
            },
          },
        });
        await worker.runtime.enqueue('maintenance', 'maintenance.prune', {});
        return worker;
      },
    });
    await until(() => started);
    sigterm();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(exits).toEqual([]);
    await until(() => exits.length > 0);
    expect(finished).toBe(true);
    expect(exits).toEqual([0]);
  }, 60_000);
});
