/**
 * FAC-006 principal resolution, shared by the facets whose documents contain principals.
 * Pure: the resolvers come from the TranslateContext.
 */
import type { PrincipalRef } from '@git-migrator/canonical';
import {
  formatFieldPath,
  itemSeg,
  type PrincipalResolution,
  type TranslateContext,
} from '@git-migrator/core';

/** `kind:id`, the rendering used in field paths and finding params (ADP-020). */
export function principalLabel(p: PrincipalRef): string {
  return `${p.kind}:${p.id}`;
}

/**
 * Whether two principals are the same: identities by exact id, groups by id ignoring case (team
 * slugs are case-insensitive in the target; ADR-0106).
 */
export function samePrincipal(a: PrincipalRef, b: PrincipalRef): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'group' ? a.id.toLowerCase() === b.id.toLowerCase() : a.id === b.id;
}

/** Field path of one principal element of the collection at `parent` (e.g. `grants`). */
export function principalPath(collection: string, p: PrincipalRef): string {
  return formatFieldPath([itemSeg(collection, 'principal', principalLabel(p))]);
}

/**
 * Resolves a source principal through the Route's mappings: identities through `identities`,
 * groups through `groups`. A resolver answer that cannot apply to the kind (`team_missing` for an
 * identity) is treated as `unmapped`, so the principal is never silently dropped.
 */
export function resolvePrincipal(p: PrincipalRef, ctx: TranslateContext): PrincipalResolution {
  const r = (p.kind === 'group' ? ctx.groups : ctx.identities).resolve(p);
  if (r.status === 'team_missing' && p.kind !== 'group') return { status: 'unmapped' };
  return r;
}

/**
 * Shared `isTaskSatisfied` rule of the `<facet>.pending-invitation` tasks: `params.targetPrincipal`
 * (`kind:id`) names the principal the invitation resolves to, and the task is satisfied once the
 * target document holds it. Without that param the task cannot be judged and stays open.
 */
export function principalIsGranted(present: readonly PrincipalRef[], params: unknown): boolean {
  if (typeof params !== 'object' || params === null) return false;
  const wanted = (params as { targetPrincipal?: unknown }).targetPrincipal;
  return typeof wanted === 'string' && present.some((p) => principalLabel(p) === wanted);
}
