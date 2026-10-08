/** pipelines (FAC-PIP). */
import { z } from 'zod';
import { declareFacet, nonEmpty } from '../common.ts';

export type Pipelines = {
  files: { path: string; sha256: string }[]; // key: path
  enabled: boolean;
  translation: { supported: boolean; unsupported: string[] }; // computed in translate
};

export const pipelinesSchema: z.ZodType<Pipelines> = z.strictObject({
  files: z.array(
    z.strictObject({
      path: nonEmpty,
      sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/, { message: 'sha256 must be 64 lowercase hex digits' }),
    }),
  ),
  enabled: z.boolean(),
  translation: z.strictObject({ supported: z.boolean(), unsupported: z.array(nonEmpty) }),
});

export const pipelinesFacet = declareFacet({
  key: 'pipelines',
  scope: 'repository',
  schema: pipelinesSchema,
  collections: [{ path: '/files', key: 'path' }],
  sets: ['/translation/unsupported'],
});
