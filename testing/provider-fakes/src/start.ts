import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerType, serve } from '@hono/node-server';
import type { Hono } from 'hono';
import {
  createFakeBitbucket,
  type FakeBitbucket,
  type FakeBitbucketOptions,
} from './bitbucket/index.ts';
import { type FakeGitServer, type FakeGitServerOptions, startFakeGitServer } from './git/index.ts';

/** Ports from DEV-020. The GitHub fake (T-042) and the git server (T-040) slot in beside these. */
export const DEFAULT_PORTS = { bitbucket: 4010, github: 4020, git: 4030 } as const;

/** Loopback by default: the control plane (/__reset, /__state) is unauthenticated. */
export const DEFAULT_HOSTNAME = '127.0.0.1';

export interface StartOptions {
  bitbucketPort?: number;
  hostname?: string;
  bitbucket?: FakeBitbucketOptions;
  gitPort?: number;
  /** Directory for the git server's repositories and LFS objects. Default: a fresh temp directory. */
  gitRootDir?: string;
  /** Extra options for the git server (credentials, limits). `false` does not start it. */
  git?: Omit<FakeGitServerOptions, 'rootDir' | 'port' | 'host'> | false;
}

export interface RunningFakes {
  bitbucket: FakeBitbucket & { port: number };
  /** Undefined when started with `git: false`. */
  git?: FakeGitServer;
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

/**
 * Starts every available fake. Pass port 0 for an ephemeral port (tests). The fake Bitbucket's clone
 * links point at the git server's `source` root (ADR-0070); the fake GitHub (T-042) will use `target`.
 */
export async function startFakes(options: StartOptions = {}): Promise<RunningFakes> {
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  let git: FakeGitServer | undefined;
  if (options.git !== false) {
    git = await startFakeGitServer({
      ...options.git,
      rootDir: options.gitRootDir ?? (await mkdtemp(join(tmpdir(), 'fake-git-'))),
      port: options.gitPort ?? DEFAULT_PORTS.git,
      host: hostname,
    });
  }
  const bitbucket = createFakeBitbucket({
    ...(git ? { gitBaseUrl: `${git.baseUrl}/source` } : {}),
    ...options.bitbucket,
  });
  let bb: Awaited<ReturnType<typeof listen>>;
  try {
    bb = await listen(bitbucket.app, options.bitbucketPort ?? DEFAULT_PORTS.bitbucket, hostname);
  } catch (error) {
    await git?.close();
    throw error;
  }
  return {
    bitbucket: Object.assign(bitbucket, { port: bb.port }),
    git,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        bb.server.close((e) => (e ? reject(e) : resolve()));
      });
      await git?.close();
    },
  };
}
