import { type ChildProcess, spawn } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
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
import { createLogger } from '@git-migrator/observability';
import type { RunningFakes } from '@git-migrator/provider-fakes';
import { runMigrate, runSeed } from '@git-migrator/worker/db-commands';
import { startWorker, type WorkerHandle } from '@git-migrator/worker/worker';
import { TEST_PASSWORD } from './constants.ts';

/**
 * The stack the UI e2e tier runs against (TST-021): the built web app as a real process, the
 * worker, a throw-away Postgres database and the provider fakes with the TST-012 fixture world. It
 * is started once per Playwright run by `global-setup.ts`; a spec only needs the base URL.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../..');
/** Where the web and worker logs of a run go, for the CI upload on failure (ADR-0485). */
const LOG_DIR = join(repoRoot, 'testing/e2e/logs');
const PEM = readFileSync(join(repoRoot, 'testing/fixtures/fake-github-app.pem'), 'utf8');

export const SOURCE_ENDPOINT = 'bb-src';
export const TARGET_ENDPOINT = 'gh-dst';
export const ROUTE_ID = 'r-auto';
const AUTH_SECRET = 'e2e-better-auth-secret-0123456789abcdef';
const BITBUCKET_TOKEN = 'fake-bitbucket-api-token';

export interface Stack {
  readonly baseUrl: string;
  readonly fakes: RunningFakes;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url: string, child: ChildProcess, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the web process exited (${child.exitCode})`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status < 500) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Starts everything; call `stop()` to close it in reverse order and drop the database. */
export async function startStack(): Promise<Stack> {
  const stops: Array<() => Promise<void> | void> = [];
  // Every step is closed on its own and bounded, so a hung worker or process cannot keep the
  // database from being dropped or the fakes from closing.
  const stop = async () => {
    for (const close of stops.splice(0).reverse()) {
      try {
        await Promise.race([
          Promise.resolve().then(close),
          new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error('teardown step timed out')), 60_000).unref();
          }),
        ]);
      } catch {
        // keep closing the rest
      }
    }
  };
  try {
    const t: TestDatabase = await createTestDatabase('gm_t087_');
    stops.push(() => t.drop());
    const fakes = await startWorldFakes({ bitbucketPort: 0, githubPort: 0, gitPort: 0 });
    stops.push(() => fakes.close());
    await resetWorld(fakes);
    fakes.git?.setTokens('source', [BITBUCKET_TOKEN]);
    const gh = fakes.github;
    if (!gh) throw new Error('the fake GitHub did not start');
    // A flow reads a lot in one hour of the fakes' clock; the limits have their own tests.
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

    const root = mkdtempSync(join(tmpdir(), 'gm-e2e-'));
    stops.push(() => rmSync(root, { recursive: true, force: true }));
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    const webPort = await freePort();
    const baseUrl = `http://127.0.0.1:${webPort}`;
    const installationId = [...gh.state.installations.keys()][0] as number;
    const gitBase = fakes.git?.baseUrl ?? 'http://127.0.0.1:1';
    const configFile = join(root, 'config.yaml');
    writeFileSync(
      configFile,
      `
environment: test
publicUrl: ${baseUrl}
auth:
  testSignIn: { enabled: true }
endpoints:
  - id: ${SOURCE_ENDPOINT}
    provider: bitbucket-cloud
    baseUrl: http://127.0.0.1:${fakes.bitbucket.port}
    gitBaseUrl: ${gitBase}/source
    options: { workspace: ${WORLD_WORKSPACE} }
    quota: { overrides: { repository-data: 1000000, raw-files: 1000000, webhooks: 1000000, git: 1000000 } }
  - id: ${TARGET_ENDPOINT}
    provider: github
    baseUrl: http://127.0.0.1:${gh.port}
    gitBaseUrl: ${gitBase}/target
    options: { org: ${WORLD_ORG}, appId: ${gh.state.ownApp.id}, installationId: ${installationId} }
    quota: { overrides: { content-minute: 100000, content-hour: 100000, core: 100000 } }
routes:
  - id: ${ROUTE_ID}
    source: ${SOURCE_ENDPOINT}
    target: ${TARGET_ENDPOINT}
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
      GM_SCRATCH_DIR: scratch,
      GM_POSTGRES_HOST: url.hostname,
      GM_POSTGRES_PORT: url.port,
      GM_POSTGRES_DATABASE: t.name,
      GM_POSTGRES_USER: decodeURIComponent(url.username),
      GM_POSTGRES_SSLMODE: 'disable',
      POSTGRES_PASSWORD: decodeURIComponent(url.password),
      BETTER_AUTH_SECRET: AUTH_SECRET,
      GM_TEST_USER_PASSWORD: TEST_PASSWORD,
      BITBUCKET_CREDENTIALS: JSON.stringify([
        {
          id: 'operator',
          accountId: 'acct-operator',
          email: 'operator@test.local',
          apiToken: BITBUCKET_TOKEN,
        },
      ]),
      GITHUB_APP_PRIVATE_KEY: PEM,
    };
    const config = loadConfig({ env });
    await runMigrate(config, env);
    await runSeed(config, env);
    // The Route's webhook allowlist is operator data (LIF-011); the world's expectations assume it.
    for (const pattern of WORLD_ROUTE.webhookAllowlist) {
      await t.db.privileged.webhookAllowlistEntry.create({
        data: { routeId: ROUTE_ID, pattern },
      });
    }

    // Both processes write to files, not the console. The worker's logger redacts secret-like
    // values (ADR-0052). The web log is raw Next.js output, which is safe to keep only because
    // every e2e credential is fake.
    mkdirSync(LOG_DIR, { recursive: true });
    const workerLog = openSync(join(LOG_DIR, 'worker.log'), 'w');
    stops.push(() => closeSync(workerLog));
    const worker: WorkerHandle = await startWorker({
      config,
      env,
      log: createLogger({
        level: 'info',
        service: 'worker',
        destination: { write: (line: string) => void writeFileSync(workerLog, line) },
      }),
      role: 'all',
      healthPort: 0,
      metricsPort: false,
      leaderIntervalMs: 200,
      leaderLockName: 'e2e',
    });
    stops.push(() => worker.stop());

    const webLog = openSync(join(LOG_DIR, 'web.log'), 'w');
    stops.push(() => closeSync(webLog));
    const web = spawn(process.execPath, [join(repoRoot, 'apps/web/scripts/start-standalone.mjs')], {
      cwd: join(repoRoot, 'apps/web'),
      // Its own process group: the launcher script starts the server as a child, and both must go.
      detached: true,
      env: {
        ...process.env,
        ...env,
        HOST: '127.0.0.1',
        PORT: String(webPort),
        NEXT_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', webLog, webLog],
    });
    stops.push(
      () =>
        new Promise<void>((resolve) => {
          if (web.exitCode !== null) return resolve();
          // SIGTERM first; a server that ignores it is killed after 10 s.
          const group = (signal: NodeJS.Signals) => {
            try {
              process.kill(-(web.pid as number), signal);
            } catch {
              // already gone
            }
          };
          const hard = setTimeout(() => group('SIGKILL'), 10_000);
          web.once('exit', () => {
            clearTimeout(hard);
            // The launcher is gone; whatever is left of its group (the server) goes too.
            group('SIGKILL');
            resolve();
          });
          group('SIGTERM');
        }),
    );
    await waitForHttp(`${baseUrl}/signin`, web, 120_000);
    return { baseUrl, fakes, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
