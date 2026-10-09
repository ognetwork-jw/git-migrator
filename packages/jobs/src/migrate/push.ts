/**
 * LIF-040 steps 4 and 5: `git.push-lfs` and `git.push-refs` (batched, LIF-044), then the default
 * branch. A push is a write to the target: an intent precedes it and a confirmation follows, and a
 * rejection for size becomes a run-origin blocker (LIF-042, LIF-049). With `adoptNonEmpty` the ref
 * push is a reconcile: every source ref is forced and target branches and tags the source lacks
 * are deleted, except `refs/heads/git-migrator/*` (LIF-043). Decisions:
 * docs/adr/0380-migration-steps.md.
 */

import { itemSeg, joinFieldPath } from '@git-migrator/core';
import { isGitCommandError, type PushEvent } from '@git-migrator/git';
import type { MutationLike, StepDefinition, StepResult } from '../run/types.ts';
import { ensureMirror } from './mirror.ts';
import {
  connectSide,
  gitCredentialOf,
  type MigrationContext,
  type MigrationServices,
} from './services.ts';
import { loadRunWorld, type RunWorld, targetOf } from './world.ts';

export const PUSH_REFS_BLOCKERS = ['git-refs.push-too-large'] as const;

const write = { side: 'target', origin: 'desired' } as const;

const refPath = (name: string) => joinFieldPath('', itemSeg('refs', 'name', name));

/** The branch to make the target's default: the source's, else `main`, else the first branch. */
export function chooseDefaultBranch(
  wanted: string | null | undefined,
  refs: readonly string[],
): string | undefined {
  const heads = refs
    .filter((r) => r.startsWith('refs/heads/'))
    .map((r) => r.slice('refs/heads/'.length));
  if (heads.length === 0) return undefined;
  if (wanted && heads.includes(wanted)) return wanted;
  if (heads.includes('main')) return 'main';
  return [...heads].sort()[0];
}

/** Step 4: `git lfs push --all` to the target. */
export function pushLfsStep(): StepDefinition<MigrationServices> {
  return {
    key: 'git.push-lfs',
    severity: 'fatal',
    async run(ctx): Promise<StepResult> {
      const world = await loadRunWorld(ctx);
      for (const intent of await ctx.ledger.openIntents()) {
        await ctx.ledger.confirm(intent.id, 'applied');
      }
      const source = await connectSide(ctx, world.sourceEndpointId, world.sourceType);
      const target = await connectSide(ctx, world.targetEndpointId, world.targetType);
      const dir = await ensureMirror(ctx, world, source);
      const objects = await source.git.listLfsObjects(dir, ctx.signal);
      if (objects.length === 0)
        return { status: 'skipped', reason: 'the repository has no LFS objects' };
      const { ref } = await targetOf(ctx, world);
      // Only what the target lacks is pushed (and recorded): a repeated Run changes nothing.
      const absent = await target.connection.lfs.missing(
        ref,
        objects.map((o) => o.oid),
      );
      if (absent.length === 0) {
        return { status: 'skipped', reason: 'every LFS object is on the target already' };
      }
      const { url, credential } = await gitCredentialOf(target, ref);
      const bytes = objects.reduce((sum, o) => sum + o.size, 0);
      const intentId = await ctx.ledger.intend(write, {
        facetKey: 'git-refs',
        action: 'update',
        resourceRef: { kind: 'lfs-push', repository: ref.slug },
        paths: ['/lfs'],
        before: null,
        after: { count: absent.length },
      });
      ctx.checkpoint();
      await target.git.pushLfs({ dir, url, credential, signal: ctx.signal });
      await ctx.ledger.confirm(intentId, 'applied');
      await ctx.runLog('info', 'Pushed the LFS objects', { count: absent.length, bytes });
      return { status: 'succeeded' };
    },
  };
}

/** Step 5: the batched push, the default branch, and with `adoptNonEmpty` the reconcile. */
export function pushRefsStep(): StepDefinition<MigrationServices> {
  return {
    key: 'git.push-refs',
    severity: 'fatal',
    clearsBlockers: PUSH_REFS_BLOCKERS,
    async run(ctx): Promise<StepResult> {
      const world = await loadRunWorld(ctx);
      // What a dead worker left open may have been applied; a push is idempotent either way.
      for (const intent of await ctx.ledger.openIntents()) {
        await ctx.ledger.confirm(intent.id, 'applied');
      }
      const source = await connectSide(ctx, world.sourceEndpointId, world.sourceType);
      const target = await connectSide(ctx, world.targetEndpointId, world.targetType);
      const dir = await ensureMirror(ctx, world, source);
      const { ref, record } = await targetOf(ctx, world);
      const { url, credential } = await gitCredentialOf(target, ref);
      const desired = world.facets.get('git-refs')?.desired as
        | { defaultBranch?: string | null; refs?: { name: string }[] }
        | undefined;
      const defaultBranch = chooseDefaultBranch(
        desired?.defaultBranch,
        (desired?.refs ?? []).map((r) => r.name),
      );
      if (defaultBranch === undefined) {
        await ctx.runLog(
          'warn',
          'The source has no branch, so nothing is pushed (git-refs.empty-repository)',
          {},
        );
        return { status: 'skipped', reason: 'the source repository has no branches' };
      }

      const intentId = await ctx.ledger.intend(write, {
        facetKey: 'git-refs',
        action: 'update',
        resourceRef: { kind: 'git-push', repository: ref.slug },
        paths: [],
        before: null,
        after: null,
      });
      ctx.checkpoint();
      const events: PushEvent[] = [];
      let report: Awaited<ReturnType<typeof target.git.pushRefs>>;
      try {
        report = await target.git.pushRefs({
          dir,
          url,
          credential,
          defaultBranch,
          force: world.adoptNonEmpty,
          signal: ctx.signal,
          onPush: (event) => {
            events.push(event);
          },
        });
      } catch (error) {
        await recordPushRejection(ctx, error);
        throw error;
      }
      for (const event of events) {
        await ctx.runLog('info', `Pushed ${event.refs.length} ref(s) (${event.kind})`, {
          estimatedBytes: event.estimatedBytes,
          attempts: event.attempts,
        });
      }
      const pushed = report.pushes.flatMap((p) => p.refs);
      const settled: MutationLike = {
        facetKey: 'git-refs',
        action: 'update',
        resourceRef: {
          kind: 'git-push',
          repository: ref.slug,
          ...(pushed.length === 0 ? { noop: true } : {}),
        },
        paths: [...new Set(pushed)].map(refPath),
        before: null,
        after: { pushes: report.pushes.length, upToDate: report.upToDate.length },
      };
      await ctx.ledger.confirm(intentId, 'applied', settled);

      await setDefaultBranch(ctx, target, ref, record.id, defaultBranch);

      if (world.adoptNonEmpty) {
        const local = new Set([...report.upToDate, ...pushed]);
        await reconcileExtras(ctx, target, { dir, url, credential }, local);
      }
      return { status: 'succeeded' };
    },
  };
}

/** LIF-042: a provider that refuses a single commit or a blob is a blocker of this repository. */
async function recordPushRejection(ctx: MigrationContext, error: unknown): Promise<void> {
  if (!isGitCommandError(error)) return;
  if (error.reason === 'push-too-large') {
    await ctx.findings.addBlocker({ code: 'git-refs.push-too-large', params: {} });
  } else if (error.reason === 'blob-too-large') {
    await ctx.findings.addBlocker({ code: 'git-refs.blob-too-large', params: {} });
  }
}

async function setDefaultBranch(
  ctx: MigrationContext,
  target: Awaited<ReturnType<typeof connectSide>>,
  ref: Awaited<ReturnType<typeof targetOf>>['ref'],
  repositoryRowId: string,
  branch: string,
): Promise<void> {
  const current = await target.connection.inventory.getRepository(ref);
  if (current?.defaultBranch !== branch) {
    const intentId = await ctx.ledger.intend(write, {
      facetKey: 'repository-settings',
      action: 'update',
      resourceRef: { kind: 'default-branch', repository: ref.slug },
      paths: ['/defaultBranch'],
      before: { defaultBranch: current?.defaultBranch ?? null },
      after: { defaultBranch: branch },
    });
    const record = await target.connection.refs.setDefaultBranch(ref, branch);
    await ctx.ledger.confirm(intentId, 'applied', record);
  }
  await ctx.transaction(async (tx) => {
    await tx.repository.update({ where: { id: repositoryRowId }, data: { defaultBranch: branch } });
  });
}

/** LIF-043: deletes target branches and tags the source does not have, except `git-migrator/*`. */
async function reconcileExtras(
  ctx: MigrationContext,
  target: Awaited<ReturnType<typeof connectSide>>,
  remote: {
    dir: string;
    url: string;
    credential: Awaited<ReturnType<typeof gitCredentialOf>>['credential'];
  },
  local: ReadonlySet<string>,
): Promise<void> {
  const listed = await target.git.lsRemote({
    url: remote.url,
    credential: remote.credential,
    signal: ctx.signal,
  });
  const extras = listed.refs
    .map((r) => r.name)
    .filter(
      (name) =>
        (name.startsWith('refs/heads/') || name.startsWith('refs/tags/')) &&
        !name.startsWith('refs/heads/git-migrator/') &&
        !local.has(name),
    );
  if (extras.length === 0) return;
  const intentId = await ctx.ledger.intend(write, {
    facetKey: 'git-refs',
    action: 'delete',
    // Deleted refs are not restored by rollback: the adopted repository's history is not ours.
    resourceRef: { kind: 'git-reconcile', noop: true },
    paths: extras.map(refPath),
    before: { refs: extras },
    after: { refs: extras },
  });
  await target.git.deleteRefs({
    dir: remote.dir,
    url: remote.url,
    credential: remote.credential,
    refs: extras,
    signal: ctx.signal,
  });
  await ctx.ledger.confirm(intentId, 'applied');
  await ctx.runLog('info', `Deleted ${extras.length} target ref(s) the source does not have`, {
    refs: extras.slice(0, 50),
  });
}

export type { RunWorld };
