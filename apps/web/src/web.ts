import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { loadConfigOrExit } from '@git-migrator/config';
import {
  createLogger,
  createMetrics,
  type Logger,
  startMetricsServer,
  startTracing,
} from '@git-migrator/observability';
import { buildApiRuntime, closeApiRuntime, setApiRuntime } from './server/api.ts';

/** Port of the web server (DEP-031: Service port 3000). */
export const WEB_PORT = 3000;
/** Grace before connections that are still open (SSE streams) are cut at shutdown. */
export const DRAIN_MS = 20_000;
/** `web.terminationGracePeriodSeconds` of the chart (values.yaml), in milliseconds. */
export const TERMINATION_GRACE_MS = 30_000;
/** The `preStop` sleep of the chart's web container (templates/deployment-web.yaml). */
export const PRE_STOP_MS = 5_000;
/**
 * Hard limit of the shutdown after SIGTERM: the grace period minus the preStop sleep minus 2 s,
 * so the process exits 0 before Kubernetes sends SIGKILL, whatever is still open.
 */
export const SHUTDOWN_DEADLINE_MS = TERMINATION_GRACE_MS - PRE_STOP_MS - 2_000;
/** Bound on each close step after the drain (Next.js, metrics, API runtime, tracing export). */
export const CLOSE_STEP_TIMEOUT_MS = 1_000;
/**
 * Where `next build` (`output: 'standalone'`) writes the server: `server.js`, the traced
 * `node_modules` and `.next`. The image copies `.next/static` into it at build time (DEP-001).
 */
export const STANDALONE_DIR = join(import.meta.dirname, '..', '.next', 'standalone', 'apps', 'web');

/** A Node.js request listener: Next.js's request handler, or a test's. */
export type RequestListener = (request: IncomingMessage, response: ServerResponse) => void;

export interface WebServerOptions {
  /** The request handler. */
  readonly handler: RequestListener;
  /** 0 picks a free port. */
  readonly port?: number;
  readonly host?: string;
}

export interface WebServer {
  readonly port: number;
  /** Stops accepting connections, lets requests finish, and cuts the rest after `drainMs`. */
  close(drainMs?: number): Promise<void>;
}

/**
 * The HTTP server of the `web` entrypoint (DEP-002): a Node.js http server around one request
 * handler, with the drain of DEP-030 on close.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const server: Server = createServer(options.handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? WEB_PORT, options.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? WEB_PORT);
  return {
    port,
    close: (drainMs = DRAIN_MS) =>
      new Promise<void>((resolve) => {
        const cut = setTimeout(() => server.closeAllConnections(), drainMs);
        cut.unref();
        server.close(() => {
          clearTimeout(cut);
          resolve();
        });
        server.closeIdleConnections();
      }),
  };
}

/** The part of Next.js's programmatic server (`next(options)`) that the entrypoint uses. */
interface NextApp {
  prepare(): Promise<void>;
  getRequestHandler(): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  close(): Promise<void>;
}
type NextFactory = (options: {
  dev: false;
  dir: string;
  conf: unknown;
  hostname: string;
  port: number;
  customServer: true;
}) => NextApp;

export interface NextHandlerOptions {
  /** The standalone app directory, the one holding `server.js`. */
  readonly dir: string;
  readonly hostname: string;
  readonly port: number;
  /** Receives request errors that Next.js did not answer itself. */
  readonly onError?: (error: unknown) => void;
}

export interface NextHandler {
  readonly handler: RequestListener;
  close(): Promise<void>;
}

/**
 * Loads the Next.js standalone server in this process (DEP-002, ADR-0500): the same `next` package
 * and configuration that the generated `server.js` uses, through the programmatic API, so that this
 * entrypoint owns the http server (drain on SIGTERM), the metrics server and tracing. The UI pages
 * and the Hono API (`app/api/[[...route]]`) are both served by it.
 */
export async function prepareNextHandler(options: NextHandlerOptions): Promise<NextHandler> {
  const serverFile = join(options.dir, 'server.js');
  if (!existsSync(serverFile)) {
    throw new Error(`no Next.js standalone build at ${options.dir}`);
  }
  // `server.js` embeds the build's configuration; `required-server-files.json` holds the same one.
  const { config } = JSON.parse(
    readFileSync(join(options.dir, '.next', 'required-server-files.json'), 'utf8'),
  ) as { config: unknown };
  // Next.js reads the configuration from here instead of looking for next.config.ts, as server.js
  // arranges.
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);
  // Defence in depth: in next 16.4.0 only `startServer` (server.js) reads this and the
  // programmatic server installs no signal handlers, but should a later release install them on
  // this path too, they must stay with this entrypoint, whose shutdown drains (ADR-0500).
  process.env.NEXT_MANUAL_SIG_HANDLE = 'true';
  const next = createRequire(serverFile)('next') as NextFactory;
  const app = next({
    dev: false,
    dir: options.dir,
    conf: config,
    hostname: options.hostname,
    port: options.port,
    customServer: true,
  });
  await app.prepare();
  const handle = app.getRequestHandler();
  return {
    handler: (request, response) => {
      handle(request, response).catch((error: unknown) => {
        options.onError?.(error);
        if (!response.headersSent) response.statusCode = 500;
        response.end();
      });
    },
    close: () => app.close(),
  };
}

export interface ShutdownStep {
  readonly name: string;
  readonly run: () => Promise<unknown>;
  /** Gives up waiting for the step after this long and goes on with the next one. */
  readonly timeoutMs?: number;
}

export interface ShutdownOptions {
  readonly steps: readonly ShutdownStep[];
  /** After this long the process exits 0, whatever is still running. */
  readonly deadlineMs: number;
  readonly exit: (code: number) => void;
  readonly log: Pick<Logger, 'warn' | 'error'>;
}

/**
 * The shutdown of the web process (DEP-030): runs the steps in order, each bounded by its
 * timeout, then exits 0, or 1 when a step failed. A deadline timer exits 0 in any case once
 * `deadlineMs` has passed, so the pod never outlives its grace period. Calling it again does
 * nothing.
 */
export function createShutdown(options: ShutdownOptions): () => void {
  let started = false;
  return () => {
    if (started) return;
    started = true;
    const deadline = setTimeout(() => {
      options.log.warn({ deadlineMs: options.deadlineMs }, 'shutdown deadline reached; exiting');
      options.exit(0);
    }, options.deadlineMs);
    deadline.unref();
    void (async () => {
      let failed = false;
      for (const step of options.steps) {
        try {
          const outcome = await bounded(step.run(), step.timeoutMs);
          if (outcome === TIMED_OUT) {
            options.log.warn(
              { step: step.name, timeoutMs: step.timeoutMs },
              'shutdown step timed out',
            );
          }
        } catch (error) {
          failed = true;
          options.log.error({ err: error, step: step.name }, 'web shutdown step failed');
        }
      }
      clearTimeout(deadline);
      options.exit(failed ? 1 : 0);
    })();
  };
}

const TIMED_OUT = Symbol('timed out');

function bounded<T>(promise: Promise<T>, ms: number | undefined): Promise<T | typeof TIMED_OUT> {
  if (ms === undefined) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Process entry: `web` (DEP-002). Secrets arrive in the environment (`secretspec run`). */
export async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const log: Logger = createLogger({ level: config.observability.logLevel, service: 'web' });
  const tracing = startTracing({
    serviceName: config.observability.serviceName,
    otlpEndpoint: config.observability.otlpEndpoint,
  });
  // Built here, before Next.js loads, and shared with the route handlers through getApiRuntime.
  setApiRuntime(buildApiRuntime(process.env));
  const { registry } = createMetrics();
  const metrics = await startMetricsServer({ registry, port: config.metrics.port });
  const port = Number(process.env.PORT ?? WEB_PORT);
  const host = process.env.HOST ?? '0.0.0.0';
  const dir = process.env.GM_WEB_STANDALONE_DIR ?? STANDALONE_DIR;
  // The standalone server runs from its own directory (server.js does the same).
  process.chdir(dir);
  const nextApp = await prepareNextHandler({
    dir,
    hostname: host,
    port,
    onError: (error) => log.error({ err: error }, 'request failed'),
  });
  const web = await startWebServer({ handler: nextApp.handler, port, host });
  log.info({ port: web.port, metricsPort: metrics.port }, 'web listening');

  const stop = createShutdown({
    deadlineMs: SHUTDOWN_DEADLINE_MS,
    exit: (code) => process.exit(code),
    log,
    steps: [
      // The drain itself is bounded by DRAIN_MS: streams still open then are cut.
      { name: 'http', run: () => web.close(DRAIN_MS) },
      { name: 'next', run: () => nextApp.close(), timeoutMs: CLOSE_STEP_TIMEOUT_MS },
      { name: 'metrics', run: () => metrics.close(), timeoutMs: CLOSE_STEP_TIMEOUT_MS },
      { name: 'api', run: () => closeApiRuntime(), timeoutMs: CLOSE_STEP_TIMEOUT_MS },
      {
        name: 'tracing',
        run: () => tracing.shutdown().catch(() => undefined),
        timeoutMs: CLOSE_STEP_TIMEOUT_MS,
      },
    ],
  });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (import.meta.main) await main();
