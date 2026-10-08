/** environments (FAC-ENV). */
import { z } from 'zod';
import { declareFacet, nonEmpty } from '../common.ts';

export type Environments = {
  environments: {
    name: string;
    category: 'test' | 'staging' | 'production' | null;
    deploymentBranches: string[] | null;
  }[];
}; // key: name

export const environmentsSchema: z.ZodType<Environments> = z.strictObject({
  environments: z.array(
    z.strictObject({
      name: nonEmpty,
      category: z.enum(['test', 'staging', 'production']).nullable(),
      deploymentBranches: z.array(nonEmpty).nullable(),
    }),
  ),
});

export const environmentsFacet = declareFacet({
  key: 'environments',
  scope: 'repository',
  schema: environmentsSchema,
  collections: [{ path: '/environments', key: 'name' }],
  sets: ['/environments/deploymentBranches'],
});
