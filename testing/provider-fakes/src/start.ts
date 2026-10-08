import { type ServerType, serve } from '@hono/node-server';
import type { Hono } from 'hono';
import {
  createFakeBitbucket,
  type FakeBitbucket,
  type FakeBitbucketOptions,
} from './bitbucket/index.ts';

/** Ports from DEV-020. The GitHub fake (T-042) and the git server (T-040) slot in beside these. */
export const DEFAULT_PORTS = { bitbucket: 4010, github: 4020, git: 4030 } as const;

/** Loopback by default: the control plane (/__reset, /__state) is unauthenticated. */
export const DEFAULT_HOSTNAME = '127.0.0.1';

export interface StartOptions {
  bitbucketPort?: number;
  hostname?: string;
  bitbucket?: FakeBitbucketOptions;
}

export interface RunningFakes {
  bitbucket: FakeBitbucket & { port: number };
  close(): Promise<void>;
}

function listen(
  app: Hono,
  port: number,
  hostname: string,
): Promise<{ server: ServerType; port: number }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname }, (info) =>
      resolve({ server, port: info.port }),
    );
    server.on('error', reject);
  });
}

/** Starts every available fake. Pass port 0 for an ephemeral port (tests). */
export async function startFakes(options: StartOptions = {}): Promise<RunningFakes> {
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const bitbucket = createFakeBitbucket(options.bitbucket);
  const bb = await listen(
    bitbucket.app,
    options.bitbucketPort ?? DEFAULT_PORTS.bitbucket,
    hostname,
  );
  return {
    bitbucket: Object.assign(bitbucket, { port: bb.port }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        bb.server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
