/**
 * PLACEHOLDER (T-002). Serves `pnpm dev` on port 3000 until the Next.js app lands (T-021 API,
 * T-080 web shell). Replace this file with the real dev entrypoint; keep the port and the
 * `dev` script name so Compose and devenv keep working.
 */
import { createServer, type Server } from 'node:http';

/** Loopback by default. The dev image sets HOST=0.0.0.0 so that Compose can publish the port. */
export const DEFAULT_HOST = '127.0.0.1';

export interface WebPlaceholderOptions {
  port: number;
  host: string;
}

/** Starts the placeholder HTTP server and resolves once it listens. Port 0 picks a free port. */
export function startWebPlaceholder({ port, host }: WebPlaceholderOptions): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('git-migrator web: placeholder from T-002, replaced by T-080\n');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? DEFAULT_HOST;
  const server = await startWebPlaceholder({ port, host });
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  console.log(`web placeholder listening on http://${host}:${bound}`);
}
