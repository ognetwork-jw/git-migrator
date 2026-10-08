/** members (endpoint-level, FAC-END). */
import { z } from 'zod';
import { declareFacet, type PrincipalRef, principalRefSchema } from '../common.ts';

export type Members = { members: { principal: PrincipalRef; role: 'member' | 'admin' }[] }; // key: principal

export const membersSchema: z.ZodType<Members> = z.strictObject({
  members: z.array(
    z.strictObject({ principal: principalRefSchema, role: z.enum(['member', 'admin']) }),
  ),
});

export const membersFacet = declareFacet({
  key: 'members',
  scope: 'endpoint',
  schema: membersSchema,
  collections: [{ path: '/members', key: 'principal' }],
});
