import { createRoute, z } from '@hono/zod-openapi';
import { CSV_ERROR_CODES } from './csv.ts';
import { MAX_REASON } from './service.ts';

const problemSchema = z.object({ type: z.string(), title: z.string(), status: z.number() });
const problemContent = { 'application/problem+json': { schema: problemSchema } };
const problems = (...codes: (401 | 403 | 404 | 409 | 415 | 422)[]) =>
  Object.fromEntries(
    codes.map((status) => [status, { description: 'Problem', content: problemContent }]),
  );
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { sessionCookie: [] }];

const Id = z.string().min(1).max(64);
export const RouteParam = z.object({ id: Id });
export const MappingParam = z.object({ id: Id, mappingId: Id });

const MAPPING_STATUS = [
  'suggested',
  'confirmed',
  'excluded',
  'pending_invite',
  'unmapped',
] as const;

const IdentityRefSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  login: z.string().nullable(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
});

export const IdentityMappingSchema = z
  .object({
    id: z.string(),
    status: z.enum(MAPPING_STATUS),
    method: z.string().nullable(),
    confidence: z.number().nullable(),
    decidedAt: z.string().nullable(),
    decidedBy: z.string().nullable(),
    reason: z.string().nullable(),
    source: IdentityRefSchema,
    target: IdentityRefSchema.nullable(),
  })
  .openapi('IdentityMapping');

const GroupRefSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  memberCount: z.number().int(),
});

export const GroupMappingSchema = z
  .object({
    id: z.string(),
    status: z.enum(MAPPING_STATUS),
    plannedSlug: z.string(),
    collision: z.boolean(),
    sourceGroup: GroupRefSchema,
    targetGroup: GroupRefSchema.nullable(),
  })
  .openapi('GroupMapping');

export const RouteSummarySchema = z
  .object({ id: z.string(), sourceEndpointId: z.string(), targetEndpointId: z.string() })
  .openapi('RouteSummary');

export const listRoutesRoute = createRoute({
  method: 'get',
  path: '/routes',
  summary: 'Routes that mapping pages can be opened for',
  security,
  responses: {
    200: { description: 'Routes', content: json(z.object({ items: z.array(RouteSummarySchema) })) },
    ...problems(401),
  },
});

export const listIdentityMappingsRoute = createRoute({
  method: 'get',
  path: '/routes/{id}/identity-mappings',
  summary: 'Identity Mappings of a Route',
  security,
  request: {
    params: RouteParam,
    query: z.object({
      status: z.enum(MAPPING_STATUS).optional(),
      q: z.string().max(200).optional(),
      cursor: z.string().min(1).max(512).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  },
  responses: {
    200: {
      description: 'A page',
      content: json(
        z.object({ items: z.array(IdentityMappingSchema), nextCursor: z.string().nullable() }),
      ),
    },
    ...problems(401, 404, 422),
  },
});

export const decideIdentityMappingRoute = createRoute({
  method: 'post',
  path: '/routes/{id}/identity-mappings/{mappingId}/{action}',
  summary: 'Confirm, exclude or unmap an Identity Mapping',
  security,
  request: {
    params: MappingParam.extend({ action: z.enum(['confirm', 'exclude', 'unmap']) }),
    body: {
      required: false,
      content: json(
        z.object({
          targetIdentityId: Id.optional(),
          reason: z
            .string()
            .max(MAX_REASON * 2)
            .optional(),
        }),
      ),
    },
  },
  responses: {
    200: { description: 'The mapping', content: json(IdentityMappingSchema) },
    ...problems(401, 403, 404, 409, 422),
  },
});

const CsvRowSchema = z.object({
  line: z.number().int(),
  source: z.string(),
  target: z.string(),
  action: z.string(),
  ok: z.boolean(),
  errors: z.array(z.enum(CSV_ERROR_CODES)),
  outcome: z.enum(['mapped', 'invited', 'excluded', 'unchanged', 'replaces_decision']).nullable(),
});

export const CsvReportSchema = z
  .object({
    dryRun: z.boolean(),
    ok: z.boolean(),
    fileErrors: z.array(z.enum(CSV_ERROR_CODES)),
    rows: z.array(CsvRowSchema),
    summary: z.object({
      total: z.number().int(),
      valid: z.number().int(),
      invalid: z.number().int(),
      mapped: z.number().int(),
      invited: z.number().int(),
      excluded: z.number().int(),
      unchanged: z.number().int(),
      replaced: z.number().int(),
    }),
  })
  .openapi('IdentityMappingCsvReport');

export const importIdentityMappingsRoute = createRoute({
  method: 'post',
  path: '/routes/{id}/identity-mappings/import',
  summary: 'Import Identity Mappings from CSV (header source,target,action)',
  description:
    'The body is CSV text (`text/csv`). With `dryRun=true` the file is validated and reported per row, and nothing is written. Without it the file is applied only if every row is valid; otherwise the answer is 422 and nothing changes. Echoed cells starting with = + - @ are prefixed with an apostrophe.',
  security,
  request: {
    params: RouteParam,
    query: z.object({ dryRun: z.enum(['true', 'false']).optional() }),
    body: { required: true, content: { 'text/csv': { schema: z.string() } } },
  },
  responses: {
    200: { description: 'The report', content: json(CsvReportSchema) },
    ...problems(401, 403, 404, 415, 422),
  },
});

export const listGroupMappingsRoute = createRoute({
  method: 'get',
  path: '/routes/{id}/group-mappings',
  summary: 'Group Mappings of a Route',
  security,
  request: { params: RouteParam },
  responses: {
    200: {
      description: 'Group Mappings',
      content: json(z.object({ items: z.array(GroupMappingSchema) })),
    },
    ...problems(401, 404),
  },
});

export const decideGroupMappingRoute = createRoute({
  method: 'post',
  path: '/routes/{id}/group-mappings/{mappingId}/{action}',
  summary: 'Confirm a Group Mapping or change its planned slug',
  security,
  request: {
    params: MappingParam.extend({ action: z.enum(['confirm', 'rename']) }),
    body: {
      required: false,
      content: json(
        z.object({ targetGroupId: Id.optional(), plannedSlug: z.string().max(200).optional() }),
      ),
    },
  },
  responses: {
    200: { description: 'The mapping', content: json(GroupMappingSchema) },
    ...problems(401, 403, 404, 409, 422),
  },
});

export const listTargetIdentitiesRoute = createRoute({
  method: 'get',
  path: '/routes/{id}/target-identities',
  summary: 'Identities of the Route target that a source Identity can be mapped to',
  security,
  request: {
    params: RouteParam,
    query: z.object({
      q: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }),
  },
  responses: {
    200: {
      description: 'Identities',
      content: json(z.object({ items: z.array(IdentityRefSchema) })),
    },
    ...problems(401, 404),
  },
});
