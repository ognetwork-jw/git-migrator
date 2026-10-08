import type { AccessControl, CodeOwnership, Members, Teams } from '@git-migrator/canonical';
import {
  DEFAULT_ROUTE_POLICIES,
  FacetRegistry,
  type PrincipalRef,
  type PrincipalResolution,
  translateAll,
} from '@git-migrator/core';
import {
  accessControl,
  codeOwnership,
  membersDefinition,
  teamsDefinition,
} from '@git-migrator/facets';
import { describe, expect, it } from 'vitest';

// The contract between `teams` and the facets that read `ctx.deps.teams` (ADR-0150, ADR-0106),
// checked by running the real facets through the engine together.
const registry = new FacetRegistry()
  .register(membersDefinition)
  .register(teamsDefinition)
  .register(accessControl)
  .register(codeOwnership);

const identity = (id: string): PrincipalRef => ({ kind: 'identity', id });
const group = (id: string): PrincipalRef => ({ kind: 'group', id });
const mapped = (principal: PrincipalRef): PrincipalResolution => ({ status: 'mapped', principal });

const table: Record<string, PrincipalResolution> = {
  'group:Dev_Team': mapped(group('dev-team')),
  'identity:u1': mapped(identity('gh1')),
  'identity:u2': { status: 'pending_invite' },
  'identity:u3': mapped(identity('gh3')), // confirmed, not yet an org member
  'identity:u4': mapped(identity('gh4')), // org member, not in the team
};
const resolver = {
  resolve: (p: PrincipalRef) => table[`${p.kind}:${p.id}`] ?? { status: 'unmapped' as const },
};

function run(owners: string[], teamMembers = ['u1', 'u2', 'u3']) {
  const members: Members = {
    members: ['u1', 'u2', 'u3', 'u4'].map((id) => ({ principal: identity(id), role: 'member' })),
  };
  const teams: Teams = {
    teams: [
      {
        slug: 'Dev_Team',
        name: 'Dev Team',
        members: teamMembers.map((id) => ({ principal: identity(id) })),
      },
    ],
  };
  const acl: AccessControl = { grants: [{ principal: group('Dev_Team'), role: 'write' }] };
  const code: CodeOwnership = {
    owners: [{ pattern: '*', principals: owners.map((id) => ({ principal: identity(id) })) }],
  };
  const { translations } = translateAll(registry, {
    env: {
      identities: resolver,
      groups: resolver,
      policies: DEFAULT_ROUTE_POLICIES,
      route: {},
      routeIndex: { targetOrgMembers: ['gh1', 'gh4'] },
    },
    sources: { members, teams, 'access-control': acl, 'code-ownership': code },
  });
  const by = (key: string) => {
    const found = translations.find((t) => t.facetKey === key);
    if (found === undefined) throw new Error(`${key} was not translated`);
    return found;
  };
  return { teams: by('teams').desired as Teams, code: by('code-ownership') };
}

describe('teams and code-ownership through the engine together', () => {
  it('[FAC-END] the desired team slug equals the group resolved target id', () => {
    const { teams } = run(['u1']);
    expect(teams.teams.map((t) => t.slug)).toEqual(['dev-team']);
  });

  it('[FAC-END] skipped members (pending, not in the org) are left out of the desired team', () => {
    const { teams } = run(['u1']);
    expect(teams.teams[0]?.members).toEqual([{ principal: identity('gh1') }]);
  });

  it('[FAC-COD] an owner who is in the team through its grant is kept', () => {
    const { code } = run(['u1']);
    expect((code.desired as CodeOwnership).owners[0]?.principals).toEqual([
      { principal: identity('gh1') },
    ]);
  });

  it('[FAC-COD] an owner whose membership was skipped is kept and flagged as unknown, never dropped', () => {
    const { code } = run(['u3']);
    expect((code.desired as CodeOwnership).owners[0]?.principals).toEqual([
      { principal: identity('gh3') },
    ]);
    expect(code.warnings.map((w) => w.code)).toContain('code-ownership.team-membership-unknown');
  });

  it('[FAC-COD] an owner who is plainly not in the team lacks write access and is omitted', () => {
    const { code } = run(['u4'], ['u1']);
    expect((code.desired as CodeOwnership).owners).toEqual([]);
    expect(code.decisions.map((d) => d.policyKey)).toContain(
      'code-ownership.owner-insufficient-access',
    );
  });
});
