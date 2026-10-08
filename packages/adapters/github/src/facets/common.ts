/** Helpers shared by the facet drivers. */
import type {
  ChangeRequestWriter,
  DriverContext,
  FacetTarget,
  GitAccess,
  MutationRecord,
  RepositoryRef,
} from '@git-migrator/adapter-sdk';
import { type FieldPath, formatFieldPath, itemSeg, seg } from '@git-migrator/core';
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
