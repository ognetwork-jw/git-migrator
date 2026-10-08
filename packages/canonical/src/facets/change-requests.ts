/** change-requests (FAC-CRQ). */
import { z } from 'zod';
import { declareFacet, nonEmpty } from '../common.ts';

export type ChangeRequests = { open: { id: string; title: string; url: string }[] }; // key: id

export const changeRequestsSchema: z.ZodType<ChangeRequests> = z.strictObject({
  open: z.array(z.strictObject({ id: nonEmpty, title: z.string(), url: nonEmpty })),
});

export const changeRequestsFacet = declareFacet({
  key: 'change-requests',
  scope: 'repository',
  schema: changeRequestsSchema,
  collections: [{ path: '/open', key: 'id' }],
});
