/** code-ownership (FAC-COD). */
import { z } from 'zod';
import {
  declareFacet,
  nonEmpty,
  type PrincipalEntry,
  principalCollection,
  principalEntrySchema,
} from '../common.ts';

export type CodeOwnership = { owners: { pattern: string; principals: PrincipalEntry[] }[] }; // key: pattern

export const codeOwnershipSchema: z.ZodType<CodeOwnership> = z.strictObject({
  owners: z.array(z.strictObject({ pattern: nonEmpty, principals: z.array(principalEntrySchema) })),
});

export const codeOwnershipFacet = declareFacet({
  key: 'code-ownership',
  scope: 'repository',
  schema: codeOwnershipSchema,
  collections: [{ path: '/owners', key: 'pattern' }, principalCollection('/owners/principals')],
});
