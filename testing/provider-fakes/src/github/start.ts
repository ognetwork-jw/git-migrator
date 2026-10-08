import { type ServerType, serve } from '@hono/node-server';
import { createFakeGitHub, type FakeGitHub } from './app.ts';
import type { FakeGitHubOptions } from './config.ts';

/** Port from DEV-020. */
export const DEFAULT_GITHUB_PORT = 4020;

export interface StartFakeGitHubOptions extends FakeGitHubOptions {
  /** 0 picks an ephemeral port (tests). Default 4020. */
  port?: number;
  /** Default 127.0.0.1. Use 0.0.0.0 inside a container. */
  hostname?: string;
}

export interface RunningFakeGitHub extends FakeGitHub {
  port: number;
  hostname: string;
  /** `http://{hostname}:{port}` */
  url: string;
  close(): Promise<void>;
}

/** Creates the fake GitHub and binds it to a real port. */
export function startFakeGitHub(options: StartFakeGitHubOptions = {}): Promise<RunningFakeGitHub> {
  const { port = DEFAULT_GITHUB_PORT, hostname = '127.0.0.1', ...fakeOptions } = options;
  const fake = createFakeGitHub(fakeOptions);
  return new Promise((resolve, reject) => {
    const server: ServerType = serve({ fetch: fake.app.fetch, port, hostname }, (info) =>
      resolve({
        ...fake,
        port: info.port,
        hostname,
        url: `http://${hostname}:${info.port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((e) => (e ? fail(e) : done()));
          }),
      }),
    );
    server.on('error', reject);
  });
}
