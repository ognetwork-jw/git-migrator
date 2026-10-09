/** Helpers shared by the facet drivers. */
import {
  AdapterError,
  type ChangeRequestWriter,
  type DriverContext,
  type FacetTarget,
  type GitAccess,
  type MutationRecord,
  type RepositoryRef,
} from '@git-migrator/adapter-sdk';
import { type FieldPath, formatFieldPath, itemSeg, seg } from '@git-migrator/core';
import { Directory } from '../directory.ts';
import { type Collector, Gh } from '../gh.ts';

export interface DriverDeps {
  readonly org: string;
  readonly access: GitAccess;
  readonly changeRequests: ChangeRequestWriter;
}

export function ghOf(ctx: DriverContext, collector?: Collector): Gh {
  return new Gh(ctx.http, {
    pool: ctx.pool,
    signal: ctx.signal,
    ...(collector ? { collector } : {}),
  });
}

const undoDirectories = new WeakMap<DriverContext, Directory>();

/**
 * One Directory per driver context, for the undo of a Run: the context lives for one rollback
 * Step, so the organization's team list is read once for all its records (and forgotten by
 * `invalidateTeams` after a team is deleted).
 */
export function undoDirectory(ctx: DriverContext, org: string): Directory {
  let directory = undoDirectories.get(ctx);
  if (!directory) {
    directory = new Directory(ghOf(ctx), org);
    undoDirectories.set(ctx, directory);
  }
  return directory;
}

export function repoTarget(target: FacetTarget): RepositoryRef & { owner: string } {
  if (target.scope !== 'repository')
    throw new Error('repository-scope facet used at endpoint scope');
  return { ...target.repository, owner: target.namespace.slug };
}

export function orgTarget(target: FacetTarget): string {
  return target.namespace.slug;
}

export function mutation(
  facetKey: string,
  action: MutationRecord['action'],
  resourceRef: Record<string, unknown>,
  paths: readonly FieldPath[],
  before: unknown,
  after: unknown,
): MutationRecord {
  return { facetKey, action, resourceRef, paths, before: before ?? null, after: after ?? null };
}

export const itemPath = (collection: string, field: string, value: string, ...rest: string[]) =>
  formatFieldPath([itemSeg(collection, field, value), ...rest.map(seg)]);

export const fieldPath = (...names: string[]) => formatFieldPath(names.map(seg));

export function sortBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/**
 * Runs an undo call and treats "already gone" as done: a record may be an unconfirmed intent or a
 * second undo after a crash, so a missing resource is the state the undo wants (LIF-077, ADR-0342).
 */
export async function ignoreGone<T>(call: Promise<T>): Promise<T | undefined> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof AdapterError && error.code === 'not_found') return undefined;
    throw error;
  }
}

/**
 * Reads the team on `slug` just before an undo writes to it, and says whether it is still the team
 * with provider id `id` (the cached team list may be older than the write, ADR-0467 round 4). When
 * it is not, the cache is forgotten and the caller leaves the record (`group-changed`).
 */
export async function teamStillIs(
  ctx: DriverContext,
  directory: Directory,
  org: string,
  slug: string,
  id: string,
): Promise<boolean> {
  const now = await ghOf(ctx).getOrNull<Record<string, unknown>>(`/orgs/${org}/teams/${slug}`);
  const same = now !== null && String(now.id) === id && now.slug === slug;
  if (!same) directory.invalidateTeams();
  return same;
}

/** An `undo` for a record this driver did not yield (or an action it cannot revert). */
export function cannotUndo(record: MutationRecord): AdapterError {
  return new AdapterError({
    code: 'invalid',
    provider: 'github',
    message: `The ${record.facetKey ?? 'repository'} driver cannot undo a ${record.action} of ${String(record.resourceRef.kind)}`,
  });
}
