/** merge-settings (FAC-MRG). */
import { z } from 'zod';
import { declareFacet } from '../common.ts';

export const MERGE_STRATEGIES = ['merge-commit', 'squash', 'rebase', 'fast-forward-only'] as const;
export type MergeStrategy = (typeof MERGE_STRATEGIES)[number];

export type MergeSettings = {
  allowed: MergeStrategy[]; // set
  deleteBranchOnMerge: boolean;
};

export const mergeSettingsSchema: z.ZodType<MergeSettings> = z.strictObject({
  allowed: z.array(z.enum(MERGE_STRATEGIES)),
  deleteBranchOnMerge: z.boolean(),
});

export const mergeSettingsFacet = declareFacet({
  key: 'merge-settings',
  scope: 'repository',
  schema: mergeSettingsSchema,
  sets: ['/allowed'],
});
