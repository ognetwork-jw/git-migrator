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
import { dirname, isAbsolute, join } from 'node:path';
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
/**
 * Live runs use real credentials, so their logs go to a separate, clearly named directory that CI
 * never uploads and the docs warn about.
 */
export const LIVE_ARTIFACTS_DIR = join(repoRoot, 'testing/e2e/live-artifacts');
export const FAKE_PEM = readFileSync(
  join(repoRoot, 'testing/fixtures/fake-github-app.pem'),
  'utf8',
);

export const SOURCE_ENDPOINT = 'bb-src';
export const TARGET_ENDPOINT = 'gh-dst';
export const ROUTE_ID = 'r-auto';
const AUTH_SECRET = 'e2e-better-auth-secret-0123456789abcdef';
export const FAKE_BITBUCKET_TOKEN = 'fake-bitbucket-api-token';
export const FAKE_ACCOUNT_ID = 'acct-operator';
export const FAKE_OPERATOR_EMAIL = 'operator@test.local';

export interface Stack {
  readonly baseUrl: string;
  readonly fakes: RunningFakes;
  stop(): Promise<void>;
}

export interface LiveStack {
  readonly baseUrl: string;
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

/**
 * Closes every registered step in reverse order. Each step is closed on its own and bounded, so a
 * hung worker or process cannot keep the database from being dropped or the fakes from closing.
 */
function closer(stops: Array<() => Promise<void> | void>): () => Promise<void> {
  return async () => {
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
}

/** Starts everything; call `stop()` to close it in reverse order and drop the database. */
export async function startStack(): Promise<Stack> {
  const stops: Array<() => Promise<void> | void> = [];
  const stop = closer(stops);
  try {
    const t: TestDatabase = await createTestDatabase('gm_t087_');
    stops.push(() => t.drop());
    const fakes = await startWorldFakes({ bitbucketPort: 0, githubPort: 0, gitPort: 0 });
    stops.push(() => fakes.close());
    await resetWorld(fakes);
    fakes.git?.setTokens('source', [FAKE_BITBUCKET_TOKEN]);
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
    await launchApp(stops, {
      t,
      configFile,
      scratch,
      webPort,
      environment: 'test',
      testPassword: TEST_PASSWORD,
      secrets: {
        BETTER_AUTH_SECRET: AUTH_SECRET,
        BITBUCKET_CREDENTIALS: JSON.stringify([
          {
            id: 'operator',
            accountId: FAKE_ACCOUNT_ID,
            email: FAKE_OPERATOR_EMAIL,
            apiToken: FAKE_BITBUCKET_TOKEN,
          },
        ]),
        GITHUB_APP_PRIVATE_KEY: FAKE_PEM,
      },
      logDir: LOG_DIR,
      afterSeed: async () => {
        // The Route's webhook allowlist is operator data (LIF-011); the world's expectations assume it.
        for (const pattern of WORLD_ROUTE.webhookAllowlist) {
          await t.db.privileged.webhookAllowlistEntry.create({
            data: { routeId: ROUTE_ID, pattern },
          });
        }
      },
    });
    return { baseUrl, fakes, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

interface LaunchOptions {
  readonly t: TestDatabase;
  readonly configFile: string;
  readonly scratch: string;
  readonly webPort: number;
  /** `GM_ENVIRONMENT` of both processes: `test` for the fakes, `e2e` for the live accounts. */
  readonly environment: 'test' | 'e2e';
  readonly testPassword: string;
  /** BETTER_AUTH_SECRET and the provider secrets, which the platform would inject. */
  readonly secrets: Readonly<Record<string, string>>;
  readonly afterSeed?: (() => Promise<void>) | undefined;
  /** Where the web and worker logs go. */
  readonly logDir: string;
}

/**
 * Migrates and seeds the database, starts the worker in-process and the built web app as a real
 * process, and waits until the web app answers. Shared by the fakes stack and the live stack, so
 * the live e2e drives exactly the processes the fakes tier does. Registers every close in `stops`.
 */
async function launchApp(
  stops: Array<() => Promise<void> | void>,
  options: LaunchOptions,
): Promise<void> {
  const { t, configFile, scratch, webPort, environment } = options;
  const baseUrl = `http://127.0.0.1:${webPort}`;
  const url = new URL(t.connectionString);
  // What the processes get from the platform: the configuration file, the database, the secrets.
  const env: Record<string, string> = {
    GM_ENVIRONMENT: environment,
    GM_CONFIG_FILE: configFile,
    GM_SCRATCH_DIR: scratch,
    GM_POSTGRES_HOST: url.hostname,
    GM_POSTGRES_PORT: url.port,
    GM_POSTGRES_DATABASE: t.name,
    GM_POSTGRES_USER: decodeURIComponent(url.username),
    GM_POSTGRES_SSLMODE: 'disable',
    POSTGRES_PASSWORD: decodeURIComponent(url.password),
    GM_TEST_USER_PASSWORD: options.testPassword,
    ...options.secrets,
  };
  const config = loadConfig({ env });
  await runMigrate(config, env);
  await runSeed(config, env);
  await options.afterSeed?.();

  // Both processes write to files, not the console. The worker's logger redacts secret-like
  // values (ADR-0052); the web log is raw Next.js output. Fakes tier: every credential is fake, so
  // CI uploads `logs/`. Live run (real credentials): `LIVE_ARTIFACTS_DIR`, never uploaded.
  mkdirSync(options.logDir, { recursive: true });
  const workerLog = openSync(join(options.logDir, 'worker.log'), 'w');
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

  const webLog = openSync(join(options.logDir, 'web.log'), 'w');
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
}

/** The web app runs from another directory, so the configuration path must not be relative. */
function absoluteConfig(path: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`GM_CONFIG_FILE must be an absolute path by now (it is ${path}).`);
  }
  return path;
}

/**
 * The stack of the live e2e (TST-030): the same worker and built web app as `startStack`, a
 * throw-away database, and the Endpoints, Route and secrets of the human's configuration (profile
 * `e2e`, `GM_CONFIG_FILE`). There are no fakes. The web app listens where `publicUrl` says, which
 * must be `http://127.0.0.1:<port>` so that sign-in cookies and origin checks agree.
 */
export async function startLiveStack(
  env: Readonly<Record<string, string | undefined>>,
): Promise<LiveStack> {
  const config = loadConfig({ env });
  const publicUrl = new URL(config.publicUrl);
  if (publicUrl.protocol !== 'http:' || publicUrl.hostname !== '127.0.0.1' || !publicUrl.port) {
    throw new Error(
      `publicUrl must be http://127.0.0.1:<port> for the live e2e (it is ${config.publicUrl}).`,
    );
  }
  const secret = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set (secretspec profile e2e).`);
    return value;
  };
  const secrets: Record<string, string> = {
    BETTER_AUTH_SECRET: secret('BETTER_AUTH_SECRET'),
    BITBUCKET_CREDENTIALS: secret('BITBUCKET_CREDENTIALS'),
    GITHUB_APP_PRIVATE_KEY: secret('GITHUB_APP_PRIVATE_KEY'),
  };
  for (const optional of ['ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET']) {
    const value = env[optional];
    if (value) secrets[optional] = value;
  }
  // The database role comes from the same secret as the app's (docs/e2e-setup.md).
  if (!process.env.GM_TEST_DATABASE_URL && env.POSTGRES_PASSWORD) {
    process.env.GM_TEST_DATABASE_URL = `postgresql://git_migrator:${encodeURIComponent(env.POSTGRES_PASSWORD)}@127.0.0.1:5432/postgres`;
  }
  const stops: Array<() => Promise<void> | void> = [];
  const stop = closer(stops);
  try {
    const t = await createTestDatabase('gm_live_');
    stops.push(() => t.drop());
    const root = mkdtempSync(join(tmpdir(), 'gm-e2e-live-'));
    stops.push(() => rmSync(root, { recursive: true, force: true }));
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    await launchApp(stops, {
      t,
      configFile: absoluteConfig(secret('GM_CONFIG_FILE')),
      scratch,
      webPort: Number(publicUrl.port),
      environment: 'e2e',
      testPassword: secret('GM_TEST_USER_PASSWORD'),
      secrets,
      logDir: LIVE_ARTIFACTS_DIR,
    });
    return { baseUrl: config.publicUrl.replace(/\/+$/, ''), stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
