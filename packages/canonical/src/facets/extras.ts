/** extras, detect-only (FAC-EXT). */
import { z } from 'zod';
import { declareFacet, nonNegativeInt } from '../common.ts';

export type Extras = {
  wikiPopulated: boolean;
  issueCount: number;
  downloadCount: number;
  releaseCount: number;
};

export const extrasSchema: z.ZodType<Extras> = z.strictObject({
  wikiPopulated: z.boolean(),
  issueCount: nonNegativeInt,
  downloadCount: nonNegativeInt,
  releaseCount: nonNegativeInt,
});

export const extrasFacet = declareFacet({
  key: 'extras',
  scope: 'repository',
  schema: extrasSchema,
});
