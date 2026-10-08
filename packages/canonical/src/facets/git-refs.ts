/** git-refs (FAC-GIT). */
import { z } from 'zod';
import { declareFacet, nonEmpty, nonNegativeInt } from '../common.ts';

export type GitRefs = {
  defaultBranch: string | null;
  refs: { name: string; kind: 'branch' | 'tag'; target: string; peeled?: string }[]; // key: name
  ignoredRefs: string[]; // full names outside refs/heads/* and refs/tags/*
  lfs: { oids?: string[]; count?: number; bytes?: number }; // filled during runs only
};

export const gitRefsSchema: z.ZodType<GitRefs> = z.strictObject({
  defaultBranch: nonEmpty.nullable(),
  refs: z.array(
    z.strictObject({
      name: nonEmpty,
      kind: z.enum(['branch', 'tag']),
      target: nonEmpty,
      peeled: nonEmpty.optional(),
    }),
  ),
  ignoredRefs: z.array(nonEmpty),
  lfs: z.strictObject({
    oids: z.array(nonEmpty).optional(),
    count: nonNegativeInt.optional(),
    bytes: nonNegativeInt.optional(),
  }),
});

export const gitRefsFacet = declareFacet({
  key: 'git-refs',
  scope: 'repository',
  schema: gitRefsSchema,
  collections: [{ path: '/refs', key: 'name' }],
  sets: ['/ignoredRefs', '/lfs/oids'],
});
