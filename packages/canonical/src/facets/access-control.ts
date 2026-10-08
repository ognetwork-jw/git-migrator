/** access-control (FAC-ACL). */
import { z } from 'zod';
import { declareFacet, type PrincipalRef, principalRefSchema } from '../common.ts';

export const ACCESS_ROLES = ['read', 'triage', 'write', 'maintain', 'admin'] as const;
export type AccessRole = (typeof ACCESS_ROLES)[number];

export type AccessControl = {
  grants: { principal: PrincipalRef; role: AccessRole }[]; // key: principal (kind:id)
};

export const accessControlSchema: z.ZodType<AccessControl> = z.strictObject({
  grants: z.array(z.strictObject({ principal: principalRefSchema, role: z.enum(ACCESS_ROLES) })),
});

export const accessControlFacet = declareFacet({
  key: 'access-control',
  scope: 'repository',
  schema: accessControlSchema,
  collections: [{ path: '/grants', key: 'principal' }],
});
