/** Helpers shared by the facet unit tests. Imported from *.test.ts files only. */
import {
  DEFAULT_ROUTE_POLICIES,
  type PrincipalRef,
  type PrincipalResolution,
  type TranslateEnvironment,
} from '@git-migrator/core';

/** Resolution table keyed `kind:id`; a principal not in the table is `unmapped`. */
export type ResolutionTable = Record<string, PrincipalResolution>;

export function envOf(table: ResolutionTable, acceptLossy: string[] = []): TranslateEnvironment {
  const resolver = {
    resolve: (p: PrincipalRef): PrincipalResolution =>
      table[`${p.kind}:${p.id}`] ?? { status: 'unmapped' },
  };
  return {
    identities: resolver,
    groups: resolver,
    policies: { ...DEFAULT_ROUTE_POLICIES, acceptLossy },
    route: {},
    routeIndex: {},
  };
}

export const identity = (id: string): PrincipalRef => ({ kind: 'identity', id });
export const group = (id: string): PrincipalRef => ({ kind: 'group', id });
export const mapped = (principal: PrincipalRef): PrincipalResolution => ({
  status: 'mapped',
  principal,
});

/** Small deterministic xorshift32 generator: `next(n)` is an integer in [0, n). */
export function prng(seed: number): (n: number) => number {
  let x = seed >>> 0 || 1;
  return (n) => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return Math.floor((x / 4294967296) * n);
  };
}

/** A random resolution table over `principals` (kind:id keys), drawn from `statuses`. */
export function randomTable(
  next: (n: number) => number,
  principals: readonly PrincipalRef[],
  statuses: readonly PrincipalResolution[],
): ResolutionTable {
  const table: ResolutionTable = {};
  for (const p of principals) {
    const st = statuses[next(statuses.length)];
    if (st !== undefined) table[`${p.kind}:${p.id}`] = st;
  }
  return table;
}

export const SAMPLE_STATUSES: readonly PrincipalResolution[] = [
  mapped(identity('x')),
  mapped(group('x')),
  mapped(group('b')),
  { status: 'excluded' },
  { status: 'pending_invite' },
  { status: 'unmapped' },
  { status: 'team_missing' },
];

/** Fisher–Yates shuffle driven by `next`; returns a new array. */
export function shuffle<T>(next: (n: number) => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = next(i + 1);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}
