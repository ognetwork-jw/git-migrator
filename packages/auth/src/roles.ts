import type { Config } from '@git-migrator/config';

/** The in-app roles, lowest first (AUTH-010: `admin > operator > viewer`). */
export type Role = Config['auth']['roleMappings'][number]['role'];
export type RoleMapping = Config['auth']['roleMappings'][number];

const RANK: Readonly<Record<Role, number>> = { viewer: 1, operator: 2, admin: 3 };

/** True when `a` outranks `b`. */
export function outranks(a: Role, b: Role): boolean {
  return RANK[a] > RANK[b];
}

function claimValues(claims: Readonly<Record<string, unknown>>, claim: string): readonly string[] {
  const raw = claims[claim];
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string');
  return [];
}

/**
 * AUTH-010: maps provider claims to an in-app role through `auth.roleMappings`. Only mappings of
 * `method` are considered. A mapping matches when the claim (a string or a list of strings)
 * contains `value` exactly. When several match, the highest role wins. Returns `undefined` when
 * nothing matches, which means the sign-in is denied.
 */
export function resolveRole(
  mappings: readonly RoleMapping[],
  method: string,
  claims: Readonly<Record<string, unknown>>,
): Role | undefined {
  let best: Role | undefined;
  for (const mapping of mappings) {
    if (mapping.method !== method) continue;
    if (!claimValues(claims, mapping.claim).includes(mapping.value)) continue;
    if (best === undefined || outranks(mapping.role, best)) best = mapping.role;
  }
  return best;
}

/** True when at least one mapping exists for `method`, so its Actors' roles are provider-owned. */
export function methodHasMappings(mappings: readonly RoleMapping[], method: string): boolean {
  return mappings.some((m) => m.method === method);
}
