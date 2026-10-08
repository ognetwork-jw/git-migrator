import { createServer, type Server } from 'node:http';
import type { Registry } from 'prom-client';

export interface MetricsServerOptions {
  readonly registry: Registry;
  /** Defaults to 9464 (DEP-050). Pass 0 to let the system choose, as tests do. */
  readonly port?: number;
  /** Defaults to all interfaces, so the Kubernetes scraper can reach the pod. */
  readonly host?: string;
}

export interface MetricsServer {
  /** The port actually bound. */
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Serves `GET /metrics` in the Prometheus text format on a port of its own (DEP-050). The API never
 * serves metrics (AUTH-020 keeps them off the authenticated API). Other paths get 404 and other
 * methods get 405.
 */
export function startMetricsServer(options: MetricsServerOptions): Promise<MetricsServer> {
  const server: Server = createServer((request, response) => {
    if (request.url !== '/metrics' && !request.url?.startsWith('/metrics?')) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found\n');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    options.registry
      .metrics()
      .then((body) => {
        response.writeHead(200, { 'content-type': options.registry.contentType });
        response.end(request.method === 'HEAD' ? undefined : body);
      })
      .catch(() => {
        response
          .writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          .end('Metrics unavailable\n');
      });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 9464, options.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}
