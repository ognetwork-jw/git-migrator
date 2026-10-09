/**
 * Source read-only (LIF-070, LIF-045): a `push` restriction on `*` with no users or groups, and a
 * description prefix. The repository update endpoint can also create or rename a repository
 * (ADR-0036 item 10), so every description write is guarded: a successful `GET` of the same slug
 * immediately before, a body with only `description`, a `GET` afterwards, and a restore plus a
 * failed step if identity fields changed.
 */
import {
  AdapterError,
  type FacetTarget,
  type Logger,
  type MutationRecord,
  type ProviderHttpClient,
  type RepositoryRef,
  type SourceLock,
} from '@git-migrator/adapter-sdk';
import { formatFieldPath, itemSeg, seg } from '@git-migrator/core';
import { z } from 'zod';
import { getOne, listAll, obj, parse, type Repository, repository } from './api.ts';
import { PROVIDER } from './config.ts';
import { restriction } from './mappers.ts';
import type { Ctx, Reader } from './reader.ts';

const PREFIX_RE = /^\[MIGRATED → [^\]\r\n]*\] /;
export const RESTRICTION_TYPE = 'branch-restriction';
export const DESCRIPTION_TYPE = 'repository-description';
const ROOT_PATTERN = '*';

/** Carries the mutations already made when a later step of `apply` fails, so they can be recorded. */
export class SourceLockPartialError extends AdapterError {
  readonly mutations: readonly MutationRecord[];
  /** Writes whose outcome could not be read back: they may have been applied (ADR-0222). */
  readonly possiblyApplied: readonly string[];
  constructor(
    message: string,
    mutations: readonly MutationRecord[],
    code:
      | 'conflict'
      | 'invalid'
      | 'transient'
      | 'forbidden'
      | 'not_found'
      | 'unauthorized'
      | 'rate_limited'
      | 'unsupported'
      | 'blocked_by_provider' = 'conflict',
    cause?: unknown,
    possiblyApplied: readonly string[] = [],
  ) {
    super({ code, provider: PROVIDER, message, ...(cause !== undefined ? { cause } : {}) });
    this.name = 'SourceLockPartialError';
    this.mutations = mutations;
    this.possiblyApplied = possiblyApplied;
  }
}

/**
 * The ids of the branch restrictions of `slug` that the framework created or holds as the source
 * lock, from the `resourceRef`s the framework hands to a source read (LIF-045). Adopted ones count:
 * a lock-shaped restriction the framework found there is the lock as far as translation goes.
 */
export function frameworkRestrictionIds(target: FacetTarget, slug: string): Set<number> {
  const ids = new Set<number>();
  const own = target.scope === 'repository' ? (target.frameworkResources ?? []) : [];
  for (const ref of own) {
    if (ref.type === RESTRICTION_TYPE && ref.repository === slug && typeof ref.id === 'number') {
      ids.add(ref.id);
    }
  }
  return ids;
}

/** The description `originals` hold for `slug`, if any (see `SourceLock.originals`). */
function originalDescription(
  originals: readonly MutationRecord[] | undefined,
  slug: string,
): string | undefined {
  const found = (originals ?? []).find(
    (o) => o.resourceRef.type === DESCRIPTION_TYPE && o.resourceRef.repository === slug,
  );
  const text = (found?.after as { description?: unknown } | null | undefined)?.description;
  return typeof text === 'string' ? text : undefined;
}

export function migrationPrefix(targetWebUrl: string): string {
  let url: URL;
  try {
    url = new URL(targetWebUrl);
  } catch {
    throw new AdapterError({
      code: 'invalid',
      provider: PROVIDER,
      message: 'targetWebUrl is not a URL',
    });
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new AdapterError({
      code: 'invalid',
      provider: PROVIDER,
      message: 'targetWebUrl must be an http(s) URL without credentials',
    });
  }
  return `[MIGRATED → ${url.origin}${url.pathname}] `;
}

const created = obj({ id: z.number() });

function identity(repo: Repository) {
  return {
    is_private: repo.is_private,
    fork_policy: repo.fork_policy ?? null,
    project: repo.project?.key ?? null,
    name: repo.name,
    mainbranch: repo.mainbranch?.name ?? null,
  };
}

export function createSourceLock(options: {
  reader: Reader;
  http: ProviderHttpClient;
  ctxOf: () => Ctx;
  logger: Logger;
}): SourceLock {
  const { reader, http } = options;
  const ctx = () => options.ctxOf();
  const req = (signal?: AbortSignal) => ({
    http,
    ctx: signal === undefined ? ctx() : { ...ctx(), signal },
  });
  /** Read-backs after an ambiguous write must survive a cancelled Run (ADR-0222). */
  const readBackSignal = () => AbortSignal.timeout(30_000);

  const fresh = async (slug: string, signal?: AbortSignal): Promise<Repository> => {
    const { data } = await getOne(req(signal), reader.repoPath(slug), repository, 'repository', {
      capture: false,
    });
    return data as Repository;
  };

  /** PUT `description` only, then verify identity; returns the repository after the write. */
  const putDescription = async (
    slug: string,
    before: Repository,
    description: string,
    onWritten: () => void = () => {},
    onUnknown: () => void = () => {},
  ) => {
    const c = ctx();
    try {
      await http.request({
        method: 'PUT',
        path: reader.repoPath(slug),
        json: { description },
        pool: c.pool,
        signal: c.signal,
        retry: false,
      });
    } catch (error) {
      // The response may have been lost after the provider applied the write: read it back and
      // report the change so the ledger (and undo) knows about it.
      const now = await fresh(slug, readBackSignal()).catch(() => undefined);
      if (now === undefined) onUnknown();
      else if ((now.description ?? '') === description) onWritten();
      throw error;
    }
    onWritten();
    let after: Repository;
    try {
      after = await fresh(slug);
    } catch (error) {
      throw new AdapterError({
        code: 'conflict',
        provider: PROVIDER,
        message:
          'The repository could not be read after the description update; check that it still exists under the same name',
        cause: error,
      });
    }
    const was = identity(before);
    const now = identity(after);
    const changed = (Object.keys(was) as (keyof typeof was)[]).filter((k) => was[k] !== now[k]);
    if (changed.length === 0) return after;
    if (changed.includes('name')) {
      throw new AdapterError({
        code: 'conflict',
        provider: PROVIDER,
        message: 'The description update changed the repository name; it needs a manual repair',
      });
    }
    const restore: Record<string, unknown> = {};
    if (changed.includes('is_private')) restore.is_private = was.is_private;
    if (changed.includes('fork_policy') && was.fork_policy !== null)
      restore.fork_policy = was.fork_policy;
    if (changed.includes('project') && was.project !== null) restore.project = { key: was.project };
    if (changed.includes('mainbranch') && was.mainbranch !== null) {
      restore.mainbranch = { name: was.mainbranch };
    }
    if (Object.keys(restore).length > 0) {
      await http.request({
        method: 'PUT',
        path: reader.repoPath(slug),
        json: restore,
        pool: c.pool,
        signal: c.signal,
        retry: false,
      });
    }
    throw new AdapterError({
      code: 'conflict',
      provider: PROVIDER,
      message: `The description update changed ${changed.join(', ')}; the previous values were restored`,
    });
  };

  const restrictionPath = (slug: string) => `${reader.repoPath(slug)}/branch-restrictions`;

  const restrictionRecord = (slug: string, id: number, adopted = false): MutationRecord => ({
    facetKey: 'branch-rules',
    action: 'create',
    resourceRef: {
      type: RESTRICTION_TYPE,
      repository: slug,
      id,
      ...(adopted ? { adopted: true } : {}),
    },
    paths: [formatFieldPath([itemSeg('rules', 'pattern', '**'), seg('restrictPushes')])],
    before: null,
    after: { kind: 'push', pattern: ROOT_PATTERN, users: [], groups: [] },
  });

  return {
    async apply(
      ref: RepositoryRef,
      lock: { targetWebUrl: string; originals?: readonly MutationRecord[] },
    ): Promise<MutationRecord[]> {
      const slug = ref.slug;
      const prefix = migrationPrefix(lock.targetWebUrl);
      const original = originalDescription(lock.originals, slug);
      // GET first, in this step: a missing repository is never written (it would be created).
      await fresh(slug);
      const done: MutationRecord[] = [];
      const possibly: string[] = [];
      try {
        const find = async (signal?: AbortSignal) =>
          (
            await listAll(
              req(signal),
              restrictionPath(slug),
              restriction,
              'branch restrictions',
              { kind: 'push', pattern: ROOT_PATTERN },
              { capture: false },
            )
          ).items.filter(
            (r) =>
              r.kind === 'push' &&
              r.pattern === ROOT_PATTERN &&
              (r.branch_match_kind ?? 'glob') === 'glob' &&
              (r.users ?? []).length === 0 &&
              (r.groups ?? []).length === 0,
          );
        const present = await find();
        if (present[0] !== undefined) {
          // Already there: nothing is written and undo will not touch it (ownership is never inferred).
          done.push(restrictionRecord(slug, present[0].id, true));
        } else {
          const c = ctx();
          try {
            const res = await http.request({
              method: 'POST',
              path: restrictionPath(slug),
              json: {
                kind: 'push',
                pattern: ROOT_PATTERN,
                branch_match_kind: 'glob',
                users: [],
                groups: [],
              },
              pool: c.pool,
              signal: c.signal,
              retry: false,
            });
            done.push(restrictionRecord(slug, parse(created, res.body, 'branch restriction').id));
          } catch (error) {
            // Ambiguous failure: if the restriction exists now, record it before failing.
            const found = await find(readBackSignal()).catch(() => undefined);
            if (found === undefined) possibly.push(RESTRICTION_TYPE);
            else if (found[0] !== undefined) done.push(restrictionRecord(slug, found[0].id));
            throw error;
          }
        }
        // Re-read right before writing, so an edit made during this apply is not overwritten.
        const latest = await fresh(slug);
        const current = latest.description ?? '';
        if (current.startsWith(prefix)) {
          // Pre-existing: not ours. Nothing is written and undo leaves it alone (ADR-0222).
          done.push({
            facetKey: 'repository-settings',
            action: 'update',
            resourceRef: { type: DESCRIPTION_TYPE, repository: slug, adopted: true },
            paths: ['/description'],
            before: { description: current },
            after: { description: current },
          });
        } else {
          if (original !== undefined && current !== original) {
            // Changed since the baseline: a write now could not be told from that change after a
            // crash, so nothing is written (the restriction above is still recorded).
            throw new AdapterError({
              code: 'conflict',
              provider: PROVIDER,
              message:
                'The repository description changed while the source was being locked; run the lock again',
            });
          }
          const next = `${prefix}${current.replace(PREFIX_RE, '')}`;
          // Recorded as soon as the write happened, even if the verification then fails.
          await putDescription(
            slug,
            latest,
            next,
            () =>
              done.push({
                facetKey: 'repository-settings',
                action: 'update',
                resourceRef: { type: DESCRIPTION_TYPE, repository: slug },
                paths: ['/description'],
                before: { description: current },
                after: { description: next },
              }),
            () => possibly.push(DESCRIPTION_TYPE),
          );
        }
      } catch (error) {
        if (
          (done.length === 0 && possibly.length === 0) ||
          error instanceof SourceLockPartialError
        ) {
          throw error;
        }
        const base = error instanceof AdapterError ? error : undefined;
        throw new SourceLockPartialError(
          base?.message ?? 'Source read-only failed after some changes',
          done,
          base?.code ?? 'conflict',
          error,
          possibly,
        );
      }
      return done;
    },

    async originals(ref: RepositoryRef): Promise<MutationRecord[]> {
      const slug = ref.slug;
      const current = (await fresh(slug)).description ?? '';
      return [
        {
          facetKey: 'repository-settings',
          action: 'update',
          resourceRef: { type: DESCRIPTION_TYPE, repository: slug },
          paths: ['/description'],
          before: null,
          after: { description: current },
        },
      ];
    },

    async inspect(
      ref: RepositoryRef,
      inspectOptions?: { originals?: readonly MutationRecord[] },
    ): Promise<MutationRecord[]> {
      const slug = ref.slug;
      const out: MutationRecord[] = [];
      const present = (
        await listAll(
          req(),
          restrictionPath(slug),
          restriction,
          'branch restrictions',
          { kind: 'push', pattern: ROOT_PATTERN },
          { capture: false },
        )
      ).items.filter(
        (r) =>
          r.kind === 'push' &&
          r.pattern === ROOT_PATTERN &&
          (r.branch_match_kind ?? 'glob') === 'glob' &&
          (r.users ?? []).length === 0 &&
          (r.groups ?? []).length === 0,
      );
      for (const r of present) {
        const rec = restrictionRecord(slug, r.id);
        out.push({ ...rec, resourceRef: { ...rec.resourceRef, possiblyFramework: true } });
      }
      const current = (await fresh(slug)).description ?? '';
      if (PREFIX_RE.test(current)) {
        // The original comes from the baseline, never from stripping what is there now (the
        // original may itself carry a prefix). It explains the current text only if the lock
        // written over it (`prefix + original without its prefix`) leaves the same body.
        const original = originalDescription(inspectOptions?.originals, slug);
        const explained =
          original !== undefined &&
          current.replace(PREFIX_RE, '') === original.replace(PREFIX_RE, '');
        out.push({
          facetKey: 'repository-settings',
          action: 'update',
          resourceRef: { type: DESCRIPTION_TYPE, repository: slug, possiblyFramework: true },
          paths: ['/description'],
          before: explained ? { description: original } : null,
          after: { description: current },
        });
      }
      return out;
    },

    async undo(ref: RepositoryRef, mutations: MutationRecord[]): Promise<MutationRecord[]> {
      const slug = ref.slug;
      const out: MutationRecord[] = [];
      for (const m of [...mutations].reverse()) {
        const type = m.resourceRef.type;
        if (m.resourceRef.repository !== slug) {
          throw new AdapterError({
            code: 'invalid',
            provider: PROVIDER,
            message: 'Mutation belongs to a different repository',
          });
        }
        if (m.resourceRef.adopted === true) {
          // Pre-existing state the framework did not create: never deleted or stripped.
          options.logger.warn(
            { repository: slug, type },
            'source read-only state was already present before this Run; undo leaves it in place',
          );
          out.push({ ...m, before: m.after });
          continue;
        }
        if (type === RESTRICTION_TYPE) {
          const id = m.resourceRef.id;
          if (typeof id !== 'number' || !Number.isInteger(id)) {
            throw new AdapterError({
              code: 'invalid',
              provider: PROVIDER,
              message: 'Mutation has no restriction id',
            });
          }
          const c = ctx();
          try {
            await http.request({
              method: 'DELETE',
              path: `${restrictionPath(slug)}/${id}`,
              pool: c.pool,
              signal: c.signal,
              retry: false,
            });
          } catch (error) {
            if (!(error instanceof AdapterError && error.code === 'not_found')) throw error;
          }
          out.push({ ...m, action: 'delete', before: m.after, after: null });
        } else if (type === DESCRIPTION_TYPE) {
          const was = (m.after as { description?: unknown } | null)?.description;
          const original = (m.before as { description?: unknown } | null)?.description;
          if (typeof was !== 'string' || typeof original !== 'string') {
            throw new AdapterError({
              code: 'invalid',
              provider: PROVIDER,
              message: 'Mutation has no description',
            });
          }
          const before = await fresh(slug);
          const current = before.description ?? '';
          if (current === original) {
            // Already the original (a repeated undo): nothing to revert, and a prefix that was part
            // of the original description is not ours to strip.
            out.push({
              ...m,
              action: 'update',
              before: { description: current },
              after: { description: current },
            });
            continue;
          }
          // Restore the original when untouched, else only remove our prefix (later edits stay).
          const next = current === was ? original : current.replace(PREFIX_RE, '');
          if (next !== current) await putDescription(slug, before, next);
          out.push({
            ...m,
            action: 'update',
            before: { description: current },
            after: { description: next },
          });
        } else {
          throw new AdapterError({
            code: 'invalid',
            provider: PROVIDER,
            message: 'Unknown source-lock mutation',
          });
        }
      }
      return out;
    },
  };
}
