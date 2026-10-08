import type { PrincipalEntry } from '@git-migrator/canonical';
import type { FieldPath, Finding, TranslateContext } from '@git-migrator/core';

export const FACET = 'branch-rules';

type IssueKind = 'unmapped' | 'pending' | 'teamMissing';

/** Collects FAC-006 outcomes: one finding per principal (or group), listing every path it appears at. */
export class PrincipalIssues {
  readonly #byKind: Record<IssueKind, Map<string, { ref: string; paths: Set<FieldPath> }>> = {
    unmapped: new Map(),
    pending: new Map(),
    teamMissing: new Map(),
  };

  add(kind: IssueKind, principalKind: string, id: string, path: FieldPath): void {
    const ref = `${principalKind}:${id}`;
    const map = this.#byKind[kind];
    const entry = map.get(ref) ?? { ref, paths: new Set<FieldPath>() };
    entry.paths.add(path);
    map.set(ref, entry);
  }

  #findings(
    kind: IssueKind,
    code: string,
    params: (ref: string, id: string) => Record<string, unknown>,
  ): Finding[] {
    return [...this.#byKind[kind].values()]
      .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
      .map((e) => ({
        code,
        paths: [...e.paths].sort(),
        params: params(e.ref, e.ref.slice(e.ref.indexOf(':') + 1)),
      }));
  }

  /** Pre tasks: `suggested` and `unmapped` principals. */
  unmapped(): Finding[] {
    return this.#findings('unmapped', `${FACET}.unmapped-principal`, (ref) => ({
      facet: FACET,
      principal: ref,
    }));
  }

  /** Post tasks: `pending_invite` principals. */
  pending(): Finding[] {
    return this.#findings('pending', `${FACET}.pending-invitation`, (ref) => ({
      facet: FACET,
      principal: ref,
    }));
  }

  /** Blockers: groups without a created target team. */
  teamMissing(): Finding[] {
    return this.#findings('teamMissing', `${FACET}.team-missing`, (_ref, id) => ({ team: id }));
  }
}

/**
 * FAC-006 for one principal list: mapped principals become target principals, the rest are omitted
 * and recorded in `issues` (an `excluded` one needs no finding, AUTH-050 holds its Expected Difference).
 */
export function resolvePrincipals(
  entries: readonly PrincipalEntry[],
  path: FieldPath,
  ctx: TranslateContext,
  issues: PrincipalIssues,
): PrincipalEntry[] {
  const out: PrincipalEntry[] = [];
  for (const { principal } of entries) {
    const resolver = principal.kind === 'group' ? ctx.groups : ctx.identities;
    const res = resolver.resolve(principal);
    switch (res.status) {
      case 'mapped':
        out.push({ principal: { kind: res.principal.kind, id: res.principal.id } });
        break;
      case 'excluded':
        break;
      case 'pending_invite':
        issues.add('pending', principal.kind, principal.id, path);
        break;
      case 'unmapped':
        issues.add('unmapped', principal.kind, principal.id, path);
        break;
      case 'team_missing':
        issues.add('teamMissing', principal.kind, principal.id, path);
        break;
    }
  }
  return out;
}
