/** repository-settings (FAC-SET). */
import { z } from 'zod';
import { declareFacet } from '../common.ts';

export type RepositorySettings = {
  description: string; // normalized: trimmed, framework prefix stripped (FAC-SET-003)
  homepage: string | null;
  visibility: 'private' | 'public';
  features: { issues: boolean; wiki: boolean };
  forking: 'allowed' | 'private-only' | 'disallowed';
};

export const repositorySettingsSchema: z.ZodType<RepositorySettings> = z.strictObject({
  description: z.string(),
  homepage: z.string().nullable(),
  visibility: z.enum(['private', 'public']),
  features: z.strictObject({ issues: z.boolean(), wiki: z.boolean() }),
  forking: z.enum(['allowed', 'private-only', 'disallowed']),
});

export const repositorySettingsFacet = declareFacet({
  key: 'repository-settings',
  scope: 'repository',
  schema: repositorySettingsSchema,
});
