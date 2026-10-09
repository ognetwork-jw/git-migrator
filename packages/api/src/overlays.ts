/**
 * Overlay writes (T-091, UI-032, DOM-001, DOM-003): the only way to create, change or delete an
 * Overlay. The RPC mount denies those writes (schema policy), because an Overlay's `data` depends
 * on its `facetKey` and a generic mount cannot validate it. Decisions: ADR-0362.
 */
import { type Capability, can } from '@git-migrator/auth';
import type { Db } from '@git-migrator/db';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Principal } from './principal.ts';
import { ProblemError, ProblemSchema } from './problem.ts';
import { type ApiServices, requireService } from './services.ts';

interface Env {
  Variables: { principal: Principal };
}

export interface OverlayDeps {
  readonly db: { readonly privileged: Db };
  readonly services: Partial<ApiServices>;
  readonly validationHook: (result: { success: boolean; error?: z.ZodError }, c: Context) => void;
}

const problemContent = { 'application/problem+json': { schema: ProblemSchema } };
const problems = (...codes: (401 | 403 | 404 | 422 | 503)[]) =>
  Object.fromEntries(
    codes.map((status) => [status, { description: 'Problem', content: problemContent }]),
  );
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { sessionCookie: [] }];
const Id = z.string().min(1).max(64);

function requireCapability(c: Context<Env>, capability: Capability): void {
  if (!can(c.get('principal').actor, capability)) {
    throw new ProblemError('forbidden', { detail: `requires the ${capability} capability` });
  }
}

// `data` is `unknown` here on purpose: the handler validates it against the Facet's schema, and a
// generic record parse could treat a `__proto__` key as a prototype assignment.
const DataSchema = z.unknown().openapi({
  type: 'object',
  description: 'A partial canonical document of the Facet. Unknown keys are refused.',
});

export const OverlaySchema = z
  .object({
    id: z.string(),
    routeId: z.string(),
    facetKey: z.string(),
    data: DataSchema,
    enabled: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Overlay');

const createRouteDef = createRoute({
  method: 'post',
  path: '/overlays',
  summary: 'Create an Overlay, validated against the Facet schema',
  security,
  request: {
    body: {
      required: true,
      content: json(
        z.object({
          routeId: Id,
          facetKey: z.string().min(1).max(64),
          data: DataSchema,
          enabled: z.boolean().optional(),
        }),
      ),
    },
  },
  responses: {
    201: { description: 'Created', content: json(OverlaySchema) },
    ...problems(401, 403, 422, 503),
  },
});

const patchRouteDef = createRoute({
  method: 'patch',
  path: '/overlays/{id}',
  summary: 'Change the document or the enabled flag of an Overlay',
  security,
  request: {
    params: z.object({ id: Id }),
    body: {
      required: true,
      content: json(z.object({ data: DataSchema.optional(), enabled: z.boolean().optional() })),
    },
  },
  responses: {
    200: { description: 'Updated', content: json(OverlaySchema) },
    ...problems(401, 403, 404, 422, 503),
  },
});

const deleteRouteDef = createRoute({
  method: 'delete',
  path: '/overlays/{id}',
  summary: 'Delete an Overlay',
  security,
  request: { params: z.object({ id: Id }) },
  responses: { 204: { description: 'Deleted' }, ...problems(401, 403, 404) },
});

interface OverlayRow {
  id: string;
  routeId: string;
  facetKey: string;
  data: unknown;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const toView = (row: OverlayRow): z.infer<typeof OverlaySchema> => ({
  id: row.id,
  routeId: row.routeId,
  facetKey: row.facetKey,
  data: row.data,
  enabled: row.enabled,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** The 422 for a document that is not valid for its Facet: one entry per problem, with its path. */
function checkDocument(
  registry: ApiServices['registry'],
  facetKey: string,
  data: unknown,
  field: string,
): void {
  const issues = registry.validateOverlay(facetKey, data);
  if (issues === undefined) {
    throw new ProblemError('validation_failed', {
      errors: [{ path: 'facetKey', message: 'unknown Facet' }],
    });
  }
  if (issues.length > 0) {
    throw new ProblemError('validation_failed', {
      errors: issues.map((issue) => ({
        path: issue.path === '' ? field : `${field}.${issue.path}`,
        message: issue.message,
      })),
    });
  }
}

export function createOverlays(deps: OverlayDeps) {
  const { privileged } = deps.db;
  const app = new OpenAPIHono<Env>({ defaultHook: deps.validationHook as never });

  return app
    .openapi(createRouteDef, async (c) => {
      requireCapability(c, 'manageRules');
      const body = c.req.valid('json');
      const registry = requireService(deps.services, 'registry');
      checkDocument(registry, body.facetKey, body.data, 'data');
      const route = await privileged.route.findUnique({
        where: { id: body.routeId },
        select: { id: true },
      });
      if (!route) {
        throw new ProblemError('validation_failed', {
          errors: [{ path: 'routeId', message: 'unknown Route' }],
        });
      }
      const by = c.get('principal').actor.id;
      const row = await privileged.$transaction(async (tx) => {
        const created = await tx.overlay.create({
          data: {
            routeId: body.routeId,
            facetKey: body.facetKey,
            data: body.data as never,
            enabled: body.enabled ?? true,
          },
        });
        await tx.auditEvent.create({
          data: {
            actorId: by,
            action: 'overlay.create',
            subjectType: 'overlay',
            subjectId: created.id,
            data: {
              routeId: created.routeId,
              facetKey: created.facetKey,
              enabled: created.enabled,
            },
          },
        });
        return created;
      });
      return c.json(toView(row), 201);
    })
    .openapi(patchRouteDef, async (c) => {
      requireCapability(c, 'manageRules');
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      if (body.data === undefined && body.enabled === undefined) {
        throw new ProblemError('validation_failed', {
          errors: [{ path: '', message: 'at least one of data or enabled is required' }],
        });
      }
      const registry = requireService(deps.services, 'registry');
      const before = await privileged.overlay.findUnique({ where: { id } });
      if (!before) throw new ProblemError('not_found');
      if (body.data !== undefined) checkDocument(registry, before.facetKey, body.data, 'data');
      const by = c.get('principal').actor.id;
      const row = await privileged.$transaction(async (tx) => {
        const updated = await tx.overlay.update({
          where: { id },
          data: {
            ...(body.data === undefined ? {} : { data: body.data as never }),
            ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
          },
        });
        await tx.auditEvent.create({
          data: {
            actorId: by,
            action: 'overlay.update',
            subjectType: 'overlay',
            subjectId: id,
            data: {
              facetKey: updated.facetKey,
              documentChanged: body.data !== undefined,
              ...(body.enabled === undefined
                ? {}
                : { enabled: { from: before.enabled, to: updated.enabled } }),
            },
          },
        });
        return updated;
      });
      return c.json(toView(row), 200);
    })
    .openapi(deleteRouteDef, async (c) => {
      requireCapability(c, 'manageRules');
      const { id } = c.req.valid('param');
      const by = c.get('principal').actor.id;
      await privileged.$transaction(async (tx) => {
        const before = await tx.overlay.findUnique({ where: { id } });
        if (!before) throw new ProblemError('not_found');
        await tx.overlay.delete({ where: { id } });
        await tx.auditEvent.create({
          data: {
            actorId: by,
            action: 'overlay.delete',
            subjectType: 'overlay',
            subjectId: id,
            data: { routeId: before.routeId, facetKey: before.facetKey },
          },
        });
      });
      return c.body(null, 204);
    });
}
