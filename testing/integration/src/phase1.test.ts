/**
 * T-075, TST-020: the Phase-1 scenario, end to end. It mirrors the human's live e2e (Q5) through the
 * same composition roots the processes use: the web process's API runtime (`buildApiRuntime`, real
 * Better Auth with test sign-in, real BullMQ-on-Postgres producer) and the worker process
 * (`startWorker` with every queue handler), both configured from one YAML file and environment.
 * Postgres is a throw-away database; Bitbucket, GitHub and git are the TST-012 fakes (TST-006).
 *
 * The steps are one ordered scenario: each `it` is a numbered step of TST-020 and reads what the
 * step before it left behind.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@git-migrator/config';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import {
  resetWorld,
  startWorldFakes,
  WORLD_ORG,
  WORLD_REPOSITORIES,
  WORLD_ROUTE,
  WORLD_WORKSPACE,
} from '@git-migrator/fixtures';
import { QUEUE_NAMES, type QueueName } from '@git-migrator/jobs';
import { createLogger } from '@git-migrator/observability';
import { isolatedGitEnv, type RunningFakes, runGit } from '@git-migrator/provider-fakes';
import { createBuiltinRegistry } from '@git-migrator/registry';
import { type ApiRuntime, buildApiRuntime } from '@git-migrator/web/server/api';
import { runMigrate, runSeed } from '@git-migrator/worker/db-commands';
import { startWorker, type WorkerHandle } from '@git-migrator/worker/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const PEM = readFileSync(join(here, '../../fixtures/fake-github-app.pem'), 'utf8');
const SOURCE = 'bb-src';
const TARGET = 'gh-dst';
const ROUTE = 'r-auto';
const ORIGIN = 'http://localhost:3000';
const OPERATOR = 'operator@test.local';
/** Test sign-in password and Better Auth secret: throw-away values for this process only. */
const PASSWORD = 'phase1-test-password';
const AUTH_SECRET = 'phase1-better-auth-secret-0123456789abcdef';
/** Queues whose work the scenario waits for; `maintenance` carries only schedules and stays busy. */
const WORK_QUEUES: readonly QueueName[] = QUEUE_NAMES.filter((q) => q !== 'maintenance');
const AUTO_OK = { key: 'plat/auto-ok', slug: 'auto-ok', target: `${WORLD_ORG}/plat-auto-ok` };

let fakes: RunningFakes;
let t: TestDatabase;
let api: ApiRuntime;
let worker: WorkerHandle;
let root: string;
let work: string;
let cookie = '';

const log = createLogger({ level: 'silent' });

/** The state the steps hand to each other. */
const world: { migrationId: string; runId: string; sourceDescription: string } = {
  migrationId: '',
  runId: '',
  sourceDescription: '',
};

async function until<T>(
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

/** A request to the API app, as the browser sends it: the session cookie and the app's own origin. */
async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
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
}

const enc = encodeURIComponent;

/** A read through the Model API (`/api/model`), the way the Repositories page reads. */
async function model<T>(name: string, op: string, args: unknown): Promise<T> {
  const response = await call('GET', `/api/model/${name}/${op}?q=${enc(JSON.stringify(args))}`);
  expect(response.status, `${name}/${op}`).toBe(200);
  return (response.body as { data: T }).data;
}

interface Row {
  id: string;
  status: string;
  readiness: string | null;
  analysisStaleAt: string | null;
  sourceRepository: { slug: string } | null;
}

const unmigrated = () =>
  model<Row[]>('migration', 'findMany', {
    where: {
      routeId: ROUTE,
      scope: 'repository',
      status: { notIn: ['verified', 'manually_completed'] },
    },
    select: {
      id: true,
      status: true,
      readiness: true,
      analysisStaleAt: true,
      sourceRepository: { select: { slug: true } },
    },
    orderBy: { id: 'asc' },
    take: 500,
  });

/**
 * True while a job is waiting, running, or delayed for a retry on a work queue. A job whose attempt
 * failed waits out its backoff as `delayed` (JOB-013), and an `analyze` request for its Migration
 * is deduplicated into it: not counting it let the wait end while an Analysis was still to come.
 * Other delayed jobs (a scheduler's next occurrence, a drift check spread over the day) are not
 * work this scenario waits for.
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

const idle = (what: string) =>
  until(what, async () => {
    if (await busy()) return false;
    // A job that just finished may have queued the next one: look twice.
    await new Promise((resolve) => setTimeout(resolve, 250));
    return !(await busy());
  });

/** Branches and tags of a bare repository on the fake git server, name to sha. */
async function refsOf(side: 'source' | 'target', repo: string): Promise<Record<string, string>> {
  const out = await runGit(['for-each-ref', '--format=%(objectname) %(refname)'], {
    cwd: fakes.git?.repoDir(side, repo) as string,
    env: isolatedGitEnv(work),
  });
  return Object.fromEntries(
    out.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line): [string, string] => {
        const [sha, name] = line.split(' ') as [string, string];
        return [name, sha];
      })
      .filter(([name]) => name.startsWith('refs/heads/') || name.startsWith('refs/tags/'))
      // The framework's own branches are not migrated content.
      .filter(([name]) => !name.startsWith('refs/heads/git-migrator/')),
  );
}

/** Number of LFS objects the fake git server holds for a repository on one side. */
function lfsObjects(side: 'source' | 'target', repo: string): number {
  const count = (path: string): number =>
    readdirSync(path, { withFileTypes: true }).reduce(
      (n, e) => n + (e.isDirectory() ? count(join(path, e.name)) : 1),
      0,
    );
  try {
    return count(join(fakes.git?.lfsStore(side).dir as string, repo));
  } catch {
    return 0;
  }
}

beforeAll(async () => {
  t = await createTestDatabase('gm_t075_');
  fakes = await startWorldFakes({ bitbucketPort: 0, githubPort: 0, gitPort: 0 });
  await resetWorld(fakes);
  fakes.git?.setTokens('source', ['fake-bitbucket-api-token']);
  const gh = fakes.github;
  if (!gh) throw new Error('the fake GitHub did not start');
  // One scenario migrates and re-reads a lot in one hour of the fakes' clock; the rate limits are
  // covered by their own tests.
  await fakes.bitbucket.app.request('/__config', {
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
  gh.state.config = {
    ...gh.state.config,
    secondary: { contentCreationPerMinute: null, contentCreationPerHour: null },
    primary: { limits: { core: 10_000_000, graphql: 10_000_000 } },
  };

  root = mkdtempSync(join(tmpdir(), 'gm-t075-'));
  work = join(root, 'work');
  mkdirSync(work);
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
  const url = new URL(t.connectionString);
  // What the processes get from the platform: the configuration file, the database, the secrets.
  const env: Record<string, string> = {
    GM_ENVIRONMENT: 'test',
    GM_CONFIG_FILE: configFile,
    GM_SCRATCH_DIR: join(root, 'scratch'),
    GM_POSTGRES_HOST: url.hostname,
    GM_POSTGRES_PORT: url.port,
    GM_POSTGRES_DATABASE: t.name,
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
  mkdirSync(env.GM_SCRATCH_DIR as string);
  const config = loadConfig({ env });
  // `pnpm db:migrate` and `pnpm db:seed`: schemas, Better Auth, the queue schema, config sync, then
  // the seeded Actors and their test sign-in users.
  await runMigrate(config, env);
  await runSeed(config, env);
  // The Route's webhook allowlist is operator data (LIF-011); the world's expectations assume it.
  for (const pattern of WORLD_ROUTE.webhookAllowlist) {
    await t.db.privileged.webhookAllowlistEntry.create({ data: { routeId: ROUTE, pattern } });
  }
  api = buildApiRuntime(env);
  worker = await startWorker({
    config,
    env,
    role: 'all',
    log,
    healthPort: 0,
    metricsPort: false,
    leaderIntervalMs: 200,
    leaderLockName: 'phase1',
  });
}, 180_000);

afterAll(async () => {
  await worker?.stop();
  await api?.close();
  await fakes?.close();
  await t?.drop();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);

describe('Phase-1 scenario (TST-020)', () => {
  it('[TST-020] step 1: signs in as operator@test.local with the test sign-in form (API session)', async () => {
    // Before signing in, the API refuses (AUTH-020).
    expect((await call('GET', '/api/v1/me')).status).toBe(401);
    const response = await api.app.request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email: OPERATOR, password: PASSWORD }),
    });
    expect(response.status).toBe(200);
    cookie = response.headers
      .getSetCookie()
      .map((line) => line.split(';')[0])
      .join('; ');
    expect(cookie).toContain('session_token');
    const me = await call('GET', '/api/v1/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: OPERATOR, role: 'operator' });
  });

  it('[TST-020] step 2: POST /inventory/refresh, then waits for the inventory jobs to finish', async () => {
    const refresh = await call('POST', '/api/v1/inventory/refresh');
    expect(refresh.status).toBe(202);
    expect((refresh.body as { endpoints: string[] }).endpoints.sort()).toEqual(
      [SOURCE, TARGET].sort(),
    );
    // The refresh was an audited action of the signed-in Actor.
    expect(await t.db.privileged.auditEvent.count({ where: { action: 'inventory.refresh' } })).toBe(
      2,
    );
    await until('every fixture repository in the inventory', async () => {
      const rows = await unmigrated();
      return rows.length >= WORLD_REPOSITORIES.length ? rows : false;
    });
    await idle('the inventory jobs');
  });

  it('[TST-020] step 3: lists unmigrated Migrations with the expected readiness; plat/auto-ok is ready', async () => {
    // The background feeder analyzes in its own time; an explicit analyze is the other way to ready.
    // Until every Migration has a current Analysis: a round that ends with one still missing (its
    // job failed every attempt) asks again, instead of giving up after a fixed number of rounds.
    await until(
      'an Analysis of every Migration',
      async () => {
        const stale = (await unmigrated()).filter(
          (r) =>
            r.readiness === null ||
            (r.analysisStaleAt !== null && new Date(r.analysisStaleAt).getTime() <= Date.now()),
        );
        if (stale.length === 0) return true;
        for (const row of stale) {
          const accepted = await call('POST', `/api/v1/migrations/${row.id}/analyze`);
          expect(accepted.status).toBe(202);
        }
        await idle('the analyses');
        return false;
      },
      180_000,
    );
    const rows = await unmigrated();
    const readiness = Object.fromEntries(
      rows.map((r) => [r.sourceRepository?.slug ?? r.id, r.readiness]),
    );
    const expected = Object.fromEntries(
      WORLD_REPOSITORIES.map((r) => [r.slug, r.analysis.readiness]),
    );
    expect(readiness).toEqual(expected);
    const autoOk = rows.find((r) => r.sourceRepository?.slug === AUTO_OK.slug);
    expect(autoOk?.readiness).toBe('ready');
    expect(autoOk?.status).toBe('analyzed');
    world.migrationId = (autoOk as Row).id;
  }, 240_000);

  it('[TST-020] step 4: POST /migrations/{auto-ok}/runs {kind: migrate} and waits for the Run to finish', async () => {
    const source = fakes.bitbucket.state
      .workspace(WORLD_WORKSPACE)
      ?.repositories.find((r) => r.slug === AUTO_OK.slug);
    world.sourceDescription = source?.description ?? '';
    const started = await call('POST', `/api/v1/migrations/${world.migrationId}/runs`, {
      kind: 'migrate',
    });
    expect(started.status).toBe(202);
    world.runId = (started.body as { runId: string }).runId;
    const run = await until('the Run to finish', async () => {
      const found = await model<{ status: string } | null>('run', 'findUnique', {
        where: { id: world.runId },
        select: { status: true },
      });
      return found && !['queued', 'running'].includes(found.status) ? found : false;
    });
    expect(run.status).toBe('succeeded');
    await idle('the follow-up jobs of the Run');
  }, 240_000);

  it('[TST-020] step 5: the Run succeeded, the Migration is verified, and every written ParityResult is equal', async () => {
    const run = await model<{ status: string; error: unknown; kind: string }>('run', 'findUnique', {
      where: { id: world.runId },
    });
    expect(run).toMatchObject({ status: 'succeeded', kind: 'migrate' });
    const migration = await model<{ status: string; targetCreatedByFramework: boolean }>(
      'migration',
      'findUnique',
      { where: { id: world.migrationId } },
    );
    expect(migration.status).toBe('verified');
    expect(migration.targetCreatedByFramework).toBe(true);

    const results = await model<{ facetKey: string; status: string; diffs: unknown[] }[]>(
      'parityResult',
      'findMany',
      { where: { migrationId: world.migrationId } },
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.filter((r) => r.status !== 'equal')).toEqual([]);
    // Facets with compareMode none write no result (LIF-060).
    const facets = createBuiltinRegistry().facets;
    for (const result of results) {
      expect(facets.get(result.facetKey as never).compareMode).toBe('full');
    }
    for (const key of facets.keys()) {
      if (facets.get(key).compareMode === 'none') {
        expect(results.map((r) => r.facetKey)).not.toContain(key);
      }
    }
  });

  it('[TST-020] step 6: the fake GitHub holds the refs by SHA, the LFS objects, settings, protection, grants, deploy key, variables and environment', async () => {
    // Refs: every source branch and tag, with the same commit.
    const source = await refsOf('source', `${WORLD_WORKSPACE}/${AUTO_OK.slug}`);
    const target = await refsOf('target', AUTO_OK.target);
    expect(target).toEqual(source);
    expect(Object.keys(target)).toEqual(
      expect.arrayContaining(['refs/heads/main', 'refs/heads/develop', 'refs/tags/v1.0.0']),
    );
    // LFS: the objects of the source are in the target's store.
    const sourceLfs = lfsObjects('source', `${WORLD_WORKSPACE}/${AUTO_OK.slug}`);
    expect(sourceLfs).toBeGreaterThan(0);
    expect(lfsObjects('target', AUTO_OK.target)).toBe(sourceLfs);

    const github = fakes.github;
    const repo = github?.state.repos.get(AUTO_OK.target);
    expect(repo, 'the target repository exists').toBeDefined();
    const bitbucket = fakes.bitbucket.state
      .workspace(WORLD_WORKSPACE)
      ?.repositories.find((r) => r.slug === AUTO_OK.slug);
    // Settings: description, privacy and default branch follow the source.
    expect(repo?.description).toBe(world.sourceDescription);
    expect(repo?.private).toBe(bitbucket?.isPrivate ?? true);
    expect(repo?.defaultBranch).toBe('main');
    expect(repo?.archived).toBe(false);
    // Branch protection: the source's force-push and deletion restrictions on main.
    expect(repo?.rules).toMatchObject([
      { pattern: 'main', allowsForcePushes: false, allowsDeletions: false },
    ]);
    // Collaborators and teams: auto-ok has no grants, so none were invented.
    expect([...(repo?.collaborators.keys() ?? [])]).toEqual([]);
    for (const team of github?.state.orgs.get(WORLD_ORG)?.teams ?? []) {
      expect([...team.repos.keys()]).not.toContain(AUTO_OK.target);
    }
    // Deploy key, variables and the environment.
    expect(repo?.keys.map((k) => k.title)).toEqual(['e2e-key']);
    expect(repo?.variables.map((v) => v.name).sort()).toEqual(['E2E_VAR', 'RELEASE_CHANNEL']);
    expect(repo?.environments.map((e) => e.name)).toEqual(['production']);
  });

  it('[TST-020] [LIF-070] step 7: the source is read-only: branch restriction * present, description prefixed', async () => {
    const source = fakes.bitbucket.state
      .workspace(WORLD_WORKSPACE)
      ?.repositories.find((r) => r.slug === AUTO_OK.slug);
    const locks = source?.branchRestrictions.filter((r) => r.kind === 'push' && r.pattern === '*');
    expect(locks).toHaveLength(1);
    expect(locks?.[0]).toMatchObject({ users: [], groups: [] });
    expect(source?.description).toMatch(
      new RegExp(`^\\[MIGRATED → http://127\\.0\\.0\\.1:\\d+/target/${AUTO_OK.target}\\] `),
    );
    expect(source?.description.endsWith(world.sourceDescription)).toBe(true);
    const migration = await model<{ sourceReadOnlyApplied: boolean }>('migration', 'findUnique', {
      where: { id: world.migrationId },
    });
    expect(migration.sourceReadOnlyApplied).toBe(true);
  });

  it('[TST-020] step 8: the status shows in GET /dashboard and in the Migration list', async () => {
    const dashboard = await call('GET', '/api/v1/dashboard');
    expect(dashboard.status).toBe(200);
    const route = (
      dashboard.body as {
        routes: { routeId: string; total: number; byStatus: Record<string, number> }[];
        recentRuns: { id: string; status: string }[];
      }
    ).routes.find((r) => r.routeId === ROUTE);
    expect(route?.total).toBe(WORLD_REPOSITORIES.length);
    expect(route?.byStatus.verified).toBe(1);
    expect(
      (dashboard.body as { recentRuns: { id: string; status: string }[] }).recentRuns,
    ).toContainEqual(expect.objectContaining({ id: world.runId, status: 'succeeded' }));

    // The default (unmigrated) list no longer shows it; the verified filter does.
    const open = await unmigrated();
    expect(open).toHaveLength(WORLD_REPOSITORIES.length - 1);
    expect(open.map((r) => r.id)).not.toContain(world.migrationId);
    const verified = await model<Row[]>('migration', 'findMany', {
      where: { routeId: ROUTE, scope: 'repository', status: 'verified' },
      select: { id: true, status: true },
    });
    expect(verified.map((r) => r.id)).toEqual([world.migrationId]);
  });
});
