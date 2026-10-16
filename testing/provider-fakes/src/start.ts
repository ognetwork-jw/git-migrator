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
import { importBareRepository } from './github/git-import.ts';
import {
  createFakeGitHub,
  type FakeGitHub,
  type FakeGitHubOptions,
  type GitHubState,
} from './github/index.ts';
import type { RepoRec } from './github/types.ts';

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
function githubGitWiring(git: FakeGitServer, pushes: PushTracker): FakeGitHubOptions {
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
    syncGit: (repo) => pushes.sync(repo, () => importBareRepository(dir(repo), repo.git)),
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

type RepositoryHooks = NonNullable<FakeGitHubOptions['repositoryHooks']>;

/**
 * A caller's repository hooks run after the git wiring's, so passing some does not drop the bare
 * repository management or the policy flag.
 */
function mergeHooks(
  wiring: RepositoryHooks | undefined,
  caller: RepositoryHooks | undefined,
): RepositoryHooks | undefined {
  if (!wiring || !caller) return caller ?? wiring;
  return {
    created: async (repo) => {
      await wiring.created?.(repo);
      await caller.created?.(repo);
    },
    renamed: async (repo, oldName) => {
      await wiring.renamed?.(repo, oldName);
      await caller.renamed?.(repo, oldName);
    },
    deleted: async (repo) => {
      await wiring.deleted?.(repo);
      await caller.deleted?.(repo);
    },
    policyChanged: (repo, active) => {
      wiring.policyChanged?.(repo, active);
      caller.policyChanged?.(repo, active);
    },
  };
}

/**
 * Repositories pushed to since the fake GitHub last read their bare repository. A push marks the
 * repository before its response ends; the next REST request on it reads the bare repository once
 * (concurrent requests share that read).
 */
class PushTracker {
  private readonly dirty = new WeakSet<RepoRec>();
  private readonly reading = new WeakMap<RepoRec, Promise<void>>();

  pushed(repo: RepoRec | undefined): void {
    if (repo) this.dirty.add(repo);
  }

  async sync(repo: RepoRec, read: () => Promise<void>): Promise<void> {
    for (;;) {
      const running = this.reading.get(repo);
      if (running) {
        await running.catch(() => {});
        continue;
      }
      if (!this.dirty.has(repo)) return;
      this.dirty.delete(repo);
      const next = read().finally(() => this.reading.delete(repo));
      this.reading.set(repo, next);
      await next;
      return;
    }
  }
}

/** Git server target side options that tie access and pushes to the fake GitHub's tokens and rules. */
function githubGitServerSide(
  getState: () => GitHubState | undefined,
  pushes: PushTracker,
): GitSideOptions {
  return {
    ...githubGitAccess(getState),
    onPushed: ({ repo }) => {
      const [owner, name] = repo.split('/');
      pushes.pushed(owner && name ? getState()?.findRepo(owner, name) : undefined);
    },
  };
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
  const pushes = new PushTracker();
  if (options.git !== false) {
    git = await startFakeGitServer({
      ...options.git,
      ...(withGitHub
        ? {
            target: { ...githubGitServerSide(() => githubState, pushes), ...options.git?.target },
          }
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
  const wiring = git ? githubGitWiring(git, pushes) : {};
  const github = withGitHub
    ? createFakeGitHub({
        ...wiring,
        ...options.github,
        repositoryHooks: mergeHooks(wiring.repositoryHooks, options.github?.repositoryHooks),
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
    // Every server is closed even when an earlier one fails; the first failure is rethrown.
    close: async () => {
      const results = await Promise.allSettled([
        closeServer(bb.server),
        ...(ghServer ? [closeServer(ghServer.server)] : []),
        ...(git ? [git.close()] : []),
      ]);
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
    },
  };
}

/** Strips trailing slashes from a base URL. */
const trimSlash = (url: string) => url.replace(/\/+$/, '');

/**
 * Options of `src/main.ts` from its environment: `FAKE_BITBUCKET_PORT`, `FAKE_GITHUB_PORT` (default
 * 4020, so the fake GitHub always starts), `FAKE_GIT_PORT`, `FAKE_GIT_ROOT`, `FAKES_HOST`,
 * `FAKE_GIT_PUBLIC_URL` (the git server's advertised root, used for LFS and both fakes' clone links)
 * and `FAKE_GIT_BASE_URL` (the git server root for the clone links only: Bitbucket's under `/source`,
 * GitHub's under `/target`; it overrides `FAKE_GIT_PUBLIC_URL` for them).
 */
export function startOptionsFromEnv(env: NodeJS.ProcessEnv): StartOptions {
  const base = env.FAKE_GIT_BASE_URL ? trimSlash(env.FAKE_GIT_BASE_URL) : undefined;
  return {
    bitbucketPort: env.FAKE_BITBUCKET_PORT ? Number(env.FAKE_BITBUCKET_PORT) : undefined,
    githubPort: env.FAKE_GITHUB_PORT ? Number(env.FAKE_GITHUB_PORT) : DEFAULT_PORTS.github,
    gitPort: env.FAKE_GIT_PORT ? Number(env.FAKE_GIT_PORT) : undefined,
    gitRootDir: env.FAKE_GIT_ROOT,
    hostname: env.FAKES_HOST,
    bitbucket: base ? { gitBaseUrl: `${base}/source` } : {},
    github: base ? { gitBaseUrl: `${base}/target` } : {},
    git: env.FAKE_GIT_PUBLIC_URL ? { publicUrl: env.FAKE_GIT_PUBLIC_URL } : {},
  };
}
