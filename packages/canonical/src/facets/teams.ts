/** teams (endpoint-level, FAC-END). */
import { z } from 'zod';
import {
  declareFacet,
  nonEmpty,
  type PrincipalEntry,
  principalCollection,
  principalEntrySchema,
} from '../common.ts';

export type Teams = { teams: { slug: string; name: string; members: PrincipalEntry[] }[] }; // key: slug

export const teamsSchema: z.ZodType<Teams> = z.strictObject({
  teams: z.array(
    z.strictObject({ slug: nonEmpty, name: z.string(), members: z.array(principalEntrySchema) }),
  ),
});

export const teamsFacet = declareFacet({
  key: 'teams',
  scope: 'endpoint',
  schema: teamsSchema,
  collections: [{ path: '/teams', key: 'slug' }, principalCollection('/teams/members')],
});
