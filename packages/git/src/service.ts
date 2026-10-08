/**
 * `GitService`: the typed wrapper around the `git` and `git-lfs` CLIs (ARC-010). It implements the
 * adapter-sdk `GitClient` (ls-remote) and adds what the Run engine needs for `git.prepare`,
 * `git.push-lfs` and `git.push-refs`: mirror, blob scan, LFS fetch and push, batched push.
 *
 * Every command pre-acquires quota in the `git` bucket (JOB-041), takes its credential through
 * `GIT_ASKPASS` (ADP-071) and reports failures as scrubbed `AdapterError`s.
 */
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  GitClient,
  GitCredential,
  GitLsRemoteResult,
  Logger,
} from '@git-migrator/adapter-sdk';
import { AdapterError, noopLogger } from '@git-migrator/adapter-sdk';
import { normalizeRemoteUrl } from './askpass.ts';
import { type BlobScanResult, scanBlobs } from './blobs.ts';
import { classifyPushFailure, GitCommandError, isGitCommandError } from './errors.ts';
import type { SpawnFunction } from './exec.ts';
import {
  fetchLfsObjects,
  type LfsObject,
  type LfsTransferResult,
  listLfsObjects,
  pushLfsObjects,
} from './lfs.ts';
import { parseLsRemote } from './ls-remote.ts';
import {
  createPackEstimator,
  detectEstimatorMode,
  type EstimatorMode,
  type PackEstimator,
} from './pack-size.ts';
import {
  DEFAULT_MAX_PUSH_BYTES,
  type LocalRef,
  type PushEvent,
  type PushReport,
  pushBatched,
} from './push.ts';
import { GIT_UNITS, type GitQuota } from './quota.ts';
import { isValidRefName } from './ref-names.ts';
import { GIT_REMOTE_SOURCE, GIT_REMOTE_TARGET } from './remotes.ts';
import { type GitContext, GitRunner } from './runner.ts';

export interface GitServiceOptions {
  /** Pre-acquires units in the `git` bucket of the credential in use (JOB-041, JOB-042). */
  readonly quota: GitQuota;
  /** Where credential files live: the Run's scratch directory (JOB-015). */
  readonly scratchDir: string;
  readonly logger?: Logger;
  /** Test seam: records or replaces `child_process.spawn`. */
  readonly spawn?: SpawnFunction;
  /** `git.maxPushBytes`, default 1.5 GiB (LIF-044). */
  readonly maxPushBytes?: number;
  /** Retries of a failed push (LIF-044: 3). */
  readonly pushRetries?: number;
  /** Backoff base and cap in milliseconds (ADP-060: 1 s, 60 s). */
  readonly backoffBaseMs?: number;
  readonly backoffCapMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** Force one pack size estimator; by default `rev-list --disk-usage` when git has it. */
  readonly estimator?: EstimatorMode | PackEstimator;
  /** `git.maxConcurrentLfsTransfers` (default 8, DEP-001): `lfs.concurrenttransfers` for LFS commands. */
  readonly lfsConcurrentTransfers?: number;
  /** Kill a remote command that prints nothing for this long (default 10 minutes). */
  readonly stallTimeoutMs?: number;
}

export interface MirrorRequest {
  /** Clone URL without credentials. */
  readonly url: string;
  readonly credential: GitCredential;
  /** Directory of the bare mirror, inside the Run's scratch directory. */
  readonly dir: string;
  readonly signal?: AbortSignal;
}

export interface MirrorResult {
  readonly dir: string;
  /** `true` when an existing mirror was updated instead of cloned (a resumed step). */
  readonly updated: boolean;
  /** Bytes of the mirror's object store (loose and packed), for JOB-015 size estimates. */
  readonly sizeBytes: number;
}

export interface PushRefsRequest {
  readonly dir: string;
  /** Target URL without credentials. */
  readonly url: string;
  readonly credential: GitCredential;
  /** Short name of the default branch of the source, for example `main`. */
  readonly defaultBranch: string;
  /** Overwrite diverged target refs (the `adoptNonEmpty` reconcile, LIF-043). */
  readonly force?: boolean;
  readonly maxPushBytes?: number;
  readonly signal?: AbortSignal;
  readonly onPush?: (event: PushEvent) => void;
}

export interface LfsRequest {
  readonly dir: string;
  /** The remote URL without credentials: source for fetch, target for push. */
  readonly url: string;
  readonly credential: GitCredential;
  readonly signal?: AbortSignal;
}

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class GitService implements GitClient {
  readonly #options: GitServiceOptions;
  readonly #runner: GitRunner;
  readonly #logger: Logger;

  constructor(options: GitServiceOptions) {
    this.#options = options;
    this.#logger = options.logger ?? noopLogger;
    this.#runner = new GitRunner({
      scratchDir: options.scratchDir,
      logger: this.#logger,
      ...(options.stallTimeoutMs !== undefined ? { stallTimeoutMs: options.stallTimeoutMs } : {}),
      ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
    });
  }

  /** FAC-GIT-001: `git ls-remote --symref`, 1 quota unit. */
  async lsRemote(request: {
    url: string;
    credential: GitCredential;
    signal?: AbortSignal;
  }): Promise<GitLsRemoteResult> {
    const url = normalizeRemoteUrl(request.url);
    return this.#runner.withCredential(url, request.credential, async (context) => {
      await this.#options.quota.acquire(GIT_UNITS.lsRemote);
      return this.#lsRemote(context, url, request.signal);
    });
  }

  async #lsRemote(
    context: GitContext,
    url: string,
    signal?: AbortSignal,
  ): Promise<GitLsRemoteResult> {
    const result = await this.#runner.run(context, ['ls-remote', '--symref', '--', url], {
      cwd: this.#options.scratchDir,
      ...(signal !== undefined ? { signal } : {}),
    });
    return parseLsRemote(result.stdout);
  }

  /**
   * LIF-040 step 2: mirror-clones into scratch (3 units). An existing mirror (the step is being
   * resumed) is brought up to date instead; a clone interrupted earlier is thrown away.
   */
  async mirror(request: MirrorRequest): Promise<MirrorResult> {
    const url = normalizeRemoteUrl(request.url);
    return this.#runner.withCredential(
      url,
      request.credential,
      async (context) => {
        await this.#options.quota.acquire(GIT_UNITS.clone);
        const signal = request.signal;
        const common = signal !== undefined ? { signal } : {};
        const exists = await isDirectory(join(request.dir, 'objects'));
        if (exists) {
          await this.#runner.run(
            context,
            [
              'fetch',
              '--prune',
              '--force',
              '--update-head-ok',
              '--no-tags',
              '--progress',
              url,
              '+refs/*:refs/*',
            ],
            { cwd: request.dir, operation: 'fetch', ...common },
          );
        } else {
          const partial = `${request.dir}.partial`;
          await rm(partial, { recursive: true, force: true });
          await mkdir(dirname(request.dir), { recursive: true, mode: 0o700 });
          await this.#runner.run(context, ['clone', '--mirror', '--progress', '--', url, partial], {
            cwd: dirname(request.dir),
            operation: 'clone',
            ...common,
          });
          await rename(partial, request.dir);
        }
        return {
          dir: request.dir,
          updated: exists,
          sizeBytes: await this.#mirrorSize(request.dir),
        };
      },
      [[`remote.${GIT_REMOTE_SOURCE}.url`, url]],
    );
  }

  /**
   * Environment config for an LFS command. It pins the LFS endpoint to the remote's own
   * `<url>/info/lfs`: command-scope config beats a `.lfsconfig` committed in the repository, which
   * could otherwise redirect fetch or push to another repository. Lock verification is off (it is
   * an extra call that quota does not count and a push does not need).
   */
  #lfsConfig(remote: string, url: string): [string, string][] {
    const lfsUrl = `${url.replace(/\/$/, '')}/info/lfs`;
    return [
      [`remote.${remote}.url`, url],
      [`remote.${remote}.lfsurl`, lfsUrl],
      [`remote.${remote}.lfspushurl`, lfsUrl],
      ['lfs.allowincompletepush', 'false'],
      ['lfs.url', lfsUrl],
      ['lfs.pushurl', lfsUrl],
      [`lfs.${lfsUrl}.locksverify`, 'false'],
      ['lfs.concurrenttransfers', String(this.#options.lfsConcurrentTransfers ?? 8)],
    ];
  }

  async #mirrorSize(dir: string): Promise<number> {
    const result = await this.#runner.run(this.#runner.local(dir), ['count-objects', '-v'], {
      cwd: dir,
    });
    let kib = 0;
    for (const line of result.stdout.split('\n')) {
      const match = /^(size|size-pack|size-garbage): (\d+)$/.exec(line);
      if (match?.[1] !== undefined && match[1] !== 'size-garbage') kib += Number(match[2]);
    }
    return kib * 1024;
  }

  /** FAC-GIT-004: blob scan of everything reachable from branches and tags. No network. */
  async scanBlobs(request: {
    dir: string;
    maxBlobBytes?: number;
    warnBlobBytes?: number;
    signal?: AbortSignal;
  }): Promise<BlobScanResult> {
    return scanBlobs(this.#runner, this.#runner.local(request.dir), request);
  }

  /** LFS objects referenced by any ref of the mirror, with their sizes (LIF-040 step 2). */
  async listLfsObjects(dir: string, signal?: AbortSignal): Promise<LfsObject[]> {
    return listLfsObjects(this.#runner, this.#runner.local(dir), dir, signal);
  }

  /** `git lfs fetch --all` from the source; 1 quota unit per 100 objects not yet downloaded. */
  async fetchLfs(request: LfsRequest): Promise<LfsTransferResult> {
    const url = normalizeRemoteUrl(request.url);
    const objects = await this.listLfsObjects(request.dir, request.signal);
    return this.#runner.withCredential(
      url,
      request.credential,
      (context) =>
        fetchLfsObjects(this.#runner, context, {
          dir: request.dir,
          quota: this.#options.quota,
          objects,
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        }),
      this.#lfsConfig(GIT_REMOTE_SOURCE, url),
    );
  }

  /** LIF-040 step 4: `git lfs push --all` to the target; 1 quota unit per 100 objects. */
  async pushLfs(request: LfsRequest): Promise<LfsTransferResult> {
    const url = normalizeRemoteUrl(request.url);
    const objects = await this.listLfsObjects(request.dir, request.signal);
    return this.#runner.withCredential(
      url,
      request.credential,
      (context) =>
        pushLfsObjects(this.#runner, context, {
          dir: request.dir,
          quota: this.#options.quota,
          objects,
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        }),
      this.#lfsConfig(GIT_REMOTE_TARGET, url),
    );
  }

  /** LIF-044: batched push of branches and tags (never `refs/pull/*` and the like). */
  async pushRefs(request: PushRefsRequest): Promise<PushReport> {
    const maxPushBytes =
      request.maxPushBytes ?? this.#options.maxPushBytes ?? DEFAULT_MAX_PUSH_BYTES;
    const common = request.signal !== undefined ? { signal: request.signal } : {};
    const url = normalizeRemoteUrl(request.url);
    // Commands that read only the mirror run without a credential and without the stall watchdog.
    const mirror = this.#runner.local(request.dir);
    return this.#runner.withCredential(
      url,
      request.credential,
      async (context) => {
        const local = await this.#localRefs(mirror, request.dir);
        if (local.length === 0) return { pushes: [], upToDate: [] };
        await this.#options.quota.acquire(GIT_UNITS.lsRemote);
        const remote = await this.#lsRemote(context, url, request.signal);
        const remoteRefs = new Map<string, string>();
        const candidates = new Set<string>();
        for (const ref of remote.refs) {
          remoteRefs.set(ref.name, ref.sha);
          candidates.add(ref.sha);
          if (ref.peeled !== undefined) candidates.add(ref.peeled);
        }
        const knownShas = await this.#existing(mirror, request.dir, [...candidates]);
        const estimate = await this.#estimator(mirror, request.dir, request.signal);
        return pushBatched({
          refs: local,
          defaultBranch: request.defaultBranch,
          remoteRefs,
          knownShas,
          maxPushBytes,
          ...(request.onPush !== undefined ? { onPush: request.onPush } : {}),
          deps: {
            estimate,
            push: (refspecs) =>
              this.#push(
                context,
                request.dir,
                url,
                refspecs,
                request.force === true,
                request.signal,
              ),
            firstParentCommits: async (tip, exclude) => {
              const commits: string[] = [];
              const input = `${[tip, ...exclude.map((sha) => `^${sha}`)].join('\n')}\n`;
              await this.#runner.run(
                mirror,
                ['rev-list', '--first-parent', '--reverse', '--stdin'],
                {
                  cwd: request.dir,
                  input,
                  onStdoutLine: (line) => {
                    if (line !== '') commits.push(line);
                  },
                  operation: 'rev-list',
                  ...common,
                },
              );
              return commits;
            },
          },
        });
      },
      [[`remote.${GIT_REMOTE_TARGET}.url`, url]],
    );
  }

  /**
   * Deletes refs on the target (the `adoptNonEmpty` reconcile, LIF-043), in groups of 100. Only
   * fully qualified branch and tag names are accepted; the framework's own `git-migrator/`
   * branches are never deleted.
   */
  async deleteRefs(request: {
    dir: string;
    url: string;
    credential: GitCredential;
    refs: readonly string[];
    signal?: AbortSignal;
  }): Promise<void> {
    for (const ref of request.refs) assertDeletableRef(ref);
    const url = normalizeRemoteUrl(request.url);
    await this.#runner.withCredential(url, request.credential, async (context) => {
      for (let i = 0; i < request.refs.length; i += 100) {
        const group = request.refs.slice(i, i + 100).map((ref) => `:${ref}`);
        await this.#push(context, request.dir, url, group, true, request.signal);
      }
    });
  }

  async #localRefs(context: GitContext, dir: string): Promise<LocalRef[]> {
    const refs: LocalRef[] = [];
    await this.#runner.run(
      context,
      ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags'],
      {
        cwd: dir,
        onStdoutLine: (line) => {
          const space = line.indexOf(' ');
          if (space > 0) refs.push({ sha: line.slice(0, space), name: line.slice(space + 1) });
        },
      },
    );
    return refs;
  }

  /** The subset of `shas` present in the mirror. */
  async #existing(context: GitContext, dir: string, shas: readonly string[]): Promise<string[]> {
    if (shas.length === 0) return [];
    const present: string[] = [];
    await this.#runner.run(context, ['cat-file', '--batch-check'], {
      cwd: dir,
      input: `${shas.join('\n')}\n`,
      onStdoutLine: (line) => {
        const parts = line.split(' ');
        if (parts.length >= 3 && parts[0] !== undefined) present.push(parts[0]);
      },
    });
    return present;
  }

  async #estimator(
    context: GitContext,
    dir: string,
    signal: AbortSignal | undefined,
  ): Promise<PackEstimator> {
    const choice = this.#options.estimator;
    if (typeof choice === 'function') return choice;
    const mode = choice ?? (await detectEstimatorMode(this.#runner, context));
    return createPackEstimator(this.#runner, context, {
      dir,
      mode,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  /** One `git push` with up to `pushRetries` retries, backoff with full jitter (LIF-044, ADP-060). */
  async #push(
    context: GitContext,
    dir: string,
    url: string,
    refspecs: readonly string[],
    force: boolean,
    signal: AbortSignal | undefined,
  ): Promise<{ attempts: number }> {
    const retries = this.#options.pushRetries ?? 3;
    const base = this.#options.backoffBaseMs ?? 1000;
    const cap = this.#options.backoffCapMs ?? 60_000;
    const random = this.#options.random ?? Math.random;
    const sleep = this.#options.sleep ?? sleepFor;
    for (let attempt = 1; ; attempt++) {
      await this.#options.quota.acquire(GIT_UNITS.push);
      try {
        const result = await this.#runner.run(
          context,
          [
            '-c',
            'push.followTags=false',
            'push',
            '--porcelain',
            '--progress',
            '--no-verify',
            ...(force ? ['--force'] : []),
            '--',
            url,
            ...refspecs,
          ],
          {
            cwd: dir,
            operation: 'push',
            check: false,
            ...(signal !== undefined ? { signal } : {}),
          },
        );
        if (result.code !== 0) {
          // Per-ref rejections are on stdout (--porcelain); they are conflicts, not transient.
          const { klass, text } = classifyPushFailure(result.stdout, result.stderr);
          throw new GitCommandError({
            operation: 'push',
            exitCode: result.code,
            stderr: text,
            secrets: context.secrets,
            klass,
          });
        }
        return { attempts: attempt };
      } catch (error) {
        // Rate limits are never retried in process (ADP-060); the job is rescheduled (JOB-044).
        const retryable =
          isGitCommandError(error) && error.retryable && error.code !== 'rate_limited';
        if (!retryable || attempt > retries) throw error;
        const delay = Math.floor(random() * Math.min(cap, base * 2 ** (attempt - 1)));
        this.#logger.warn({ attempt, delayMs: delay, refs: refspecs.length }, 'git push retry');
        await sleep(delay);
      }
    }
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Throws unless `ref` is a valid branch or tag name the reconcile may delete. */
export function assertDeletableRef(ref: string): void {
  if (
    !/^refs\/(?:heads|tags)\/./.test(ref) ||
    !isValidRefName(ref) ||
    ref.startsWith('refs/heads/git-migrator/')
  ) {
    throw new AdapterError({
      code: 'invalid',
      provider: 'git',
      message: `Refusing to delete ref ${JSON.stringify(ref.slice(0, 200))}`,
    });
  }
}
