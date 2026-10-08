import {
  type BranchRule,
  type BranchRules,
  branchRuleApplyOrder,
  branchRulesFacet,
  type PrincipalEntry,
} from '@git-migrator/canonical';
import {
  compareFacet,
  type FacetCapability,
  FacetRegistry,
  type FieldDecision,
  formatFieldPath,
  type IdentityResolver,
  itemSeg,
  NO_CAPABILITY,
  type PrincipalRef,
  type PrincipalResolution,
  parseFieldPath,
  resolveRoutePolicies,
  satisfiedTasks,
  seg,
  type TranslateEnvironment,
  translateFacet,
} from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import {
  BRANCH_RULES_POLICY,
  branchRulesDefinition,
  compareBranchRules,
  convertPattern,
  normalizeBranchRules,
  normalizeRule,
  translateBranchRules,
} from './index.ts';
import { covers } from './overlap.ts';

// -- fixtures ---------------------------------------------------------------------------------

type ChangeRequest = NonNullable<BranchRule['changeRequest']>;

const rule = (o: Partial<BranchRule> = {}): BranchRule => ({
  pattern: 'main',
  enforcement: 'enforced',
  restrictPushes: null,
  restrictMerges: null,
  blockForcePush: false,
  forcePushExempt: [],
  blockDeletion: false,
  deletionExempt: [],
  changeRequest: null,
  ...o,
});

const cr = (o: Partial<ChangeRequest> = {}): ChangeRequest => ({
  minApprovals: 0,
  requireCodeOwnerApproval: false,
  dismissStaleApprovals: false,
  requireNoChangesRequested: false,
  requireTasksResolved: false,
  requireUpToDate: false,
  minPassingBuilds: 0,
  ...o,
});

const user = (id: string): PrincipalEntry => ({ principal: { kind: 'identity' as const, id } });
const group = (id: string): PrincipalEntry => ({ principal: { kind: 'group' as const, id } });
const doc = (...rules: BranchRule[]): BranchRules => ({ rules });

/** Maps `kind:id` to the same kind with id `t-<id>` unless an outcome is given. */
function resolver(outcomes: Record<string, PrincipalResolution['status']> = {}): IdentityResolver {
  return {
    resolve(p: PrincipalRef): PrincipalResolution {
      const status = outcomes[`${p.kind}:${p.id}`] ?? 'mapped';
      if (status === 'mapped') return { status, principal: { kind: p.kind, id: `t-${p.id}` } };
      return { status } as PrincipalResolution;
    },
  };
}

function env(
  o: { outcomes?: Record<string, PrincipalResolution['status']>; accept?: string[] } = {},
): TranslateEnvironment {
  const r = resolver(o.outcomes);
  return {
    identities: r,
    groups: r,
    policies:
      o.accept === undefined
        ? resolveRoutePolicies()
        : resolveRoutePolicies({ acceptLossy: o.accept }),
    route: {},
    routeIndex: {},
  };
}

const registry = new FacetRegistry().register(branchRulesDefinition);

function run(
  source: BranchRules,
  o: Parameters<typeof env>[0] & { targetCaps?: FacetCapability } = {},
) {
  return translateFacet(registry, 'branch-rules', source, {
    env: env(o),
    targetCaps: o.targetCaps,
  });
}

const NONE_ACCEPTED = { accept: [] as string[] };

function decision(t: ReturnType<typeof run>, path: string): FieldDecision | undefined {
  return t.decisions.find((d) => d.path === path);
}

const desiredRule = (t: ReturnType<typeof run>, i = 0): BranchRule =>
  (t.desired as BranchRules).rules[i] as BranchRule;

const P = '/rules[pattern=main]';

const at = (pattern: string, ...names: string[]) =>
  formatFieldPath([itemSeg('rules', 'pattern', pattern), ...names.map(seg)]);

// -- registration, guidance and schema (FAC-001, FAC-002, ADP-030) ----------------------------

describe('branch-rules definition', () => {
  it('[ADP-030] [FAC-001] registers and declares the canonical schema and collections', () => {
    expect(registry.get('branch-rules')).toBe(branchRulesDefinition);
    expect(branchRulesDefinition.schema).toBe(branchRulesFacet.schema);
    expect(branchRulesDefinition.collections).toEqual(branchRulesFacet.collections);
    expect(branchRulesDefinition.dependsOn).toEqual(['git-refs', 'access-control']);
    expect(branchRulesDefinition.compareMode).toBe('full');
    expect(branchRulesDefinition.inScope).toBe(true);
  });

  it('[FAC-005] declares the policy keys of the mapping table and the merge', () => {
    expect([...branchRulesDefinition.policyKeys].sort()).toEqual([
      'branch-rules.advisory-enforced',
      'branch-rules.approvals-capped',
      'branch-rules.exemptions-dropped',
      'branch-rules.merge-restriction-as-push',
      'branch-rules.overlap-unresolved',
      'branch-rules.pattern-approximated',
      'branch-rules.patterns-merged',
      'branch-rules.tasks-as-conversations',
    ]);
    expect(Object.values(BRANCH_RULES_POLICY).sort()).toEqual(
      [...branchRulesDefinition.policyKeys].sort(),
    );
  });

  it('[FAC-BRR-004] the canonical rule has no admin-enforcement field, so none can be set', () => {
    const parsed = branchRulesFacet.schema.safeParse({
      rules: [{ ...rule(), enforceAdmins: true }],
    });
    expect(parsed.success).toBe(false);
  });
});

// -- FAC-BRR-003 pattern conversion -----------------------------------------------------------

describe('pattern conversion', () => {
  it.each([
    ['main', 'main', true],
    ['release/*', 'release/*', true],
    ['feature/**', 'feature/**/*', true],
    ['**', '**/*', true],
    ['***', '**/*', true],
    ['a/**/b', 'a/**/b', true],
    ['a/**/**', 'a/**/*', true],
    ['a/***', 'a/**/*', true],
    ['a/****', 'a/**/*', true],
    ['fo**', 'fo*', false],
    ['a/b**c', 'a/b*c', false],
    ['a/b***c', 'a/b*c', false],
    ['a?b', 'a?b', false],
    ['x[1]', 'x[1]', false],
    ['a\\b', 'a\\b', false],
  ])('[FAC-BRR-003] %s converts to %s (lossless: %s)', (from, to, lossless) => {
    const c = convertPattern(from);
    expect(c.pattern).toBe(to);
    expect(c.lossless).toBe(lossless);
    expect(c.effects.length > 0).toBe(!lossless);
  });

  it('[FAC-BRR-003] a lossless conversion is a translated decision on the pattern', () => {
    const t = run(doc(rule({ pattern: 'feature/**' })));
    expect(desiredRule(t).pattern).toBe('feature/**/*');
    const d = decision(t, at('feature/**/*', 'pattern'));
    expect(d?.fidelity).toBe('translated');
  });

  it('[FAC-BRR-003] an unchanged pattern has no decision', () => {
    const t = run(doc(rule({ pattern: 'release/*' })));
    expect(t.decisions).toEqual([]);
  });

  it('[FAC-BRR-003] a pattern with no lossless conversion is lossy pattern-approximated; the note names both patterns and the effect', () => {
    const t = run(doc(rule({ pattern: 'fo**' })), NONE_ACCEPTED);
    const d = decision(t, at('fo*', 'pattern'));
    expect(d).toMatchObject({ fidelity: 'lossy', policyKey: 'branch-rules.pattern-approximated' });
    expect(d?.note).toContain('"fo**"');
    expect(d?.note).toContain('"fo*"');
    expect(d?.note).toContain('no longer protected');
    expect(t.preTasks.map((f) => f.code)).toEqual(['branch-rules.accept-lossy']);
    expect(t.preTasks[0]?.params.policyKey).toBe('branch-rules.pattern-approximated');
  });

  it('[FAC-BRR-003] an operator character is approximated with its own effect', () => {
    const t = run(doc(rule({ pattern: 'a?b' })), NONE_ACCEPTED);
    expect(decision(t, at('a?b', 'pattern'))?.note).toContain('pattern operators');
  });

  it('[FAC-BRR-003] a run of three stars is the same as two: lossless, no approximation', () => {
    const t = run(doc(rule({ pattern: 'a/***' })), NONE_ACCEPTED);
    expect(desiredRule(t).pattern).toBe('a/**/*');
    expect(t.preTasks).toEqual([]);
  });
});

describe('colliding patterns are merged, strictest first', () => {
  it('[FAC-BRR-003] `a/**` and `a/**/*` become one rule that keeps every protection', () => {
    const t = run(
      doc(
        rule({ pattern: 'a/**', blockDeletion: true }),
        rule({ pattern: 'a/**/*', restrictPushes: [user('1')], blockForcePush: true }),
      ),
      NONE_ACCEPTED,
    );
    expect((t.desired as BranchRules).rules).toHaveLength(1);
    expect(desiredRule(t)).toMatchObject({
      pattern: 'a/**/*',
      blockDeletion: true,
      blockForcePush: true,
      restrictPushes: [{ principal: { kind: 'identity', id: 't-1' } }],
    });
    const d = decision(t, at('a/**/*'));
    expect(d).toMatchObject({ fidelity: 'lossy', policyKey: 'branch-rules.patterns-merged' });
    expect(d?.note).toContain('"a/**"');
    expect(d?.note).toContain('"a/**/*"');
    expect(t.preTasks.map((f) => f.params.policyKey)).toEqual(['branch-rules.patterns-merged']);
  });

  it('[FAC-BRR-003] `rel*` and `rel**` merge, with the approximation reported separately', () => {
    const t = run(
      doc(
        rule({ pattern: 'rel*', blockDeletion: true }),
        rule({ pattern: 'rel**', blockForcePush: true }),
      ),
      NONE_ACCEPTED,
    );
    expect(desiredRule(t)).toMatchObject({
      pattern: 'rel*',
      blockDeletion: true,
      blockForcePush: true,
    });
    expect(t.preTasks.map((f) => f.params.policyKey).sort()).toEqual([
      'branch-rules.pattern-approximated',
      'branch-rules.patterns-merged',
    ]);
  });

  it('[FAC-BRR-003] the merge policy key is accepted by the Route like any other', () => {
    const t = run(doc(rule({ pattern: 'rel*' }), rule({ pattern: 'rel**' })), {
      accept: ['branch-rules.patterns-merged', 'branch-rules.pattern-approximated'],
    });
    expect(t.preTasks).toEqual([]);
  });

  it('[FAC-BRR-003] a null push list is the identity; lists are intersected', () => {
    const merge = (a: PrincipalEntry[] | null, b: PrincipalEntry[] | null) =>
      desiredRule(
        run(
          doc(
            rule({ pattern: 'rel*', restrictPushes: a }),
            rule({ pattern: 'rel**', restrictPushes: b }),
          ),
        ),
      ).restrictPushes;
    const t = (id: string) => ({ principal: { kind: 'identity' as const, id: `t-${id}` } });
    expect(merge(null, null)).toBeNull();
    expect(merge(null, [user('1')])).toEqual([t('1')]);
    expect(merge([user('1')], null)).toEqual([t('1')]);
    expect(merge([user('1'), user('2')], [user('2'), user('3')])).toEqual([t('2')]);
    expect(merge([user('1')], [user('2')])).toEqual([]);
    expect(merge([], [user('2')])).toEqual([]);
  });

  it('[FAC-BRR-003] merge lists follow the same rule as push lists', () => {
    const t = run(
      doc(
        rule({ pattern: 'rel*', restrictMerges: [user('1'), user('2')] }),
        rule({ pattern: 'rel**', restrictMerges: [user('2')] }),
      ),
    );
    expect(desiredRule(t).restrictPushes).toEqual([{ principal: { kind: 'identity', id: 't-2' } }]);
  });

  it('[FAC-BRR-003] exemptions count only where blocked; a principal stays exempt only if every blocking rule exempts it', () => {
    const exempt = (rules: BranchRule[]) =>
      desiredRule(run(doc(...rules))).forcePushExempt.map((e) => e.principal.id);
    expect(
      exempt([
        rule({ pattern: 'rel*', blockForcePush: true, forcePushExempt: [user('1'), user('2')] }),
        rule({ pattern: 'rel**', blockForcePush: true, forcePushExempt: [user('2')] }),
      ]),
    ).toEqual(['t-2']);
    expect(
      exempt([
        rule({ pattern: 'rel*', blockForcePush: true, forcePushExempt: [user('1')] }),
        rule({ pattern: 'rel**' }),
      ]),
    ).toEqual(['t-1']);
    expect(
      exempt([
        rule({ pattern: 'rel*', blockForcePush: true, forcePushExempt: [user('1')] }),
        rule({ pattern: 'rel**', blockForcePush: true }),
      ]),
    ).toEqual([]);
  });

  it('[FAC-BRR-003] deletion exemptions merge the same way and are then dropped (lossy)', () => {
    const t = run(
      doc(
        rule({ pattern: 'rel*', blockDeletion: true, deletionExempt: [user('1')] }),
        rule({ pattern: 'rel**', blockDeletion: true, deletionExempt: [user('1')] }),
      ),
      NONE_ACCEPTED,
    );
    expect(decision(t, at('rel*', 'deletionExempt'))?.fidelity).toBe('lossy');
  });

  it('[FAC-BRR-003] change requests merge to the highest counts and any required flag', () => {
    const t = run(
      doc(
        rule({ pattern: 'rel*', changeRequest: cr({ minApprovals: 1, requireUpToDate: true }) }),
        rule({
          pattern: 'rel**',
          changeRequest: cr({ minApprovals: 3, requireTasksResolved: true, minPassingBuilds: 2 }),
        }),
        rule({ pattern: 'rel***' }),
      ),
    );
    expect(desiredRule(t).changeRequest).toMatchObject({
      minApprovals: 3,
      requireUpToDate: true,
      requireTasksResolved: true,
      minPassingBuilds: 2,
    });
  });

  it('[FAC-BRR-003] a merged group with any advisory rule keeps the advisory-enforced decision', () => {
    const adv = run(
      doc(
        rule({ pattern: 'rel*', enforcement: 'advisory' }),
        rule({ pattern: 'rel**', enforcement: 'advisory' }),
      ),
      NONE_ACCEPTED,
    );
    expect(decision(adv, at('rel*', 'enforcement'))?.fidelity).toBe('lossy');
    const mixed = run(
      doc(rule({ pattern: 'rel*', enforcement: 'advisory' }), rule({ pattern: 'rel**' })),
      NONE_ACCEPTED,
    );
    expect(decision(mixed, at('rel*', 'enforcement'))?.fidelity).toBe('lossy');
    const enforced = run(doc(rule({ pattern: 'rel*' }), rule({ pattern: 'rel**' })), NONE_ACCEPTED);
    expect(decision(enforced, at('rel*', 'enforcement'))).toBeUndefined();
  });

  it('[FAC-BRR-003] merging does not depend on the order of the source rules', () => {
    const a = rule({ pattern: 'rel*', blockDeletion: true });
    const b = rule({ pattern: 'rel**', restrictPushes: [user('1')] });
    expect(run(doc(a, b), NONE_ACCEPTED)).toEqual(run(doc(b, a), NONE_ACCEPTED));
  });
});

describe('write access (ADR-0111)', () => {
  const access = (...grants: [string, string][]) => ({
    'access-control': {
      source: { grants: [] },
      desired: {
        grants: grants.map(([id, role]) => ({ principal: { kind: 'identity', id }, role })),
      },
    },
  });
  const runWith = (source: BranchRules, deps: Record<string, unknown>) =>
    translateFacet(registry, 'branch-rules', source, {
      env: env(NONE_ACCEPTED),
      deps: deps as never,
    });

  it('[FAC-BRR-002] [ADR-0040] exempt actors without write access are dropped under exemptions-dropped', () => {
    const t = runWith(
      doc(rule({ blockForcePush: true, forcePushExempt: [user('1'), user('2')] })),
      access(['t-1', 'write'], ['t-2', 'read']),
    );
    expect(desiredRule(t).forcePushExempt).toEqual([
      { principal: { kind: 'identity', id: 't-1' } },
    ]);
    expect(decision(t, `${P}/forcePushExempt`)).toMatchObject({
      fidelity: 'lossy',
      policyKey: 'branch-rules.exemptions-dropped',
    });
    expect(decision(t, `${P}/forcePushExempt`)?.note).toContain('identity:t-2');
  });

  it.each(['write', 'maintain', 'admin'])('[FAC-BRR-002] %s access is enough', (role) => {
    const t = runWith(
      doc(
        rule({ blockForcePush: true, forcePushExempt: [user('1')], restrictPushes: [user('1')] }),
      ),
      access(['t-1', role]),
    );
    expect(desiredRule(t).forcePushExempt).toHaveLength(1);
    expect(desiredRule(t).restrictPushes).toHaveLength(1);
    expect(t.preTasks).toEqual([]);
  });

  it('[FAC-BRR-002] push-list actors without write access are left out, with a note (narrower, fails safe)', () => {
    const t = runWith(
      doc(rule({ restrictPushes: [user('1'), user('2')] })),
      access(['t-1', 'triage']),
    );
    expect(desiredRule(t).restrictPushes).toEqual([]);
    expect(decision(t, `${P}/restrictPushes`)?.fidelity).toBe('translated');
    expect(decision(t, `${P}/restrictPushes`)?.note).toContain('identity:t-1');
  });

  it('[FAC-BRR-002] without usable access-control data the actors are kept', () => {
    expect(
      desiredRule(runWith(doc(rule({ restrictPushes: [user('1')] })), {})).restrictPushes,
    ).toHaveLength(1);
    const odd = runWith(doc(rule({ restrictPushes: [user('1')] })), {
      'access-control': { source: {}, desired: {} },
    });
    expect(desiredRule(odd).restrictPushes).toHaveLength(1);
  });
});

describe('pattern conversion: further rows', () => {
  it('[FAC-BRR-003] patterns of different rules that stay different are not merged', () => {
    const t = run(doc(rule({ pattern: 'a' }), rule({ pattern: 'b' })));
    expect((t.desired as BranchRules).rules).toHaveLength(2);
    expect(t.decisions).toEqual([]);
  });
});

// -- FAC-BRR-002 mapping table, row by row ----------------------------------------------------

describe('enforcement', () => {
  it('[FAC-BRR-002] [FAC-005] advisory becomes enforced: lossy advisory-enforced, accepted by default', () => {
    const t = run(doc(rule({ enforcement: 'advisory' })));
    expect(desiredRule(t).enforcement).toBe('enforced');
    expect(decision(t, `${P}/enforcement`)).toMatchObject({
      fidelity: 'lossy',
      policyKey: 'branch-rules.advisory-enforced',
      accepted: 'policy',
    });
    expect(t.preTasks).toEqual([]);
    expect(t.expectedDifferences).toEqual([
      expect.objectContaining({ reason: 'lossy_accepted', note: 'branch-rules.advisory-enforced' }),
    ]);
  });

  it('[FAC-BRR-002] [FAC-005] an advisory rule without a policy makes an accept-lossy pre task', () => {
    const t = run(doc(rule({ enforcement: 'advisory' })), NONE_ACCEPTED);
    expect(t.preTasks).toHaveLength(1);
    expect(t.preTasks[0]).toMatchObject({
      code: 'branch-rules.accept-lossy',
      paths: [`${P}/enforcement`],
      params: { policyKey: 'branch-rules.advisory-enforced', paths: [`${P}/enforcement`] },
    });
  });

  it('[FAC-BRR-002] an enforced rule is exact', () => {
    const t = run(doc(rule({ enforcement: 'enforced' })));
    expect(decision(t, `${P}/enforcement`)).toBeUndefined();
    expect(desiredRule(t).enforcement).toBe('enforced');
  });
});

describe('restrictPushes and restrictMerges', () => {
  it('[FAC-BRR-002] restrictPushes is translated to target principals', () => {
    const t = run(doc(rule({ restrictPushes: [user('1'), group('g')] })));
    expect(desiredRule(t).restrictPushes).toEqual([
      { principal: { kind: 'group', id: 't-g' } },
      { principal: { kind: 'identity', id: 't-1' } },
    ]);
    expect(decision(t, `${P}/restrictPushes`)?.fidelity).toBe('translated');
  });

  it('[FAC-BRR-002] [ADR-0041] null stays unrestricted and an empty list stays "nobody"; both keep the creation rule in step', () => {
    // blocksCreations follows restrictPushes: it is true exactly when the list is non-null, so the
    // canonical document must keep the null / [] / list distinction through translation.
    const none = desiredRule(run(doc(rule({ restrictPushes: null }))));
    const nobody = desiredRule(run(doc(rule({ restrictPushes: [] }))));
    const some = desiredRule(run(doc(rule({ restrictPushes: [user('1')] }))));
    expect(none.restrictPushes).toBeNull();
    expect(nobody.restrictPushes).toEqual([]);
    expect(some.restrictPushes).toHaveLength(1);
  });

  it('[FAC-BRR-002] [ADR-0041] a list whose principals are all omitted becomes "nobody", never unrestricted', () => {
    const t = run(doc(rule({ restrictPushes: [user('1')] })), {
      outcomes: { 'identity:1': 'unmapped' },
    });
    expect(desiredRule(t).restrictPushes).toEqual([]);
  });

  it('[FAC-BRR-002] restrictMerges without restrictPushes is applied as the push restriction (lossy)', () => {
    const t = run(doc(rule({ restrictMerges: [user('1')] })), NONE_ACCEPTED);
    expect(desiredRule(t).restrictPushes).toEqual([{ principal: { kind: 'identity', id: 't-1' } }]);
    expect(desiredRule(t).restrictMerges).toBeNull();
    expect(decision(t, `${P}/restrictMerges`)).toMatchObject({
      fidelity: 'lossy',
      policyKey: 'branch-rules.merge-restriction-as-push',
    });
    expect(t.preTasks.map((f) => f.params.policyKey)).toEqual([
      'branch-rules.merge-restriction-as-push',
    ]);
  });

  it('[FAC-BRR-002] restrictMerges = [] without restrictPushes means nobody pushes (lossy)', () => {
    const t = run(doc(rule({ restrictMerges: [] })), NONE_ACCEPTED);
    expect(desiredRule(t).restrictPushes).toEqual([]);
  });

  it('[FAC-BRR-002] differing restrictMerges and restrictPushes: restrictPushes wins (lossy, same key)', () => {
    const t = run(
      doc(rule({ restrictPushes: [user('1')], restrictMerges: [user('2')] })),
      NONE_ACCEPTED,
    );
    expect(desiredRule(t).restrictPushes).toEqual([{ principal: { kind: 'identity', id: 't-1' } }]);
    expect(decision(t, `${P}/restrictMerges`)).toMatchObject({
      fidelity: 'lossy',
      policyKey: 'branch-rules.merge-restriction-as-push',
    });
  });

  it('[FAC-BRR-002] restrictMerges equal to restrictPushes needs no acceptance', () => {
    const t = run(
      doc(rule({ restrictPushes: [user('1'), user('2')], restrictMerges: [user('2'), user('1')] })),
      NONE_ACCEPTED,
    );
    expect(decision(t, `${P}/restrictMerges`)?.fidelity).toBe('translated');
    expect(t.preTasks).toEqual([]);
  });

  it('[FAC-BRR-002] the dropped merge list is not resolved, so it raises no principal findings', () => {
    const t = run(doc(rule({ restrictPushes: [user('1')], restrictMerges: [user('9')] })), {
      outcomes: { 'identity:9': 'unmapped' },
    });
    expect(t.preTasks.filter((f) => f.code === 'branch-rules.unmapped-principal')).toEqual([]);
  });
});

describe('force push and deletion', () => {
  it('[FAC-BRR-002] blockForcePush and blockDeletion are exact', () => {
    const t = run(doc(rule({ blockForcePush: true, blockDeletion: true })));
    expect(desiredRule(t)).toMatchObject({ blockForcePush: true, blockDeletion: true });
    expect(t.decisions).toEqual([]);
  });

  it('[FAC-BRR-002] [ADR-0040] force-push exemptions stay with blockForcePush: true and become target principals', () => {
    const t = run(doc(rule({ blockForcePush: true, forcePushExempt: [user('1'), group('g')] })));
    const r = desiredRule(t);
    expect(r.blockForcePush).toBe(true);
    expect(r.forcePushExempt).toEqual([
      { principal: { kind: 'group', id: 't-g' } },
      { principal: { kind: 'identity', id: 't-1' } },
    ]);
    expect(decision(t, `${P}/forcePushExempt`)?.fidelity).toBe('translated');
    expect(t.preTasks).toEqual([]);
  });

  it('[FAC-BRR-002] [ADR-0040] without blockForcePush an exemption list means nothing and is not carried', () => {
    const t = run(doc(rule({ blockForcePush: false, forcePushExempt: [user('1')] })));
    expect(desiredRule(t)).toMatchObject({ blockForcePush: false, forcePushExempt: [] });
    expect(t.decisions).toEqual([]);
  });

  it.each([
    ['unsupported', { kind: 'unsupported' as const }],
    ['readOnly', { kind: 'readOnly' as const }],
  ])(
    '[FAC-BRR-002] [ADR-0040] exemptions the target cannot hold (%s) are dropped, and force pushes stay blocked for everyone',
    (_n, support) => {
      const caps: FacetCapability = {
        read: true,
        write: true,
        fields: { '/rules/forcePushExempt': support },
      };
      const t = run(doc(rule({ blockForcePush: true, forcePushExempt: [user('1')] })), {
        ...NONE_ACCEPTED,
        targetCaps: caps,
      });
      const r = desiredRule(t);
      expect(r.blockForcePush).toBe(true);
      expect(r.forcePushExempt).toEqual([]);
      expect(decision(t, `${P}/forcePushExempt`)).toMatchObject({
        fidelity: 'lossy',
        policyKey: 'branch-rules.exemptions-dropped',
      });
      expect(t.preTasks.map((f) => f.code)).toEqual(['branch-rules.accept-lossy']);
    },
  );

  it('[FAC-BRR-002] [ADR-0040] a supported or unlisted capability keeps the exemptions', () => {
    const caps: FacetCapability = {
      read: true,
      write: true,
      fields: { '/rules/forcePushExempt': { kind: 'supported' } },
    };
    const t = run(doc(rule({ blockForcePush: true, forcePushExempt: [user('1')] })), {
      targetCaps: caps,
    });
    expect(desiredRule(t).forcePushExempt).toHaveLength(1);
  });

  it('[FAC-BRR-002] [ADR-0040] [FAC-006] exempt principals that cannot be resolved are omitted (fail closed), with their findings', () => {
    const t = run(doc(rule({ blockForcePush: true, forcePushExempt: [user('1'), user('2')] })), {
      outcomes: { 'identity:1': 'unmapped', 'identity:2': 'excluded' },
    });
    expect(desiredRule(t)).toMatchObject({ blockForcePush: true, forcePushExempt: [] });
    expect(t.preTasks).toEqual([
      expect.objectContaining({
        code: 'branch-rules.unmapped-principal',
        paths: [`${P}/forcePushExempt`],
      }),
    ]);
  });

  it('[FAC-BRR-002] non-empty deletionExempt is not representable: lossy exemptions-dropped', () => {
    const t = run(doc(rule({ blockDeletion: true, deletionExempt: [user('1')] })), NONE_ACCEPTED);
    expect(desiredRule(t)).toMatchObject({ blockDeletion: true, deletionExempt: [] });
    expect(decision(t, `${P}/deletionExempt`)).toMatchObject({
      fidelity: 'lossy',
      policyKey: 'branch-rules.exemptions-dropped',
    });
  });

  it('[FAC-BRR-002] deletion and force-push exemptions share one accept task listing both paths', () => {
    const caps: FacetCapability = {
      read: true,
      write: true,
      fields: { '/rules/forcePushExempt': { kind: 'unsupported' } },
    };
    const t = run(
      doc(
        rule({
          blockDeletion: true,
          deletionExempt: [user('1')],
          blockForcePush: true,
          forcePushExempt: [user('1')],
        }),
      ),
      { ...NONE_ACCEPTED, targetCaps: caps },
    );
    expect(t.preTasks).toHaveLength(1);
    expect(t.preTasks[0]?.params).toEqual({
      policyKey: 'branch-rules.exemptions-dropped',
      paths: [`${P}/deletionExempt`, `${P}/forcePushExempt`],
    });
  });

  it('[FAC-BRR-002] an exemption list without blockDeletion means nothing', () => {
    const t = run(doc(rule({ blockDeletion: false, deletionExempt: [user('1')] })), NONE_ACCEPTED);
    expect(t.decisions).toEqual([]);
  });
});

describe('change request rules', () => {
  const CR = `${P}/changeRequest`;

  it('[FAC-BRR-002] no change request stays null', () => {
    expect(desiredRule(run(doc(rule()))).changeRequest).toBeNull();
  });

  it.each([1, 3, 6])('[FAC-BRR-002] minApprovals %i is exact', (n) => {
    const t = run(doc(rule({ changeRequest: cr({ minApprovals: n }) })));
    expect(desiredRule(t).changeRequest?.minApprovals).toBe(n);
    expect(t.decisions.filter((d) => d.fidelity !== 'translated')).toEqual([]);
  });

  it('[FAC-BRR-002] minApprovals above 6 is capped at 6: lossy approvals-capped', () => {
    const t = run(doc(rule({ changeRequest: cr({ minApprovals: 9 }) })), NONE_ACCEPTED);
    expect(desiredRule(t).changeRequest?.minApprovals).toBe(6);
    expect(decision(t, `${CR}/minApprovals`)).toMatchObject({
      fidelity: 'lossy',
      policyKey: 'branch-rules.approvals-capped',
    });
    expect(t.preTasks[0]?.params.policyKey).toBe('branch-rules.approvals-capped');
  });

  it('[FAC-BRR-002] requireCodeOwnerApproval is translated', () => {
    const t = run(doc(rule({ changeRequest: cr({ requireCodeOwnerApproval: true }) })));
    expect(desiredRule(t).changeRequest?.requireCodeOwnerApproval).toBe(true);
    expect(decision(t, `${CR}/requireCodeOwnerApproval`)?.fidelity).toBe('translated');
  });

  it('[FAC-BRR-002] dismissStaleApprovals is exact', () => {
    const t = run(doc(rule({ changeRequest: cr({ dismissStaleApprovals: true }) })));
    expect(desiredRule(t).changeRequest?.dismissStaleApprovals).toBe(true);
    expect(t.decisions.filter((d) => d.fidelity !== 'translated')).toEqual([]);
  });

  it.each([2, 0])(
    '[FAC-BRR-002] requireNoChangesRequested with minApprovals %i is translated and keeps the count',
    (n) => {
      const t = run(
        doc(rule({ changeRequest: cr({ minApprovals: n, requireNoChangesRequested: true }) })),
      );
      expect(desiredRule(t).changeRequest).toMatchObject({
        minApprovals: n,
        requireNoChangesRequested: true,
      });
      expect(decision(t, `${CR}/requireNoChangesRequested`)?.fidelity).toBe('translated');
    },
  );

  it('[FAC-BRR-002] requireNoChangesRequested is true in desired whenever reviews are required (what the target reports)', () => {
    for (const o of [
      { minApprovals: 1 },
      { requireCodeOwnerApproval: true },
      { dismissStaleApprovals: true },
    ]) {
      const t = run(doc(rule({ changeRequest: cr(o) })));
      expect(desiredRule(t).changeRequest?.requireNoChangesRequested, JSON.stringify(o)).toBe(true);
      expect(decision(t, `${CR}/requireNoChangesRequested`)?.fidelity).toBe('translated');
    }
  });

  it('[FAC-BRR-002] requireNoChangesRequested stays false when no review is required', () => {
    const t = run(doc(rule({ changeRequest: cr({ requireUpToDate: true }) })));
    expect(desiredRule(t).changeRequest?.requireNoChangesRequested).toBe(false);
    expect(decision(t, `${CR}/requireNoChangesRequested`)).toBeUndefined();
  });

  it('[LIF-060] [FAC-BRR-002] desired settles against a target read with "reviews required" semantics', () => {
    const source = doc(
      rule({
        changeRequest: cr({ minApprovals: 2, dismissStaleApprovals: true, requireUpToDate: true }),
      }),
    );
    const none = doc(rule({ pattern: 'plain', changeRequest: cr({ requireUpToDate: true }) }));
    for (const input of [source, none]) {
      const desired = run(input).desired as BranchRules;
      // Built independently of translate: what a target reader reports for each source rule.
      const reviewsRequired = (c: ChangeRequest) =>
        c.minApprovals >= 1 ||
        c.requireCodeOwnerApproval ||
        c.dismissStaleApprovals ||
        c.requireNoChangesRequested;
      const actual: BranchRules = {
        rules: input.rules.map((r) => ({
          ...r,
          changeRequest:
            r.changeRequest === null
              ? null
              : { ...r.changeRequest, requireNoChangesRequested: reviewsRequired(r.changeRequest) },
        })),
      };
      expect(compareBranchRules(desired, actual)).toEqual([]);
      expect(compareFacet(registry, 'branch-rules', desired, actual)?.status).toBe('equal');
    }
    const flags = (b: BranchRules) =>
      b.rules.map((r) => r.changeRequest?.requireNoChangesRequested);
    expect(flags(run(source).desired as BranchRules)).toEqual([true]);
    expect(flags(run(none).desired as BranchRules)).toEqual([false]);
  });

  it('[FAC-BRR-002] requireTasksResolved is lossy tasks-as-conversations', () => {
    const t = run(doc(rule({ changeRequest: cr({ requireTasksResolved: true }) })), NONE_ACCEPTED);
    expect(desiredRule(t).changeRequest?.requireTasksResolved).toBe(true);
    expect(decision(t, `${CR}/requireTasksResolved`)).toMatchObject({
      fidelity: 'lossy',
      policyKey: 'branch-rules.tasks-as-conversations',
    });
    expect(t.preTasks[0]?.params.policyKey).toBe('branch-rules.tasks-as-conversations');
  });

  it('[FAC-BRR-002] requireTasksResolved is silent when the Route accepts the policy key', () => {
    const t = run(doc(rule({ changeRequest: cr({ requireTasksResolved: true }) })), {
      accept: ['branch-rules.tasks-as-conversations'],
    });
    expect(t.preTasks).toEqual([]);
    expect(decision(t, `${CR}/requireTasksResolved`)?.accepted).toBe('policy');
  });

  it('[FAC-BRR-002] requireUpToDate is translated', () => {
    const t = run(doc(rule({ changeRequest: cr({ requireUpToDate: true }) })));
    expect(desiredRule(t).changeRequest?.requireUpToDate).toBe(true);
    expect(decision(t, `${CR}/requireUpToDate`)?.fidelity).toBe('translated');
  });

  it('[FAC-BRR-002] minPassingBuilds > 0 is unsupported: post task configure-status-checks (verifiable)', () => {
    const t = run(doc(rule({ pattern: 'release/*', changeRequest: cr({ minPassingBuilds: 2 }) })));
    const path = at('release/*', 'changeRequest', 'minPassingBuilds');
    expect(decision(t, path)?.fidelity).toBe('unsupported');
    expect(t.postTasks).toEqual([
      expect.objectContaining({
        code: 'branch-rules.configure-status-checks',
        paths: [path],
        params: { pattern: 'release/*' },
        verifiable: true,
      }),
    ]);
    expect(desiredRule(t).changeRequest?.minPassingBuilds).toBe(2);
  });

  it('[FAC-BRR-002] minPassingBuilds of 0 raises nothing', () => {
    const t = run(doc(rule({ changeRequest: cr({ minApprovals: 1 }) })));
    expect(t.postTasks).toEqual([]);
  });

  it('[FAC-BRR-002] a change request that requires nothing is the same as none', () => {
    const t = run(doc(rule({ changeRequest: cr() })));
    expect(desiredRule(t).changeRequest).toBeNull();
  });
});

// -- FAC-006 ----------------------------------------------------------------------------------

describe('principal resolution', () => {
  const restricted = (...entries: PrincipalEntry[]) => doc(rule({ restrictPushes: entries }));

  it('[FAC-006] confirmed identities and groups with a team map to target principals', () => {
    const t = run(restricted(user('1'), group('g')));
    expect(t.blockers).toEqual([]);
    expect(t.preTasks).toEqual([]);
    expect(t.postTasks).toEqual([]);
  });

  it('[FAC-006] an excluded principal is omitted with no finding', () => {
    const t = run(restricted(user('1'), user('2')), { outcomes: { 'identity:1': 'excluded' } });
    expect(desiredRule(t).restrictPushes).toEqual([{ principal: { kind: 'identity', id: 't-2' } }]);
    expect([...t.blockers, ...t.preTasks, ...t.postTasks, ...t.warnings]).toEqual([]);
  });

  it('[FAC-006] a pending invitation is omitted with a post task branch-rules.pending-invitation (verifiable)', () => {
    const t = run(restricted(user('1')), { outcomes: { 'identity:1': 'pending_invite' } });
    expect(desiredRule(t).restrictPushes).toEqual([]);
    expect(t.postTasks).toEqual([
      expect.objectContaining({
        code: 'branch-rules.pending-invitation',
        paths: [`${P}/restrictPushes`],
        params: { facet: 'branch-rules', principal: 'identity:1' },
        verifiable: true,
      }),
    ]);
  });

  it('[FAC-006] an unmapped principal is omitted with a pre task branch-rules.unmapped-principal', () => {
    const t = run(restricted(user('1')), { outcomes: { 'identity:1': 'unmapped' } });
    expect(desiredRule(t).restrictPushes).toEqual([]);
    expect(t.preTasks).toEqual([
      expect.objectContaining({
        code: 'branch-rules.unmapped-principal',
        paths: [`${P}/restrictPushes`],
        params: { facet: 'branch-rules', principal: 'identity:1' },
        verifiable: false,
      }),
    ]);
  });

  it('[FAC-006] a group without a created team is omitted with a blocker', () => {
    const t = run(restricted(group('g')), { outcomes: { 'group:g': 'team_missing' } });
    expect(desiredRule(t).restrictPushes).toEqual([]);
    expect(t.blockers).toEqual([
      expect.objectContaining({
        code: 'branch-rules.team-missing',
        paths: [`${P}/restrictPushes`],
        params: { team: 'g' },
      }),
    ]);
  });

  it('[FAC-006] one finding per principal, listing every path, in a stable order', () => {
    const t = run(
      doc(
        rule({ pattern: 'b', restrictPushes: [user('2'), user('1')] }),
        rule({
          pattern: 'a',
          restrictPushes: [user('1')],
          blockForcePush: true,
          forcePushExempt: [user('1')],
        }),
      ),
      { outcomes: { 'identity:1': 'unmapped', 'identity:2': 'unmapped' } },
    );
    expect(t.preTasks.map((f) => [f.params.principal, f.paths])).toEqual([
      [
        'identity:1',
        [
          '/rules[pattern=a]/forcePushExempt',
          '/rules[pattern=a]/restrictPushes',
          '/rules[pattern=b]/restrictPushes',
        ],
      ],
      ['identity:2', ['/rules[pattern=b]/restrictPushes']],
    ]);
  });

  it('[FAC-006] principals in the merge list that become the push list are resolved at the push path', () => {
    const t = run(doc(rule({ restrictMerges: [user('1')] })), {
      outcomes: { 'identity:1': 'unmapped' },
    });
    expect(t.preTasks.find((f) => f.code === 'branch-rules.unmapped-principal')?.paths).toEqual([
      `${P}/restrictPushes`,
    ]);
  });
});

// -- normalize and ADP-021 ---------------------------------------------------------------------

describe('normalize', () => {
  it('[ADP-021] removes duplicate principals and keeps null distinct from an empty list', () => {
    const n = normalizeRule(
      rule({
        restrictPushes: [user('1'), user('1')],
        restrictMerges: [],
        blockForcePush: true,
        forcePushExempt: [user('2'), user('2')],
      }),
    );
    expect(n.restrictPushes).toEqual([user('1')]);
    expect(n.restrictMerges).toEqual([]);
    expect(n.forcePushExempt).toEqual([user('2')]);
    expect(normalizeRule(rule()).restrictPushes).toBeNull();
  });

  it('[ADP-021] clears exemption lists that exempt from nothing', () => {
    const n = normalizeRule(rule({ forcePushExempt: [user('1')], deletionExempt: [user('1')] }));
    expect(n.forcePushExempt).toEqual([]);
    expect(n.deletionExempt).toEqual([]);
    const kept = normalizeRule(
      rule({
        blockForcePush: true,
        forcePushExempt: [user('1')],
        blockDeletion: true,
        deletionExempt: [user('2')],
      }),
    );
    expect(kept.forcePushExempt).toEqual([user('1')]);
    expect(kept.deletionExempt).toEqual([user('2')]);
  });

  it('[ADP-021] a change request that requires nothing is null; any requirement keeps it', () => {
    expect(normalizeRule(rule({ changeRequest: cr() })).changeRequest).toBeNull();
    for (const o of [
      { minApprovals: 1 },
      { requireCodeOwnerApproval: true },
      { dismissStaleApprovals: true },
      { requireNoChangesRequested: true },
      { requireTasksResolved: true },
      { requireUpToDate: true },
      { minPassingBuilds: 1 },
    ]) {
      expect(normalizeRule(rule({ changeRequest: cr(o) })).changeRequest).toEqual(cr(o));
    }
  });

  it('[ADP-021] is idempotent and does not mutate its input', () => {
    const input = doc(
      rule({ pattern: 'z', restrictPushes: [user('1'), user('1')], changeRequest: cr() }),
      rule({ pattern: 'a' }),
    );
    const copy = structuredClone(input);
    const once = normalizeBranchRules(input);
    expect(input).toEqual(copy);
    expect(normalizeBranchRules(once)).toEqual(once);
  });

  it('[ADP-021] the engine sorts rules by pattern, so source order does not matter', () => {
    const a = run(doc(rule({ pattern: 'b' }), rule({ pattern: 'a' })));
    const b = run(doc(rule({ pattern: 'a' }), rule({ pattern: 'b' })));
    expect(a.desired).toEqual(b.desired);
    expect((a.desired as BranchRules).rules.map((r) => r.pattern)).toEqual(['a', 'b']);
  });
});

// -- translation is pure and deterministic -------------------------------------------------------

describe('translate', () => {
  it('[ADP-031] is deterministic', () => {
    const source = doc(
      rule({ pattern: 'a**', enforcement: 'advisory', restrictMerges: [user('1')] }),
      rule({ pattern: 'b', changeRequest: cr({ minApprovals: 8, minPassingBuilds: 1 }) }),
    );
    expect(run(source, NONE_ACCEPTED)).toEqual(run(source, NONE_ACCEPTED));
  });

  it('[ADP-031] an empty document translates to an empty one', () => {
    const t = run(doc());
    expect(t.desired).toEqual({ rules: [] });
    expect([t.decisions, t.blockers, t.preTasks, t.postTasks, t.warnings]).toEqual([
      [],
      [],
      [],
      [],
      [],
    ]);
  });

  it('[FAC-BRR-002] a rule using every row at once produces one decision per non-exact field', () => {
    const t = run(
      doc(
        rule({
          pattern: 'release/**',
          enforcement: 'advisory',
          restrictPushes: [user('1')],
          restrictMerges: [user('2')],
          blockForcePush: true,
          forcePushExempt: [user('3')],
          blockDeletion: true,
          deletionExempt: [user('4')],
          changeRequest: cr({
            minApprovals: 7,
            requireCodeOwnerApproval: true,
            dismissStaleApprovals: true,
            requireNoChangesRequested: true,
            requireTasksResolved: true,
            requireUpToDate: true,
            minPassingBuilds: 1,
          }),
        }),
      ),
      NONE_ACCEPTED,
    );
    const by = (f: string) =>
      t.decisions
        .filter((d) => d.fidelity === f)
        .map((d) =>
          parseFieldPath(d.path)
            .slice(1)
            .map((s) => s.name)
            .join('/'),
        );
    expect(by('lossy')).toEqual([
      'changeRequest/minApprovals',
      'changeRequest/requireTasksResolved',
      'deletionExempt',
      'enforcement',
      'restrictMerges',
    ]);
    expect(by('translated')).toEqual([
      'changeRequest/requireCodeOwnerApproval',
      'changeRequest/requireNoChangesRequested',
      'changeRequest/requireUpToDate',
      'forcePushExempt',
      'pattern',
      'restrictPushes',
    ]);
    expect(by('unsupported')).toEqual(['changeRequest/minPassingBuilds']);
    expect(t.preTasks.map((f) => f.params.policyKey).sort()).toEqual([
      'branch-rules.advisory-enforced',
      'branch-rules.approvals-capped',
      'branch-rules.exemptions-dropped',
      'branch-rules.merge-restriction-as-push',
      'branch-rules.tasks-as-conversations',
    ]);
  });
});

// -- compare ------------------------------------------------------------------------------------

describe('compare', () => {
  const target = (r: BranchRule[]) => doc(...r);

  it('[LIF-060] [FAC-BRR-002] identical documents have no diffs, whatever the order', () => {
    const a = doc(
      rule({ pattern: 'a' }),
      rule({ pattern: 'b', restrictPushes: [user('1'), user('2')] }),
    );
    const b = doc(
      rule({ pattern: 'b', restrictPushes: [user('2'), user('1')] }),
      rule({ pattern: 'a' }),
    );
    expect(compareBranchRules(normalizeBranchRules(a), normalizeBranchRules(b))).toEqual([]);
  });

  it('[LIF-060] reports a changed field at its canonical path', () => {
    const diffs = compareBranchRules(
      doc(rule({ blockDeletion: true })),
      doc(rule({ blockDeletion: false })),
    );
    expect(diffs).toEqual([{ path: `${P}/blockDeletion`, desired: true, actual: false }]);
  });

  it('[LIF-060] a missing or extra rule is reported', () => {
    const diffs = compareBranchRules(doc(rule({ pattern: 'a' })), target([]));
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.every((d) => d.path.startsWith('/rules[pattern=a]'))).toBe(true);
    const extra = compareBranchRules(doc(), doc(rule({ pattern: 'a' })));
    expect(extra.length).toBeGreaterThan(0);
  });

  it('[LIF-060] [ADR-0041] unrestricted (null) and nobody ([]) differ', () => {
    const diffs = compareBranchRules(
      doc(rule({ restrictPushes: [] })),
      doc(rule({ restrictPushes: null })),
    );
    expect(diffs.map((d) => d.path)).toEqual([`${P}/restrictPushes`]);
  });

  it('[LIF-060] a principal missing from the target is reported', () => {
    const diffs = compareBranchRules(
      doc(rule({ restrictPushes: [user('1'), user('2')] })),
      doc(rule({ restrictPushes: [user('1')] })),
    );
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.every((d) => d.path.includes('restrictPushes[principal=identity:2]'))).toBe(true);
  });

  it('[LIF-060] [FAC-BRR-002] minPassingBuilds only differs between "none" and "some"', () => {
    const want = doc(rule({ changeRequest: cr({ minApprovals: 1, minPassingBuilds: 3 }) }));
    const same = doc(rule({ changeRequest: cr({ minApprovals: 1, minPassingBuilds: 1 }) }));
    const none = doc(rule({ changeRequest: cr({ minApprovals: 1, minPassingBuilds: 0 }) }));
    expect(compareBranchRules(want, same)).toEqual([]);
    expect(compareBranchRules(want, none)).toEqual([
      { path: `${P}/changeRequest/minPassingBuilds`, desired: 3, actual: 0 },
    ]);
    expect(compareBranchRules(none, same)).toEqual([
      { path: `${P}/changeRequest/minPassingBuilds`, desired: 0, actual: 1 },
    ]);
  });

  it('[LIF-060] a target without any change request equals a desired one without builds or reviews', () => {
    expect(compareBranchRules(doc(rule()), doc(rule()))).toEqual([]);
  });

  it('[LIF-060] compareFacet normalizes both sides first and reports equal / different', () => {
    const desired = doc(rule({ forcePushExempt: [user('1')], changeRequest: cr() }));
    const actual = doc(rule());
    expect(compareFacet(registry, 'branch-rules', desired, actual)?.status).toBe('equal');
    expect(
      compareFacet(registry, 'branch-rules', doc(rule({ blockForcePush: true })), actual)?.status,
    ).toBe('different');
    expect(compareFacet(registry, 'branch-rules', desired, null)?.status).toBe('unverifiable');
  });
});

// -- task satisfaction (LIF-061) -------------------------------------------------------------------

describe('isTaskSatisfied', () => {
  const task = { code: 'branch-rules.configure-status-checks', params: { pattern: 'main' } };

  it('[LIF-061] configure-status-checks is satisfied once the target rule requires builds', () => {
    const done = doc(rule({ changeRequest: cr({ minPassingBuilds: 1 }) }));
    expect(satisfiedTasks(registry, 'branch-rules', [task], done, [])).toEqual([task]);
  });

  it('[LIF-061] it is not satisfied with no builds, no change request, or no such rule', () => {
    for (const target of [
      doc(rule({ changeRequest: cr({ minApprovals: 1 }) })),
      doc(rule()),
      doc(rule({ pattern: 'other', changeRequest: cr({ minPassingBuilds: 1 }) })),
      doc(),
    ]) {
      expect(satisfiedTasks(registry, 'branch-rules', [task], target, [])).toEqual([]);
    }
  });

  it('[LIF-061] a task with params that name no rule is not satisfied', () => {
    const bad = { code: 'branch-rules.configure-status-checks', params: null };
    const target = doc(rule({ changeRequest: cr({ minPassingBuilds: 1 }) }));
    expect(branchRulesDefinition.isTaskSatisfied?.(bad, target, [])).toBe(false);
  });

  it('[LIF-061] [FAC-006] pending-invitation is never satisfied by parity alone (fail closed)', () => {
    const pending = {
      code: 'branch-rules.pending-invitation',
      params: { principal: 'identity:1' },
    };
    const target = doc(rule({ restrictPushes: [user('1')] }));
    expect(branchRulesDefinition.isTaskSatisfied?.(pending, target, [])).toBe(false);
  });
});

describe('merged restrictions never widen the allowance', () => {
  const t = (id: string) => ({ principal: { kind: 'identity' as const, id: `t-${id}` } });

  it('[FAC-BRR-002] a merge-only rule and a push-only rule give the intersection (here nobody)', () => {
    const r = run(
      doc(
        rule({ pattern: 'rel*', restrictMerges: [user('1')] }),
        rule({ pattern: 'rel**', restrictPushes: [user('2')] }),
      ),
      NONE_ACCEPTED,
    );
    expect(desiredRule(r).restrictPushes).toEqual([]);
    expect(desiredRule(r).restrictMerges).toBeNull();
    expect(decision(r, at('rel*', 'restrictMerges'))).toMatchObject({
      fidelity: 'lossy',
      policyKey: 'branch-rules.merge-restriction-as-push',
    });
    expect(decision(r, at('rel*', 'restrictMerges'))?.note).toContain('intersection');
  });

  it('[FAC-BRR-002] overlapping lists give the intersection', () => {
    const r = run(
      doc(
        rule({ pattern: 'rel*', restrictMerges: [user('1'), user('2')] }),
        rule({ pattern: 'rel**', restrictPushes: [user('2'), user('3')] }),
      ),
    );
    expect(desiredRule(r).restrictPushes).toEqual([t('2')]);
  });

  it('[FAC-BRR-002] a rule with both lists contributes its push list and its merge list', () => {
    const r = run(
      doc(
        rule({
          pattern: 'rel*',
          restrictPushes: [user('1'), user('2')],
          restrictMerges: [user('2')],
        }),
        rule({ pattern: 'rel**', restrictPushes: [user('1'), user('2')] }),
      ),
    );
    expect(desiredRule(r).restrictPushes).toEqual([t('2')]);
  });

  it('[FAC-BRR-002] merged push lists that equal their merge lists need no extra acceptance', () => {
    const r = run(
      doc(
        rule({ pattern: 'rel*', restrictPushes: [user('1')], restrictMerges: [user('1')] }),
        rule({ pattern: 'rel**', restrictPushes: [user('1')], restrictMerges: [user('1')] }),
      ),
      { accept: ['branch-rules.patterns-merged', 'branch-rules.pattern-approximated'] },
    );
    expect(r.preTasks).toEqual([]);
  });
});

describe('overlapping patterns (ADR-0113)', () => {
  it('[FAC-BRR-003] a literal rule is folded with a glob that matches it', () => {
    const r = run(
      doc(
        rule({ pattern: 'main', blockForcePush: true }),
        rule({ pattern: '*', blockDeletion: true }),
      ),
      NONE_ACCEPTED,
    );
    const main = (r.desired as BranchRules).rules.find((x) => x.pattern === 'main') as BranchRule;
    expect(main).toMatchObject({ blockForcePush: true, blockDeletion: true });
    // The glob rule is still emitted for the branches it matches by itself.
    const star = (r.desired as BranchRules).rules.find((x) => x.pattern === '*') as BranchRule;
    expect(star).toMatchObject({ blockForcePush: false, blockDeletion: true });
    const d = decision(r, at('main'));
    expect(d).toMatchObject({ fidelity: 'lossy', policyKey: 'branch-rules.patterns-merged' });
    expect(d?.note).toContain('"*"');
  });

  it('[FAC-BRR-003] `*` does not match a name with a slash, so it does not fold into `a/b`', () => {
    const r = run(doc(rule({ pattern: 'a/b' }), rule({ pattern: '*', blockDeletion: true })));
    const ab = (r.desired as BranchRules).rules.find((x) => x.pattern === 'a/b') as BranchRule;
    expect(ab.blockDeletion).toBe(false);
  });

  it('[FAC-BRR-003] a match-everything rule folds into every other rule', () => {
    const r = run(
      doc(
        rule({ pattern: 'release/*', blockForcePush: true }),
        rule({ pattern: '**', blockDeletion: true }),
      ),
      NONE_ACCEPTED,
    );
    const rel = (r.desired as BranchRules).rules.find(
      (x) => x.pattern === 'release/*',
    ) as BranchRule;
    expect(rel).toMatchObject({ blockForcePush: true, blockDeletion: true });
    expect(decision(r, at('release/*'))?.policyKey).toBe('branch-rules.patterns-merged');
    // A wildcard rule folded under another wildcard rule depends on creation order.
    expect(decision(r, at('release/*', 'overlap'))?.policyKey).toBe(
      'branch-rules.overlap-unresolved',
    );
    expect(r.preTasks.map((f) => f.params.policyKey)).toEqual([
      'branch-rules.overlap-unresolved',
      'branch-rules.patterns-merged',
    ]);
  });

  it('[FAC-BRR-003] equivalent patterns after normalization become one rule', () => {
    const r = run(doc(rule({ pattern: 'a/**' }), rule({ pattern: 'a/**/**' })));
    expect((r.desired as BranchRules).rules.map((x) => x.pattern)).toEqual(['a/**/*']);
  });

  it('[FAC-BRR-003] partial overlap is reported as overlap-unresolved at the narrower rule', () => {
    const r = run(
      doc(rule({ pattern: 'release/*x' }), rule({ pattern: 'release/v1*' })),
      NONE_ACCEPTED,
    );
    expect((r.desired as BranchRules).rules).toHaveLength(2);
    const d = decision(r, at('release/v1*', 'overlap'));
    expect(d).toMatchObject({ fidelity: 'lossy', policyKey: 'branch-rules.overlap-unresolved' });
    expect(d?.note).toContain('"release/*x"');
    expect(d?.note).toContain('one rule per branch');
    expect(decision(r, at('release/*x', 'overlap'))).toBeUndefined();
    expect(r.preTasks.map((f) => f.params.policyKey)).toEqual(['branch-rules.overlap-unresolved']);
  });

  it('[FAC-BRR-003] globs with the same-length prefix are reported on both rules', () => {
    const r = run(doc(rule({ pattern: 'a*b' }), rule({ pattern: 'a*c' })), NONE_ACCEPTED);
    expect(decision(r, at('a*b', 'overlap'))).toBeDefined();
    expect(decision(r, at('a*c', 'overlap'))).toBeDefined();
  });

  it('[FAC-BRR-003] patterns that cannot select the same branch need nothing', () => {
    const r = run(
      doc(
        rule({ pattern: 'feature/*' }),
        rule({ pattern: 'release/*' }),
        rule({ pattern: 'main' }),
      ),
      NONE_ACCEPTED,
    );
    expect(r.decisions).toEqual([]);
    expect(r.preTasks).toEqual([]);
  });

  it('[FAC-BRR-003] a literal against a glob it does not match is not an overlap', () => {
    const r = run(doc(rule({ pattern: 'main' }), rule({ pattern: 'release/*' })));
    expect(r.decisions).toEqual([]);
  });

  it('[FAC-BRR-003] a literal against a glob with operators cannot be decided: overlap-unresolved', () => {
    const r = run(doc(rule({ pattern: 'main' }), rule({ pattern: 'ma?n' })), NONE_ACCEPTED);
    expect(decision(r, at('main', 'overlap'))?.policyKey).toBe('branch-rules.overlap-unresolved');
  });

  it('[FAC-BRR-003] two literals never overlap', () => {
    const r = run(doc(rule({ pattern: 'a' }), rule({ pattern: 'b' })));
    expect(r.decisions).toEqual([]);
  });

  it('[FAC-BRR-003] segment globs are matched like the target does', () => {
    const covered = (glob: string, name: string) => {
      const r = run(doc(rule({ pattern: name }), rule({ pattern: glob, blockDeletion: true })));
      const target = convertPattern(name).pattern;
      return (
        (r.desired as BranchRules).rules.find((x) => x.pattern === target)?.blockDeletion === true
      );
    };
    expect(covered('rel*', 'release')).toBe(true);
    expect(covered('*lease', 'release')).toBe(true);
    expect(covered('r*l*e', 'release')).toBe(true);
    expect(covered('r*z*e', 'release')).toBe(false);
    expect(covered('a*bc', 'abc')).toBe(true);
    expect(covered('ab*bc', 'abc')).toBe(false);
    expect(covered('x/**/z', 'x/z')).toBe(true);
    expect(covered('x/**/z', 'x/y/w/z')).toBe(true);
    expect(covered('x/**/z', 'x/y/w')).toBe(false);
    expect(covered('x/*', 'x/y/z')).toBe(false);
    expect(covered('x/*/z', 'x/y')).toBe(false);
  });

  it('[FAC-BRR-003] folding does not depend on the order of the source rules', () => {
    const a = rule({ pattern: 'main', blockForcePush: true });
    const b = rule({ pattern: '*', blockDeletion: true });
    expect(run(doc(a, b), NONE_ACCEPTED)).toEqual(run(doc(b, a), NONE_ACCEPTED));
  });
});

// -- creation order among wildcard rules (ADR-0113) ----------------------------------------------

describe('wildcard rules folded under wildcard rules depend on creation order (ADR-0113)', () => {
  /** `translate` called directly, so the array order it returns is visible (the engine sorts it). */
  function raw(source: BranchRules) {
    return translateBranchRules(source, {
      ...env(NONE_ACCEPTED),
      sourceCaps: NO_CAPABILITY,
      targetCaps: NO_CAPABILITY,
      deps: {},
    });
  }

  const releaseAndAll = [
    rule({ pattern: '**', blockDeletion: true }),
    rule({ pattern: 'release/**', changeRequest: cr({ minApprovals: 2 }) }),
  ];

  it('[FAC-BRR-003] `**` and `release/**`: overlap-unresolved at the folded rule, which is applied first', () => {
    const r = run(doc(...releaseAndAll), NONE_ACCEPTED);
    const d = decision(r, at('release/**/*', 'overlap'));
    expect(d).toMatchObject({ fidelity: 'lossy', policyKey: 'branch-rules.overlap-unresolved' });
    expect(d?.note).toContain('"**/*"');
    expect(d?.note).toContain('older wildcard rule');
    expect(d?.note).toContain('created before');
    expect(decision(r, at('release/**/*'))?.policyKey).toBe('branch-rules.patterns-merged');
    expect(decision(r, at('**/*', 'overlap'))).toBeUndefined();
    const rules = (r.desired as BranchRules).rules;
    expect(rules.find((x) => x.pattern === 'release/**/*')).toMatchObject({
      blockDeletion: true,
      changeRequest: { minApprovals: 2 },
    });
    // The engine stores rules sorted by key; the apply order is computed from the patterns.
    expect(rules.map((x) => x.pattern)).toEqual(['**/*', 'release/**/*']);
    expect(branchRuleApplyOrder(rules).map((x) => x.pattern)).toEqual(['release/**/*', '**/*']);
    expect(raw(doc(...releaseAndAll)).desired.rules.map((x) => x.pattern)).toEqual([
      'release/**/*',
      '**/*',
    ]);
  });

  it('[FAC-BRR-003] `*` and `**`: `*` is folded, reported and applied first', () => {
    const r = run(
      doc(
        rule({ pattern: '**', blockDeletion: true }),
        rule({ pattern: '*', blockForcePush: true }),
      ),
      NONE_ACCEPTED,
    );
    const d = decision(r, at('*', 'overlap'));
    expect(d).toMatchObject({ fidelity: 'lossy', policyKey: 'branch-rules.overlap-unresolved' });
    expect(d?.note).toContain('"**/*"');
    expect((r.desired as BranchRules).rules.find((x) => x.pattern === '*')).toMatchObject({
      blockDeletion: true,
      blockForcePush: true,
    });
    const order = branchRuleApplyOrder((r.desired as BranchRules).rules).map((x) => x.pattern);
    expect(order).toEqual(['*', '**/*']);
  });

  it('[FAC-BRR-003] a literal folded under globs is only patterns-merged: an exact name always wins', () => {
    const r = run(
      doc(
        rule({ pattern: 'release/1.0', blockForcePush: true }),
        rule({ pattern: 'release/*', blockDeletion: true }),
        rule({ pattern: '**' }),
      ),
      NONE_ACCEPTED,
    );
    expect(decision(r, at('release/1.0', 'overlap'))).toBeUndefined();
    expect(decision(r, at('release/1.0'))?.policyKey).toBe('branch-rules.patterns-merged');
    expect(decision(r, at('release/*', 'overlap'))?.policyKey).toBe(
      'branch-rules.overlap-unresolved',
    );
    const order = branchRuleApplyOrder((r.desired as BranchRules).rules).map((x) => x.pattern);
    expect(order).toEqual(['release/1.0', 'release/*', '**/*']);
  });

  it('[FAC-BRR-003] the result and the apply order do not depend on the input order', () => {
    const rules = [
      ...releaseAndAll,
      rule({ pattern: '*', blockForcePush: true }),
      rule({ pattern: 'main' }),
      rule({ pattern: 'release/v1*' }),
    ];
    const forward = raw(doc(...rules));
    const backward = raw(doc(...[...rules].reverse()));
    expect(backward).toEqual(forward);
    expect(run(doc(...[...rules].reverse()), NONE_ACCEPTED)).toEqual(
      run(doc(...rules), NONE_ACCEPTED),
    );
    expect(forward.desired.rules.map((x) => x.pattern)).toEqual([
      'main',
      'release/v1*',
      'release/**/*',
      '*',
      '**/*',
    ]);
  });

  it('[FAC-BRR-003] the apply order puts every rule before the rules folded into it', () => {
    const patterns = [
      'main',
      'a/b',
      '*',
      'release/*',
      'release/**/*',
      'release/v1*',
      'x?y',
      '**/*',
    ];
    const order = branchRuleApplyOrder(patterns.map((pattern) => ({ pattern }))).map(
      (x) => x.pattern,
    );
    for (const wide of patterns) {
      for (const narrow of patterns) {
        if (covers(wide, narrow)) expect(order.indexOf(narrow)).toBeLessThan(order.indexOf(wide));
      }
    }
  });
});

describe('glob-under-glob inclusion and apply order (ADR-0113)', () => {
  const desiredOf = (r: ReturnType<typeof run>) => (r.desired as BranchRules).rules;
  const find = (r: ReturnType<typeof run>, pattern: string) =>
    desiredOf(r).find((x) => x.pattern === pattern) as BranchRule;
  const orderOf = (r: ReturnType<typeof run>) =>
    branchRuleApplyOrder(desiredOf(r)).map((x) => x.pattern);

  it('[FAC-BRR-003] `*` and `*hotfix`: the narrower rule is folded, reported and applied first', () => {
    const r = run(
      doc(
        rule({ pattern: '*', blockDeletion: true }),
        rule({ pattern: '*hotfix', blockForcePush: true }),
      ),
      NONE_ACCEPTED,
    );
    expect(find(r, '*hotfix')).toMatchObject({ blockDeletion: true, blockForcePush: true });
    expect(find(r, '*')).toMatchObject({ blockDeletion: true, blockForcePush: false });
    expect(decision(r, at('*hotfix'))?.policyKey).toBe('branch-rules.patterns-merged');
    const d = decision(r, at('*hotfix', 'overlap'));
    expect(d).toMatchObject({ fidelity: 'lossy', policyKey: 'branch-rules.overlap-unresolved' });
    expect(d?.note).toContain('"*"');
    expect(decision(r, at('*', 'overlap'))).toBeUndefined();
    expect(orderOf(r)).toEqual(['*hotfix', '*']);
  });

  it('[FAC-BRR-003] `release/*` and `release/**/*`: the one-level rule is folded and applied first', () => {
    const r = run(
      doc(
        rule({ pattern: 'release/**', changeRequest: cr({ minApprovals: 2 }) }),
        rule({ pattern: 'release/*', blockDeletion: true }),
      ),
      NONE_ACCEPTED,
    );
    expect(find(r, 'release/*')).toMatchObject({
      blockDeletion: true,
      changeRequest: { minApprovals: 2 },
    });
    expect(decision(r, at('release/*', 'overlap'))?.note).toContain('"release/**/*"');
    expect(decision(r, at('release/**/*', 'overlap'))).toBeUndefined();
    expect(orderOf(r)).toEqual(['release/*', 'release/**/*']);
  });

  it('[FAC-BRR-003] globs without `**` and with different segment counts cannot overlap', () => {
    const r = run(doc(rule({ pattern: 'release/*' }), rule({ pattern: 'release/*/rc' })));
    expect(r.decisions).toEqual([]);
  });

  it('[FAC-BRR-003] a pattern with `]` is a wildcard rule for priority: overlap-unresolved under `**`', () => {
    const r = run(doc(rule({ pattern: 'foo]' }), rule({ pattern: '**' })), NONE_ACCEPTED);
    expect(decision(r, at('foo]', 'overlap'))?.policyKey).toBe('branch-rules.overlap-unresolved');
    expect(orderOf(r)).toEqual(['foo]', '**/*']);
  });

  it('[FAC-BRR-003] property: every rule comes before the rules that cover it, whatever the input order', () => {
    let seed = 52;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pieces = ['a', 'b', '*', 'a*', '*a', '*b*', '**', 'a]'];
    const pattern = () =>
      Array.from({ length: 1 + random(3) }, () => pieces[random(pieces.length)]).join('/');
    for (let round = 0; round < 300; round += 1) {
      const patterns = [
        ...new Set(Array.from({ length: 2 + random(6) }, () => convertPattern(pattern()).pattern)),
      ];
      const rules = patterns.map((p) => ({ pattern: p }));
      const order = branchRuleApplyOrder(rules).map((x) => x.pattern);
      expect(branchRuleApplyOrder([...rules].reverse()).map((x) => x.pattern)).toEqual(order);
      for (const wide of patterns) {
        for (const narrow of patterns) {
          if (covers(wide, narrow)) {
            expect(order.indexOf(narrow), `${narrow} before ${wide}`).toBeLessThan(
              order.indexOf(wide),
            );
          }
        }
      }
    }
  });
});
