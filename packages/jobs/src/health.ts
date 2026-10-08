import { createServer, type Server } from 'node:http';

/** Port of the worker health server (DEP-031 probes). */
export const HEALTH_PORT = 8081;

export interface HealthServerOptions {
  readonly port?: number;
  readonly host?: string;
  /** True once the queue workers started (`/readyz`). */
  readonly ready: () => boolean;
}

export interface HealthServer {
  /** The bound port (useful when `port` was 0). */
  readonly port: number;
  close(): Promise<void>;
}

/**
 * The worker health server (DEP-031): `GET /healthz` is 200 while the process runs, `GET /readyz`
 * is 200 after the queue workers started and 503 before. Anything else is 404 or 405. It serves no
 * data, so it needs no authentication.
 */
export async function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0];
    const send = (status: number, body: string): void => {
      response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(body);
    };
    if (path !== '/healthz' && path !== '/readyz') return send(404, 'not found\n');
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return send(405, 'method not allowed\n');
    if (path === '/healthz') return send(200, 'ok\n');
    return options.ready() ? send(200, 'ready\n') : send(503, 'not ready\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? HEALTH_PORT, options.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port =
    typeof address === 'object' && address ? address.port : (options.port ?? HEALTH_PORT);
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
