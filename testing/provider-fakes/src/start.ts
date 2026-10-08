import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerType, serve } from '@hono/node-server';
import type { Hono } from 'hono';
import {
  createFakeBitbucket,
  type FakeBitbucket,
  type FakeBitbucketOptions,
} from './bitbucket/index.ts';
import {
  createBareRepo,
  type FakeGitServer,
  type FakeGitServerOptions,
  type GitSideOptions,
  POLICY_FLAG_FILE,
  startFakeGitServer,
} from './git/index.ts';
import { githubGitAccess } from './github/git-access.ts';
import {
  createFakeGitHub,
  type FakeGitHub,
  type FakeGitHubOptions,
  type GitHubState,
} from './github/index.ts';

/** Ports from DEV-020. */
export const DEFAULT_PORTS = { bitbucket: 4010, github: 4020, git: 4030 } as const;

/** Loopback by default: the control plane (/__reset, /__state) is unauthenticated. */
export const DEFAULT_HOSTNAME = '127.0.0.1';

export interface StartOptions {
  bitbucketPort?: number;
  hostname?: string;
  bitbucket?: FakeBitbucketOptions;
  /**
   * Starts the fake GitHub (T-042) on this port (4020 by DEV-020, 0 = ephemeral). Without it, and
   * without `github` options, only the fake Bitbucket and the git server start. `src/main.ts`
   * always passes 4020.
   */
  githubPort?: number;
  github?: FakeGitHubOptions;
  gitPort?: number;
  /** Directory for the git server's repositories and LFS objects. Default: a fresh temp directory. */
  gitRootDir?: string;
  /** Extra options for the git server (credentials, limits). `false` does not start it. */
  git?: Omit<FakeGitServerOptions, 'rootDir' | 'port' | 'host'> | false;
}

export interface RunningFakes {
  bitbucket: FakeBitbucket & { port: number };
  /** Undefined unless `githubPort` or `github` was given. */
  github?: FakeGitHub & { port: number };
  /** Undefined when started with `git: false`. */
  git?: FakeGitServer;
  close(): Promise<void>;
}

/**
 * Wires the fake GitHub to the git server's `target` side (ADR-0070, ADR-0075): clone links, bare
 * repositories created, renamed and deleted with the REST repository (with their LFS objects), LFS
 * existence from the target LFS store.
 */
function githubGitWiring(git: FakeGitServer): FakeGitHubOptions {
  const dir = (repo: { owner: string; name: string }, name = repo.name) =>
    git.repoDir('target', `${repo.owner}/${name}`);
  const lfsDir = (repo: { owner: string; name: string }, name = repo.name) =>
    join(git.lfsStore('target').dir, repo.owner, name);
  /** Sets or removes the policy flag from the rules, whenever the bare repository exists. */
  const syncFlag = (repo: { owner: string; name: string }, active: boolean) => {
    if (!existsSync(dir(repo))) return;
    const flag = join(dir(repo), POLICY_FLAG_FILE);
    if (active) writeFileSync(flag, '');
    else rmSync(flag, { force: true });
  };
  return {
    gitBaseUrl: `${git.baseUrl}/target`,
    lfsHas: (repo, oid) => git.lfsStore('target').size(`${repo.owner}/${repo.name}`, oid),
    repositoryHooks: {
      // Keeps the pre-receive policy flag in step with the rules (the hook reads it when it runs).
      policyChanged: (repo, active) => syncFlag(repo, active),
      // A new repository is always empty: drop leftovers of an earlier one with the same name.
      created: async (repo) => {
        await rm(dir(repo), { recursive: true, force: true });
        await rm(lfsDir(repo), { recursive: true, force: true });
        await createBareRepo(dir(repo), repo.defaultBranch);
        syncFlag(repo, repo.rules.length > 0); // a rule may have been created during the window
      },
      renamed: async (repo, oldName) => {
        if (existsSync(dir(repo, oldName))) await rename(dir(repo, oldName), dir(repo));
        if (existsSync(lfsDir(repo, oldName))) await rename(lfsDir(repo, oldName), lfsDir(repo));
        syncFlag(repo, repo.rules.length > 0);
      },
      deleted: async (repo) => {
        await rm(dir(repo), { recursive: true, force: true });
        await rm(lfsDir(repo), { recursive: true, force: true });
      },
    },
  };
}

/** Git server target side options that tie access and pushes to the fake GitHub's tokens and rules. */
function githubGitServerSide(getState: () => GitHubState | undefined): GitSideOptions {
  return githubGitAccess(getState);
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
 * links point at the git server's `source` root (ADR-0070); the fake GitHub (T-042) uses `target`.
 */
export async function startFakes(options: StartOptions = {}): Promise<RunningFakes> {
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  let git: FakeGitServer | undefined;
  // The git server starts first; its target side asks the fake GitHub (created below) for access and
  // branch protection decisions.
  let githubState: GitHubState | undefined;
  const withGitHub = options.githubPort !== undefined || options.github !== undefined;
  if (options.git !== false) {
    git = await startFakeGitServer({
      ...options.git,
      ...(withGitHub
        ? { target: { ...githubGitServerSide(() => githubState), ...options.git?.target } }
        : {}),
      rootDir: options.gitRootDir ?? (await mkdtemp(join(tmpdir(), 'fake-git-'))),
      port: options.gitPort ?? DEFAULT_PORTS.git,
      host: hostname,
    });
  }
  const bitbucket = createFakeBitbucket({
    ...(git ? { gitBaseUrl: `${git.baseUrl}/source` } : {}),
    ...options.bitbucket,
  });
  const github = withGitHub
    ? createFakeGitHub({
        ...(git ? githubGitWiring(git) : {}),
        ...options.github,
      })
    : undefined;
  githubState = github?.state;
  let bb: Awaited<ReturnType<typeof listen>>;
  let gh: Awaited<ReturnType<typeof listen>> | undefined;
  const closeServer = (server: ServerType) =>
    new Promise<void>((resolve, reject) => {
      server.close((e) => (e ? reject(e) : resolve()));
    });
  try {
    bb = await listen(bitbucket.app, options.bitbucketPort ?? DEFAULT_PORTS.bitbucket, hostname);
  } catch (error) {
    await git?.close();
    throw error;
  }
  if (github) {
    try {
      gh = await listen(github.app, options.githubPort ?? DEFAULT_PORTS.github, hostname);
    } catch (error) {
      await closeServer(bb.server);
      await git?.close();
      throw error;
    }
  }
  const ghServer = gh;
  return {
    bitbucket: Object.assign(bitbucket, { port: bb.port }),
    github: github && ghServer ? Object.assign(github, { port: ghServer.port }) : undefined,
    git,
    close: async () => {
      await closeServer(bb.server);
      if (ghServer) await closeServer(ghServer.server);
      await git?.close();
    },
  };
}
