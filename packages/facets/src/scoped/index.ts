/**
 * Helpers shared by the variables and secrets facets (FAC-VAR, FAC-SEC). Pure, not exported from
 * the package. Decisions: docs/adr/0145-environments-variables-secrets-facets.md.
 */
import { scopedKey } from '@git-migrator/canonical';
import type { TranslateContext } from '@git-migrator/core';

export const REPOSITORY_SCOPE = 'repository';
const ENVIRONMENT_PREFIX = 'environment:';

/** FAC-VAR-003: the target accepts upper-case identifiers that do not start with `GITHUB_`. */
export function isValidTargetName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(name) && !name.startsWith('GITHUB_');
}

/** The environment name of an `environment:<name>` scope, or `null` for the repository scope. */
export function environmentOf(scope: string): string | null {
  return scope.startsWith(ENVIRONMENT_PREFIX) ? scope.slice(ENVIRONMENT_PREFIX.length) : null;
}

export function environmentScope(name: string): string {
  return `${ENVIRONMENT_PREFIX}${name}`;
}

/** Case-insensitive identity of a scope: the target does not tell environments apart by case. */
export function foldScope(scope: string): string {
  return scope.toLowerCase();
}

/**
 * Environment names of the translated `environments` document by folded name, so that a scope that
 * differs only by case maps to the environment that will exist on the target.
 */
export function targetEnvironments(ctx: TranslateContext): Map<string, string> {
  const map = new Map<string, string>();
  const desired = ctx.deps.environments?.desired as
    | { environments?: readonly { name: string }[] }
    | undefined;
  for (const e of desired?.environments ?? []) map.set(e.name.toLowerCase(), e.name);
  return map;
}

/** Rewrites `environment:<name>` to the casing the target environment has; others are unchanged. */
export function alignScope(scope: string, environments: ReadonlyMap<string, string>): string {
  const env = environmentOf(scope);
  if (env === null) return scope;
  const known = environments.get(env.toLowerCase());
  return known === undefined ? scope : environmentScope(known);
}

export interface ScopedItem {
  scope: string;
  name: string;
}

export interface ScopedTranslation {
  /** Valid, non-colliding items with target scope and name, sorted by key. */
  kept: (ScopedItem & { key: string; sourceKey: string; renamed: boolean })[];
  /** Source keys that cannot be created on the target, with their source names. */
  invalid: { key: string; name: string }[];
}

/**
 * FAC-VAR-003: upper-case the name, align the scope's environment casing, and reject names that
 * are not valid after that, or that collide with another item (every colliding item is rejected,
 * so no choice between them is made silently).
 */
export function translateScoped(
  items: readonly (ScopedItem & { key: string })[],
  environments: ReadonlyMap<string, string>,
): ScopedTranslation {
  const groups = new Map<string, (typeof items)[number][]>();
  for (const item of items) {
    const id = scopedKey(foldScope(alignScope(item.scope, environments)), item.name.toUpperCase());
    groups.set(id, [...(groups.get(id) ?? []), item]);
  }
  const kept: ScopedTranslation['kept'] = [];
  const invalid: ScopedTranslation['invalid'] = [];
  for (const group of groups.values()) {
    const [first] = group;
    if (first === undefined) continue;
    const upper = first.name.toUpperCase();
    if (group.length > 1 || !isValidTargetName(upper)) {
      for (const i of group) invalid.push({ key: i.key, name: i.name });
      continue;
    }
    const scope = alignScope(first.scope, environments);
    kept.push({
      scope,
      name: upper,
      key: scopedKey(scope, upper),
      sourceKey: first.key,
      renamed: upper !== first.name,
    });
  }
  const byKey = (a: { key: string }, b: { key: string }) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  return { kept: kept.sort(byKey), invalid: invalid.sort(byKey) };
}

/**
 * Rewrites the scope (and key) of `actual` items whose folded scope or name equals a desired one to
 * the desired spelling, so a case difference alone is never reported as drift.
 */
export function alignToDesired<T extends ScopedItem & { key: string }>(
  desired: readonly T[],
  actual: readonly T[],
): T[] {
  const byFold = new Map(desired.map((d) => [foldScope(d.key), d]));
  return actual.map((a) => {
    const d = byFold.get(foldScope(a.key));
    return d === undefined ? a : { ...a, scope: d.scope, name: d.name, key: d.key };
  });
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
