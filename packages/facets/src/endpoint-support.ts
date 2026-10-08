/**
 * Helpers shared by the endpoint-level facets (members, teams, org-*). Pure, not exported from the
 * package. Decisions: docs/adr/0150-endpoint-facets-members-teams.md.
 */
import type { PrincipalRef } from '@git-migrator/canonical';
import {
  type DocumentSchema,
  diffDocuments,
  type FieldDiff,
  formatFieldPath,
  itemSeg,
  type PathSegment,
  type PrincipalResolution,
  type TranslateContext,
} from '@git-migrator/core';

/** `kind:id`, the rendering used in field paths and finding params (ADP-020). */
export function principalLabel(p: PrincipalRef): string {
  return `${p.kind}:${p.id}`;
}

/** Path segment of one principal element of the collection `collection` (e.g. `members`). */
export function principalSeg(collection: string, p: PrincipalRef): PathSegment {
  return itemSeg(collection, 'principal', principalLabel(p));
}

export function principalPath(collection: string, p: PrincipalRef): string {
  return formatFieldPath([principalSeg(collection, p)]);
}

/**
 * FAC-006: resolves a source principal through the Route's mappings (identities through
 * `identities`, groups through `groups`). `team_missing` cannot apply to an identity; it is treated
 * as `unmapped`, so a principal is never dropped silently.
 */
export function resolvePrincipal(p: PrincipalRef, ctx: TranslateContext): PrincipalResolution {
  const r = (p.kind === 'group' ? ctx.groups : ctx.identities).resolve(p);
  if (r.status === 'team_missing' && p.kind !== 'group') return { status: 'unmapped' };
  return r;
}

export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

/**
 * The endpoint is an organization that existed before the migration and keeps its own members,
 * teams, variables, secrets and hooks. git-migrator never removes any of them (AUTH-061), so what
 * exists only on the target is not a difference. A diff whose `desired` side is absent is a
 * target-only leaf (ADR-0150).
 */
export function diffDesiredOnly(
  desired: unknown,
  actual: unknown,
  schema: DocumentSchema,
): FieldDiff[] {
  return diffDocuments(desired, actual, schema).filter((d) => d.desired !== undefined);
}

/**
 * `ctx.routeIndex.targetOrgMembers`: ids of the identities that are already members of the target
 * organization (filled by the Analysis job). A principal outside this set must never be written as
 * a member or added to a team, because the write would invite it outside an approved Invitation
 * Batch (AUTH-061). Absent means nobody is known to be a member (fail closed). Malformed throws.
 */
export function targetOrgMembers(routeIndex: TranslateContext['routeIndex']): Set<string> {
  const configured = routeIndex.targetOrgMembers;
  if (configured === undefined) return new Set();
  if (!Array.isArray(configured) || configured.some((id) => typeof id !== 'string' || id === '')) {
    throw new TypeError('routeIndex.targetOrgMembers must be an array of target identity ids');
  }
  return new Set(configured as string[]);
}

/** A string-valued entry of a finding's params, or `undefined`. */
export function paramString(params: unknown, name: string): string | undefined {
  const v =
    typeof params === 'object' && params !== null
      ? (params as Record<string, unknown>)[name]
      : undefined;
  return typeof v === 'string' ? v : undefined;
}

/** A list-of-strings entry of a finding's params, or `undefined` when absent or malformed. */
export function paramStrings(params: unknown, name: string): string[] | undefined {
  const v =
    typeof params === 'object' && params !== null
      ? (params as Record<string, unknown>)[name]
      : undefined;
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
}

/** GitHub-style Actions names: upper-case identifiers that do not start with `GITHUB_` (FAC-VAR-003). */
export function isValidActionsName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(name) && !name.startsWith('GITHUB_');
}

export interface NamedItem {
  readonly name: string;
}

export interface NameTranslation<T extends NamedItem> {
  /** Valid, non-colliding items with their upper-cased name; `renamed` when the name changed. */
  readonly kept: (T & { renamed: boolean; sourceName: string })[];
  /** Source names that cannot be created on the target. */
  readonly invalid: string[];
}

/**
 * FAC-VAR-003 for org-level names: upper-case, then reject names that are not valid afterwards or
 * that collide with another item (every colliding item is rejected, so no choice between them is
 * made silently). Result order follows the upper-cased name.
 */
export function translateNames<T extends NamedItem>(items: readonly T[]): NameTranslation<T> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const upper = item.name.toUpperCase();
    groups.set(upper, [...(groups.get(upper) ?? []), item]);
  }
  const kept: NameTranslation<T>['kept'] = [];
  const invalid: string[] = [];
  for (const [upper, group] of [...groups].sort(([a], [b]) => compareCodeUnits(a, b))) {
    const first = group[0] as T;
    if (group.length > 1 || !isValidActionsName(upper)) {
      invalid.push(...group.map((g) => g.name));
      continue;
    }
    kept.push({ ...first, name: upper, renamed: upper !== first.name, sourceName: first.name });
  }
  return { kept, invalid: uniqueSorted(invalid) };
}
