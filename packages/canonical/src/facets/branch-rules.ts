/** branch-rules (FAC-BRR). */
import { z } from 'zod';
import {
  declareFacet,
  nonEmpty,
  nonNegativeInt,
  type PrincipalEntry,
  principalCollection,
  principalEntrySchema,
} from '../common.ts';

export type BranchRule = {
  // key: pattern
  pattern: string; // glob, canonical: '**' crosses '/', '*' does not
  enforcement: 'advisory' | 'enforced';
  restrictPushes: PrincipalEntry[] | null; // null = unrestricted; [] = nobody
  restrictMerges: PrincipalEntry[] | null;
  blockForcePush: boolean;
  forcePushExempt: PrincipalEntry[];
  blockDeletion: boolean;
  deletionExempt: PrincipalEntry[];
  changeRequest: null | {
    minApprovals: number;
    requireCodeOwnerApproval: boolean; // from "default reviewer approvals"
    dismissStaleApprovals: boolean;
    requireNoChangesRequested: boolean;
    requireTasksResolved: boolean;
    requireUpToDate: boolean;
    minPassingBuilds: number; // 0 = none
  };
};
export type BranchRules = { rules: BranchRule[] };

const principals = z.array(principalEntrySchema);

export const branchRuleSchema: z.ZodType<BranchRule> = z.strictObject({
  pattern: nonEmpty,
  enforcement: z.enum(['advisory', 'enforced']),
  restrictPushes: principals.nullable(),
  restrictMerges: principals.nullable(),
  blockForcePush: z.boolean(),
  forcePushExempt: principals,
  blockDeletion: z.boolean(),
  deletionExempt: principals,
  changeRequest: z
    .strictObject({
      minApprovals: nonNegativeInt,
      requireCodeOwnerApproval: z.boolean(),
      dismissStaleApprovals: z.boolean(),
      requireNoChangesRequested: z.boolean(),
      requireTasksResolved: z.boolean(),
      requireUpToDate: z.boolean(),
      minPassingBuilds: nonNegativeInt,
    })
    .nullable(),
});

export const branchRulesSchema: z.ZodType<BranchRules> = z.strictObject({
  rules: z.array(branchRuleSchema),
});

export const branchRulesFacet = declareFacet({
  key: 'branch-rules',
  scope: 'repository',
  schema: branchRulesSchema,
  collections: [
    { path: '/rules', key: 'pattern' },
    principalCollection('/rules/restrictPushes'),
    principalCollection('/rules/restrictMerges'),
    principalCollection('/rules/forcePushExempt'),
    principalCollection('/rules/deletionExempt'),
  ],
});
