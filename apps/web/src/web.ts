import type { Server } from 'node:http';
import { loadConfigOrExit } from '@git-migrator/config';
import {
  createLogger,
  createMetrics,
  type Logger,
  startMetricsServer,
  startTracing,
} from '@git-migrator/observability';
import { serve } from '@hono/node-server';
import { buildApiRuntime } from './server/api.ts';

/** Port of the web server (DEP-031: Service port 3000). */
export const WEB_PORT = 3000;
/** Grace before connections that are still open (SSE streams) are cut at shutdown. */
export const DRAIN_MS = 20_000;

export interface WebServerOptions {
  /** The request handler: the Hono app's `fetch`. */
  readonly fetch: (request: Request) => Response | Promise<Response>;
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
 * The HTTP server of the `web` entrypoint (DEP-002): serves the Hono app on Node's http server.
 * Until the Next.js app lands (T-080, ADR-0290) it serves the API only, including `/api/healthz`
 * and `/api/readyz` (DEP-030).
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  let server: Server | undefined;
  await new Promise<void>((resolve, reject) => {
    const created = serve(
      { fetch: options.fetch, port: options.port ?? WEB_PORT, hostname: options.host ?? '0.0.0.0' },
      () => resolve(),
    ) as Server;
    created.once('error', reject);
    server = created;
  });
  const listening = server as Server;
  const address = listening.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? WEB_PORT);
  return {
    port,
    close: (drainMs = DRAIN_MS) =>
      new Promise<void>((resolve) => {
        const cut = setTimeout(() => listening.closeAllConnections(), drainMs);
        cut.unref();
        listening.close(() => {
          clearTimeout(cut);
          resolve();
        });
        listening.closeIdleConnections();
      }),
  };
}

/** Process entry: `web` (DEP-002). Secrets arrive in the environment (`secretspec run`). */
export async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const log: Logger = createLogger({ level: config.observability.logLevel, service: 'web' });
  const tracing = startTracing({
    serviceName: config.observability.serviceName,
    otlpEndpoint: config.observability.otlpEndpoint,
  });
  const runtime = buildApiRuntime(process.env);
  const { registry } = createMetrics();
  const metrics = await startMetricsServer({ registry, port: config.metrics.port });
  const web = await startWebServer({
    fetch: (request) => runtime.app.fetch(request),
    port: Number(process.env.PORT ?? WEB_PORT),
    host: process.env.HOST ?? '0.0.0.0',
  });
  log.info({ port: web.port, metricsPort: metrics.port }, 'web listening');

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      await web.close();
      await metrics.close();
      await runtime.close();
      await tracing.shutdown().catch(() => undefined);
      process.exit(0);
    })().catch((error: unknown) => {
      log.error({ err: error }, 'web shutdown failed');
      process.exit(1);
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (import.meta.main) await main();
