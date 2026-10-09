/**
 * T-096, TST-020: the whole system for the additional scenarios, composed as the processes compose
 * it (ADR-0475): `runMigrate` and `runSeed` over a throw-away database, the web process's API
 * (`buildApiRuntime`, real Better Auth with test sign-in) and the worker (`startWorker`, every queue
 * handler), configured from one YAML file and environment, against the TST-012 fakes (TST-006).
 * `phase1.test.ts` keeps its own copy of this set-up; this module serves the scenarios that follow it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@git-migrator/config';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import {
  resetWorld,
  startWorldFakes,
  WORLD_ORG,
  WORLD_ROUTE,
  WORLD_WORKSPACE,
} from '@git-migrator/fixtures';
import { QUEUE_NAMES, type QueueName } from '@git-migrator/jobs';
import { createLogger } from '@git-migrator/observability';
import type { RunningFakes } from '@git-migrator/provider-fakes';
import { type ApiRuntime, buildApiRuntime } from '@git-migrator/web/server/api';
import { runMigrate, runSeed } from '@git-migrator/worker/db-commands';
import { startWorker, type WorkerHandle } from '@git-migrator/worker/worker';
import { expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const PEM = readFileSync(join(here, '../../fixtures/fake-github-app.pem'), 'utf8');

export const SOURCE = 'bb-src';
export const TARGET = 'gh-dst';
export const ROUTE = 'r-auto';
export const ORIGIN = 'http://localhost:3000';
export const OPERATOR = 'operator@test.local';
const PASSWORD = 'scenario-test-password';
const AUTH_SECRET = 'scenario-better-auth-secret-0123456789abcdef';

/** Queues whose work a scenario waits for; `maintenance` carries only schedules and stays busy. */
const WORK_QUEUES: readonly QueueName[] = QUEUE_NAMES.filter((q) => q !== 'maintenance');

export async function until<T>(
  what: string,
  check: () => Promise<T | false | undefined> | T | false | undefined,
  ms = 90_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== false && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export interface MigrationRow {
  id: string;
  status: string;
  readiness: string | null;
}

export interface Stack {
  readonly fakes: RunningFakes;
  readonly db: TestDatabase['db'];
  readonly api: ApiRuntime;
  readonly worker: WorkerHandle;
  /** A request to the API app as the signed-in browser sends it. */
  call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }>;
  /** A GET whose body is not read: the event stream (JOB-060). */
  open(path: string, signal: AbortSignal): Promise<Response>;
  /** A read through the Model API (`/api/model`). */
  model<T>(name: string, op: string, args: unknown): Promise<T>;
  /** Waits until no work queue holds a job that is waiting, running or retrying. */
  idle(what: string): Promise<void>;
  /** Refreshes the inventory and analyzes every Migration, as phase 1 does (steps 2 and 3). */
  prepare(): Promise<void>;
  /** The Migration of a repository, by its source key (`plat/with-secrets`). */
  migrationOf(repositoryKey: string): Promise<MigrationRow>;
  /** Starts a Run through the API and waits for it to finish. */
  runAndWait(migrationId: string, kind: string): Promise<{ runId: string; status: string }>;
  close(): Promise<void>;
}

type Disposer = () => Promise<void> | void;

/**
 * Starts the stack. Each resource registers its disposer as soon as it exists; a failure part-way
 * unwinds what was started, in reverse, and `close()` runs every disposer even when one throws and
 * rethrows the first error at the end.
 */
export async function startStack(prefix: string): Promise<Stack> {
  const disposers: Disposer[] = [];
  const unwind = async (): Promise<void> => {
    let first: unknown;
    let failed = false;
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        await dispose();
      } catch (error) {
        if (!failed) {
          failed = true;
          first = error;
        }
      }
    }
    if (failed) throw first;
  };
  try {
    const stack = await build(prefix, disposers);
    return { ...stack, close: unwind };
  } catch (error) {
    await unwind().catch(() => undefined);
    throw error;
  }
}

async function build(prefix: string, disposers: Disposer[]): Promise<Stack> {
  const testDb = await createTestDatabase(`gm_${prefix}_`);
  disposers.push(() => testDb.drop());
  const fakes = await startWorldFakes({ bitbucketPort: 0, githubPort: 0, gitPort: 0 });
  disposers.push(() => fakes.close());
  await resetWorld(fakes);
  fakes.git?.setTokens('source', ['fake-bitbucket-api-token']);
  const gh = fakes.github;
  if (!gh) throw new Error('the fake GitHub did not start');
  const limits = await fakes.bitbucket.app.request('/__config', {
    method: 'POST',
    body: JSON.stringify({
      limits: {
        'repository-data': null,
        'raw-files': null,
        webhooks: null,
        'app-properties': null,
      },
    }),
  });
  expect(limits.status, 'the fake Bitbucket accepted the limits').toBeLessThan(300);
  gh.state.config = {
    ...gh.state.config,
    secondary: { contentCreationPerMinute: null, contentCreationPerHour: null },
    primary: { limits: { core: 10_000_000, graphql: 10_000_000 } },
  };

  const root = mkdtempSync(join(tmpdir(), `gm-${prefix}-`));
  disposers.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scratch'));
  const installationId = [...gh.state.installations.keys()][0] as number;
  const gitBase = fakes.git?.baseUrl ?? 'http://127.0.0.1:1';
  const configFile = join(root, 'config.yaml');
  writeFileSync(
    configFile,
    `
environment: test
publicUrl: ${ORIGIN}
auth:
  testSignIn: { enabled: true }
endpoints:
  - id: ${SOURCE}
    provider: bitbucket-cloud
    baseUrl: http://127.0.0.1:${fakes.bitbucket.port}
    gitBaseUrl: ${gitBase}/source
    options: { workspace: ${WORLD_WORKSPACE} }
    quota: { overrides: { repository-data: 1000000, raw-files: 1000000, webhooks: 1000000, git: 1000000 } }
  - id: ${TARGET}
    provider: github
    baseUrl: http://127.0.0.1:${gh.port}
    gitBaseUrl: ${gitBase}/target
    options: { org: ${WORLD_ORG}, appId: ${gh.state.ownApp.id}, installationId: ${installationId} }
    quota: { overrides: { content-minute: 100000, content-hour: 100000, core: 100000 } }
routes:
  - id: ${ROUTE}
    source: ${SOURCE}
    target: ${TARGET}
    targetNamespace: ${WORLD_ORG}
    policies:
      webhookAllowlistEnabled: true
`,
  );
  const url = new URL(testDb.connectionString);
  const env: Record<string, string> = {
    GM_ENVIRONMENT: 'test',
    GM_CONFIG_FILE: configFile,
    GM_SCRATCH_DIR: join(root, 'scratch'),
    GM_POSTGRES_HOST: url.hostname,
    GM_POSTGRES_PORT: url.port,
    GM_POSTGRES_DATABASE: testDb.name,
    GM_POSTGRES_USER: decodeURIComponent(url.username),
    GM_POSTGRES_SSLMODE: 'disable',
    POSTGRES_PASSWORD: decodeURIComponent(url.password),
    BETTER_AUTH_SECRET: AUTH_SECRET,
    GM_TEST_USER_PASSWORD: PASSWORD,
    BITBUCKET_CREDENTIALS: JSON.stringify([
      {
        id: 'operator',
        accountId: 'acct-operator',
        email: OPERATOR,
        apiToken: 'fake-bitbucket-api-token',
      },
    ]),
    GITHUB_APP_PRIVATE_KEY: PEM,
  };
  const config = loadConfig({ env });
  await runMigrate(config, env);
  await runSeed(config, env);
  for (const pattern of WORLD_ROUTE.webhookAllowlist) {
    await testDb.db.privileged.webhookAllowlistEntry.create({ data: { routeId: ROUTE, pattern } });
  }
  const log = createLogger({ level: 'silent' });
  const api = buildApiRuntime(env);
  disposers.push(() => api.close());
  const worker = await startWorker({
    config,
    env,
    role: 'all',
    log,
    healthPort: 0,
    metricsPort: false,
    leaderIntervalMs: 200,
    leaderLockName: `scenario-${prefix}`,
  });
  disposers.push(() => worker.stop());

  const signIn = await api.app.request(`${ORIGIN}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email: OPERATOR, password: PASSWORD }),
  });
  expect(signIn.status).toBe(200);
  const cookie = signIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const call: Stack['call'] = async (method, path, body) => {
    const response = await api.app.request(`${ORIGIN}${path}`, {
      method,
      headers: {
        cookie,
        origin: ORIGIN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : JSON.parse(text) };
  };
  const open: Stack['open'] = (path, signal) =>
    Promise.resolve(
      api.app.request(`${ORIGIN}${path}`, { headers: { cookie, origin: ORIGIN }, signal }),
    );
  const model: Stack['model'] = async <T>(name: string, op: string, args: unknown) => {
    const response = await call(
      'GET',
      `/api/model/${name}/${op}?q=${encodeURIComponent(JSON.stringify(args))}`,
    );
    expect(response.status, `${name}/${op}`).toBe(200);
    return (response.body as { data: T }).data;
  };

  /**
   * True while a job is waiting, running, or delayed for a retry on a work queue. A failed attempt
   * waits out its backoff as `delayed` (JOB-013); a scheduler's next occurrence is not work.
   */
  async function busy(): Promise<boolean> {
    for (const name of WORK_QUEUES) {
      const queue = worker.runtime.queue(name);
      const counts = await queue.getJobCounts('waiting', 'active', 'prioritized');
      if (Object.values(counts).some((n) => n > 0)) return true;
      const delayed = await queue.getJobs(['delayed']);
      if (delayed.some((job) => job.attemptsMade > 0)) return true;
    }
    return false;
  }
  const idle: Stack['idle'] = async (what) => {
    await until(what, async () => {
      if (await busy()) return false;
      // A job that just finished may have queued the next one: look twice. This is a heuristic,
      // not a guarantee: a delayed job that never failed (a throttled or scheduled enqueue) is not
      // counted, so a scenario that waits for an effect also waits for that effect with `until`.
      await new Promise((resolve) => setTimeout(resolve, 250));
      return !(await busy());
    });
  };

  interface Listed extends MigrationRow {
    analysisStaleAt: string | null;
  }
  const listAll = () =>
    model<Listed[]>('migration', 'findMany', {
      where: { routeId: ROUTE, scope: 'repository' },
      select: { id: true, status: true, readiness: true, analysisStaleAt: true },
      take: 500,
    });

  const prepare: Stack['prepare'] = async () => {
    const refresh = await call('POST', '/api/v1/inventory/refresh');
    expect(refresh.status).toBe(202);
    await until('the inventory to list the repositories', async () => {
      const rows = await listAll();
      return rows.length > 0 ? rows : false;
    });
    await idle('the inventory jobs');
    await until(
      'an Analysis of every Migration',
      async () => {
        const stale = (await listAll()).filter(
          (r) =>
            r.readiness === null ||
            (r.analysisStaleAt !== null && new Date(r.analysisStaleAt).getTime() <= Date.now()),
        );
        if (stale.length === 0) return true;
        for (const row of stale) {
          expect((await call('POST', `/api/v1/migrations/${row.id}/analyze`)).status).toBe(202);
        }
        await idle('the analyses');
        return false;
      },
      180_000,
    );
  };

  const migrationOf: Stack['migrationOf'] = async (key) => {
    const slug = key.split('/')[1] as string;
    const rows = await model<MigrationRow[]>('migration', 'findMany', {
      where: { routeId: ROUTE, scope: 'repository', sourceRepository: { slug } },
      select: { id: true, status: true, readiness: true },
    });
    expect(rows, key).toHaveLength(1);
    return rows[0] as MigrationRow;
  };

  const runAndWait: Stack['runAndWait'] = async (migrationId, kind) => {
    const started = await call('POST', `/api/v1/migrations/${migrationId}/runs`, { kind });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const runId = (started.body as { runId: string }).runId;
    const run = await until(
      'the Run to finish',
      async () => {
        const found = await model<{ status: string } | null>('run', 'findUnique', {
          where: { id: runId },
          select: { status: true },
        });
        return found && !['queued', 'running'].includes(found.status) ? found : false;
      },
      240_000,
    );
    return { runId, status: run.status };
  };

  return {
    fakes,
    db: testDb.db,
    api,
    worker,
    call,
    open,
    model,
    idle,
    prepare,
    migrationOf,
    runAndWait,
    close: async () => {
      throw new Error('replaced by startStack');
    },
  };
}
