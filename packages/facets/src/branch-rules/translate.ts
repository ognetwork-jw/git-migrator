import {
  type BranchRule,
  type BranchRules,
  branchPatternPrefix,
  branchRuleApplyOrder,
  isLiteralBranchPattern,
  type PrincipalEntry,
  type PrincipalRef,
} from '@git-migrator/canonical';
import {
  type FieldDecision,
  type FieldPath,
  type Finding,
  formatFieldPath,
  itemSeg,
  type PolicyKey,
  seg,
  type TranslateContext,
  type TranslationResult,
} from '@git-migrator/core';
import { mergeRules } from './merge.ts';
import { covers, mayOverlap } from './overlap.ts';
import { convertPattern } from './pattern.ts';
import { FACET, PrincipalIssues, resolvePrincipals } from './principals.ts';

/** Largest required-approval count the target accepts (FAC-BRR-002). */
export const MAX_APPROVALS = 6;

export const POLICY = {
  advisoryEnforced: 'branch-rules.advisory-enforced',
  mergeRestrictionAsPush: 'branch-rules.merge-restriction-as-push',
  exemptionsDropped: 'branch-rules.exemptions-dropped',
  approvalsCapped: 'branch-rules.approvals-capped',
  tasksAsConversations: 'branch-rules.tasks-as-conversations',
  patternApproximated: 'branch-rules.pattern-approximated',
  patternsMerged: 'branch-rules.patterns-merged',
  overlapUnresolved: 'branch-rules.overlap-unresolved',
} as const satisfies Record<string, PolicyKey>;

function keyOf(e: PrincipalEntry): string {
  return `${e.principal.kind}:${e.principal.id}`;
}

function sameSet(a: readonly PrincipalEntry[], b: readonly PrincipalEntry[]): boolean {
  const left = new Set(a.map(keyOf));
  const right = new Set(b.map(keyOf));
  return left.size === right.size && [...left].every((k) => right.has(k));
}

/** The target cannot hold force-push exemptions when its capabilities say so (ADR-0040). */
function exemptionsAvailable(ctx: TranslateContext): boolean {
  const kind = ctx.targetCaps.fields['/rules/forcePushExempt']?.kind;
  return kind !== 'unsupported' && kind !== 'readOnly';
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

class Decisions {
  readonly #list: FieldDecision[] = [];

  translated(path: FieldPath, note: string): void {
    this.#list.push({ path, fidelity: 'translated', accepted: false, note });
  }

  lossy(path: FieldPath, policyKey: PolicyKey, note: string): void {
    this.#list.push({ path, fidelity: 'lossy', policyKey, accepted: false, note });
  }

  unsupported(path: FieldPath, note: string): void {
    this.#list.push({ path, fidelity: 'unsupported', accepted: false, note });
  }

  list(): FieldDecision[] {
    return this.#list;
  }
}

interface Group {
  readonly target: string;
  /** Effects of the conversions that are not lossless; empty when all are. */
  readonly effects: string[];
  readonly sources: BranchRule[];
}

/** Source rules grouped by target pattern, in apply order (ADR-0113). */
function groupRules(rules: readonly BranchRule[]): Group[] {
  const byTarget = new Map<string, Group>();
  for (const rule of [...rules].sort((a, b) => compareText(a.pattern, b.pattern))) {
    const conversion = convertPattern(rule.pattern);
    const group = byTarget.get(conversion.pattern) ?? {
      target: conversion.pattern,
      effects: [],
      sources: [],
    };
    group.sources.push(rule);
    if (!conversion.lossless) {
      group.effects.push(...conversion.effects.filter((e) => !group.effects.includes(e)));
    }
    byTarget.set(conversion.pattern, group);
  }
  return branchRuleApplyOrder(
    [...byTarget.values()].map((group) => ({ pattern: group.target, group })),
  ).map((x) => x.group);
}

/** Role-based write access of the target, from the translated access-control Facet (ADR-0111). */
function writers(ctx: TranslateContext): Set<string> | undefined {
  const desired = ctx.deps['access-control']?.desired as
    | { grants?: { principal: PrincipalRef; role: string }[] }
    | undefined;
  if (!Array.isArray(desired?.grants)) return undefined;
  return new Set(
    desired.grants
      .filter((g) => ['write', 'maintain', 'admin'].includes(g.role))
      .map((g) => keyOf({ principal: g.principal })),
  );
}

/** Splits resolved principals into those with write access and the rest (all kept when unknown). */
function withWriteAccess(
  entries: PrincipalEntry[],
  allowed: Set<string> | undefined,
): { kept: PrincipalEntry[]; dropped: string[] } {
  if (allowed === undefined) return { kept: entries, dropped: [] };
  return {
    kept: entries.filter((e) => allowed.has(keyOf(e))),
    dropped: entries.filter((e) => !allowed.has(keyOf(e))).map(keyOf),
  };
}

/**
 * FAC-BRR-002/003 and FAC-006. `desired` is in the target's terms: patterns in the target's
 * dialect (docs/adr/0110-branch-rule-pattern-and-desired-syntax.md) and target principals. Rules
 * are in apply order (`branchRuleApplyOrder`, ADR-0113), so a rule comes before every rule folded
 * into it.
 */
export function translateBranchRules(
  source: BranchRules,
  ctx: TranslateContext,
): TranslationResult<BranchRules> {
  const decisions = new Decisions();
  const issues = new PrincipalIssues();
  const postTasks: Finding[] = [];
  const allowed = writers(ctx);

  const rules: BranchRule[] = [];
  const groups = groupRules(source.rules);
  for (const group of groups) {
    const { target, effects, sources } = group;
    // Rules whose pattern matches every branch this one matches add their protection to it,
    // because the target applies a single rule per branch (ADR-0113).
    const folded = groups.filter((other) => covers(other.target, target));
    const all = [...sources, ...folded.flatMap((f) => f.sources)];
    const s = mergeRules(target, all);
    const at = (...names: string[]): FieldPath =>
      formatFieldPath([itemSeg('rules', 'pattern', target), ...names.map(seg)]);

    // Pattern (FAC-BRR-003).
    const first = sources[0] as BranchRule;
    if (effects.length > 0) {
      decisions.lossy(
        at('pattern'),
        POLICY.patternApproximated,
        `${sources.map((r) => JSON.stringify(r.pattern)).join(', ')} becomes ${JSON.stringify(target)}: ${effects.join('; ')}`,
      );
    } else if (target !== first.pattern) {
      decisions.translated(at('pattern'), 'pattern converted to the target dialect');
    }
    if (all.length > 1) {
      const names = (rs: BranchRule[]) => rs.map((r) => JSON.stringify(r.pattern)).join(', ');
      const notes = [
        ...(sources.length > 1 ? [`rules ${names(sources)} share this target pattern`] : []),
        ...(folded.length > 0
          ? [`rules ${names(folded.flatMap((f) => f.sources))} also match every branch it matches`]
          : []),
      ];
      decisions.lossy(
        formatFieldPath([itemSeg('rules', 'pattern', target)]),
        POLICY.patternsMerged,
        `${notes.join('; ')}; merged into the strictest combination`,
      );
    }
    // Among wildcard rules the target applies the oldest (ADR-0113). Desired is in apply order,
    // but rules that already exist on the target are older, so a wildcard rule folded under
    // another wildcard rule is protected only if it is created first.
    const quoted = (gs: readonly Group[]) => gs.map((o) => JSON.stringify(o.target)).join(', ');
    const olderWins = isLiteralBranchPattern(target)
      ? []
      : folded.filter((f) => !isLiteralBranchPattern(f.target));
    const narrower = groups.filter(
      (other) =>
        other !== group &&
        !covers(other.target, target) &&
        !covers(target, other.target) &&
        mayOverlap(target, other.target) &&
        branchPatternPrefix(target).length >= branchPatternPrefix(other.target).length,
    );
    const overlaps = [
      ...(olderWins.length > 0
        ? [
            `${quoted(olderWins)} also match every branch ${JSON.stringify(target)} matches; the target applies the older wildcard rule to a branch both match, so this rule's protection holds only if it is created before ${quoted(olderWins)}, which does not hold where those rules already exist on the target`,
          ]
        : []),
      ...(narrower.length > 0
        ? [
            `${JSON.stringify(target)} overlaps ${quoted(narrower)}; the target applies only one rule per branch, so protection from the other rule may not apply`,
          ]
        : []),
    ];
    if (overlaps.length > 0) {
      decisions.lossy(at('overlap'), POLICY.overlapUnresolved, overlaps.join('; '));
    }

    // Enforcement: the target always enforces.
    if (all.some((r) => r.enforcement === 'advisory')) {
      decisions.lossy(at('enforcement'), POLICY.advisoryEnforced, 'advisory rule is enforced');
    }

    // Push and merge restrictions: merging is a push on the target, which has one list. Principals
    // without write access are dropped: the list gets narrower, which fails safe (ADR-0111).
    const pushList = (resolved: PrincipalEntry[]): PrincipalEntry[] => {
      const { kept, dropped } = withWriteAccess(resolved, allowed);
      decisions.translated(
        at('restrictPushes'),
        dropped.length === 0
          ? 'push restriction also blocks branch creation'
          : `push restriction also blocks branch creation; principals without write access are left out: ${dropped.join(', ')}`,
      );
      return kept;
    };
    let restrictPushes: PrincipalEntry[] | null = null;
    if (s.restrictPushes !== null) {
      restrictPushes = pushList(
        resolvePrincipals(s.restrictPushes, at('restrictPushes'), ctx, issues),
      );
      if (s.restrictMerges !== null) {
        const dropsMerges =
          all.length > 1 &&
          all.some(
            (r) =>
              r.restrictMerges !== null &&
              (r.restrictPushes === null || !sameSet(r.restrictPushes, r.restrictMerges)),
          );
        if (dropsMerges) {
          decisions.lossy(
            at('restrictMerges'),
            POLICY.mergeRestrictionAsPush,
            'merge restrictions are applied as push restrictions; the merged allowance is the intersection of all lists',
          );
        } else if (sameSet(s.restrictPushes, s.restrictMerges)) {
          decisions.translated(at('restrictMerges'), 'same principals as the push restriction');
        } else {
          decisions.lossy(
            at('restrictMerges'),
            POLICY.mergeRestrictionAsPush,
            'merge restriction differs from the push restriction; only the push restriction is applied',
          );
        }
      }
    } else if (s.restrictMerges !== null) {
      restrictPushes = pushList(
        resolvePrincipals(s.restrictMerges, at('restrictPushes'), ctx, issues),
      );
      decisions.lossy(
        at('restrictMerges'),
        POLICY.mergeRestrictionAsPush,
        'merge restriction applied as a push restriction',
      );
    }

    // Force-push exemptions (ADR-0040): blockForcePush keeps the exemptions as bypass actors.
    let forcePushExempt: PrincipalEntry[] = [];
    if (s.forcePushExempt.length > 0) {
      if (exemptionsAvailable(ctx)) {
        const { kept, dropped } = withWriteAccess(
          resolvePrincipals(s.forcePushExempt, at('forcePushExempt'), ctx, issues),
          allowed,
        );
        forcePushExempt = kept;
        if (dropped.length === 0) {
          decisions.translated(at('forcePushExempt'), 'exempt principals become bypass actors');
        } else {
          decisions.lossy(
            at('forcePushExempt'),
            POLICY.exemptionsDropped,
            `principals without write access cannot be bypass actors: ${dropped.join(', ')}`,
          );
        }
      } else {
        decisions.lossy(
          at('forcePushExempt'),
          POLICY.exemptionsDropped,
          'the target cannot hold force-push exemptions; force pushes stay blocked for everyone',
        );
      }
    }
    if (s.deletionExempt.length > 0) {
      decisions.lossy(
        at('deletionExempt'),
        POLICY.exemptionsDropped,
        'the target has no deletion exemptions; deletion stays blocked for everyone',
      );
    }

    // Change-request rules.
    let changeRequest: BranchRule['changeRequest'] = null;
    if (s.changeRequest !== null) {
      const cr = s.changeRequest;
      const cat = (name: string): FieldPath => at('changeRequest', name);
      let minApprovals = cr.minApprovals;
      if (minApprovals > MAX_APPROVALS) {
        minApprovals = MAX_APPROVALS;
        decisions.lossy(
          cat('minApprovals'),
          POLICY.approvalsCapped,
          `required approvals capped at ${MAX_APPROVALS}`,
        );
      }
      if (cr.requireCodeOwnerApproval) {
        decisions.translated(
          cat('requireCodeOwnerApproval'),
          'effective with the code-ownership Change Request',
        );
      }
      // The target reports "no changes requested" exactly when reviews are required, so that is
      // the value `desired` holds (ADR-0112).
      const reviewsRequired =
        minApprovals >= 1 ||
        cr.requireCodeOwnerApproval ||
        cr.dismissStaleApprovals ||
        cr.requireNoChangesRequested;
      if (cr.requireNoChangesRequested || reviewsRequired) {
        decisions.translated(
          cat('requireNoChangesRequested'),
          'implied by required reviews on the target',
        );
      }
      if (cr.requireTasksResolved) {
        decisions.lossy(
          cat('requireTasksResolved'),
          POLICY.tasksAsConversations,
          'tasks become resolved conversations',
        );
      }
      if (cr.requireUpToDate) {
        decisions.translated(cat('requireUpToDate'), 'strict status checks');
      }
      if (cr.minPassingBuilds > 0) {
        decisions.unsupported(
          cat('minPassingBuilds'),
          'required check names are unknown before CI has run on the target',
        );
        postTasks.push({
          code: `${FACET}.configure-status-checks`,
          paths: [cat('minPassingBuilds')],
          params: { pattern: target },
        });
      }
      changeRequest = { ...cr, minApprovals, requireNoChangesRequested: reviewsRequired };
    }

    rules.push({
      pattern: target,
      enforcement: 'enforced',
      restrictPushes,
      restrictMerges: null,
      blockForcePush: s.blockForcePush,
      forcePushExempt,
      blockDeletion: s.blockDeletion,
      deletionExempt: [],
      changeRequest,
    });
  }

  return {
    desired: { rules },
    decisions: decisions.list(),
    blockers: issues.teamMissing(),
    preTasks: issues.unmapped(),
    postTasks: [...postTasks, ...issues.pending()],
    warnings: [],
  };
}
