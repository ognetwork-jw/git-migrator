/**
 * The invitation batch endpoints (AUTH-060, API-020, ADR-0370). Reads need `read`; every command
 * needs `manageInvitations` (operator). The provider work (seat preview, sending, revoking) is a
 * job step; these handlers only decide and enqueue.
 */
import { type Capability, can } from '@git-migrator/auth';
import type { Db } from '@git-migrator/db';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Principal } from '../principal.ts';
import { ProblemError, ProblemSchema } from '../problem.ts';
import type { ApiServices } from '../services.ts';
import {
  approveBatch,
  asConflict,
  auditRevoke,
  checkRevocable,
  createBatch,
  deselectItem,
  getBatch,
  getBatchSummary,
  listBatches,
  listCandidates,
  MAX_REASON,
  resolveItem,
  selectItem,
} from './service.ts';

interface Env {
  Variables: { principal: Principal };
}

export interface InvitationsDeps {
  readonly db: { readonly privileged: Db };
  readonly services: Partial<ApiServices>;
  /** Told about a queue fault before it is dropped or becomes a 503 (log safe fields only). */
  readonly onFault?: (error: unknown) => void;
  readonly validationHook: (result: { success: boolean; error?: z.ZodError }, c: Context) => void;
}

const problemContent = { 'application/problem+json': { schema: ProblemSchema } };
const problems = (...codes: (401 | 403 | 404 | 409 | 422 | 503)[]) =>
  Object.fromEntries(
    codes.map((status) => [status, { description: 'Problem', content: problemContent }]),
  );
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { sessionCookie: [] }];
const Id = z.string().min(1).max(64);
const IdParam = z.object({ id: Id });

function requireCapability(c: Context<Env>, capability: Capability): void {
  if (!can(c.get('principal').actor, capability)) {
    throw new ProblemError('forbidden', { detail: `requires the ${capability} capability` });
  }
}

const BATCH_STATUS = ['draft', 'approved', 'sending', 'sent', 'partial'] as const;
const ITEM_STATUS = [
  'selected',
  'deselected',
  'sent',
  'accepted',
  'failed',
  'expired',
  'unknown',
] as const;

const IdentityRefSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  login: z.string().nullable(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
});

const BatchSchema = z
  .object({
    id: z.string(),
    routeId: z.string(),
    status: z.enum(BATCH_STATUS),
    createdAt: z.string(),
    createdBy: z.string(),
    approvedBy: z.string().nullable(),
    approvedAt: z.string().nullable(),
    nextAttemptAt: z.string().nullable(),
    selectionToken: z.string(),
    seatPreview: z.object({
      toInvite: z.number().int(),
      seatsTotal: z.number().int().nullable(),
      seatsFilled: z.number().int().nullable(),
      projectedFilled: z.number().int().nullable(),
    }),
    counts: z.object(Object.fromEntries(ITEM_STATUS.map((s) => [s, z.number().int()])) as never),
  })
  .openapi('InvitationBatch');

const ItemSchema = z
  .object({
    id: z.string(),
    status: z.enum(ITEM_STATUS),
    email: z.string(),
    teamSlugs: z.array(z.string()),
    source: IdentityRefSchema,
    error: z.string().nullable(),
    deselectReason: z.string().nullable(),
    sentAt: z.string().nullable(),
    providerIdKnown: z.boolean(),
    mappingId: z.string().nullable(),
    suggestions: z.array(IdentityRefSchema),
  })
  .openapi('InvitationItem');

const CandidateSchema = z
  .object({ identity: IdentityRefSchema, teamSlugs: z.array(z.string()) })
  .openapi('InvitationCandidate');

const candidatesRoute = createRoute({
  method: 'get',
  path: '/routes/{id}/invitation-candidates',
  summary: 'Source Identities that can be invited (known e-mail, no decision, in no open batch)',
  security,
  request: {
    params: IdParam,
    query: z.object({
      q: z.string().max(200).optional(),
      cursor: z.string().min(1).max(512).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  },
  responses: {
    200: {
      description: 'A page',
      content: json(
        z.object({ items: z.array(CandidateSchema), nextCursor: z.string().nullable() }),
      ),
    },
    ...problems(401, 403, 404),
  },
});

const createBatchRoute = createRoute({
  method: 'post',
  path: '/routes/{id}/invitation-batches',
  summary: 'Create a draft Invitation Batch from candidates (all, or the ones named)',
  security,
  request: {
    params: IdParam,
    body: {
      required: true,
      content: json(
        z.object({
          identityIds: z.array(Id).max(5000).optional(),
          all: z.boolean().optional(),
        }),
      ),
    },
  },
  responses: {
    201: { description: 'The draft', content: json(BatchSchema) },
    ...problems(401, 403, 404, 409, 422, 503),
  },
});

const listBatchesRoute = createRoute({
  method: 'get',
  path: '/invitation-batches',
  summary: 'Invitation Batches, newest first',
  security,
  request: {
    query: z.object({
      routeId: Id.optional(),
      status: z.enum(BATCH_STATUS).optional(),
      cursor: z.string().min(1).max(512).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  },
  responses: {
    200: {
      description: 'A page',
      content: json(z.object({ items: z.array(BatchSchema), nextCursor: z.string().nullable() })),
    },
    ...problems(401, 403),
  },
});

const getBatchRoute = createRoute({
  method: 'get',
  path: '/invitation-batches/{id}',
  summary: 'An Invitation Batch with a page of its entries',
  security,
  request: {
    params: IdParam,
    query: z.object({
      status: z.enum(ITEM_STATUS).optional(),
      cursor: z.string().min(1).max(512).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
  },
  responses: {
    200: {
      description: 'The batch',
      content: json(
        z.object({
          batch: BatchSchema,
          items: z.array(ItemSchema),
          nextCursor: z.string().nullable(),
        }),
      ),
    },
    ...problems(401, 403, 404),
  },
});

const itemRoute = createRoute({
  method: 'post',
  path: '/invitation-batches/{id}/items/{itemId}/{action}',
  summary: 'Select, deselect (with a reason) or revoke one entry',
  security,
  request: {
    params: z.object({
      id: Id,
      itemId: Id,
      action: z.enum(['select', 'deselect', 'revoke', 'resolve']),
    }),
    body: {
      required: false,
      content: json(
        z.object({
          reason: z
            .string()
            .max(MAX_REASON * 2)
            .optional(),
          outcome: z.enum(['invited', 'not_invited']).optional(),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: 'The entry after the change',
      content: json(z.object({ status: z.enum(ITEM_STATUS) })),
    },
    202: {
      description: 'Revoking is queued',
      content: json(z.object({ queued: z.literal(true) })),
    },
    ...problems(401, 403, 404, 409, 422, 503),
  },
});

const approveRoute = createRoute({
  method: 'post',
  path: '/invitation-batches/{id}/approve',
  summary: 'Approve a draft batch and enqueue the sending (AUTH-060 step 4)',
  security,
  request: {
    params: IdParam,
    body: {
      required: true,
      content: json(
        z.object({
          expectedCount: z.number().int().min(0).max(5000).optional(),
          expectedToken: z.string().min(1).max(64),
        }),
      ),
    },
  },
  responses: {
    202: {
      description: 'Approved; sending is queued',
      content: json(
        z.object({ approved: z.number().int(), dropped: z.number().int(), batch: BatchSchema }),
      ),
    },
    ...problems(401, 403, 404, 409, 422),
  },
});

export function createInvitations(deps: InvitationsDeps) {
  const { privileged } = deps.db;
  const app = new OpenAPIHono<Env>({ defaultHook: deps.validationHook as never });

  /** Queue a step; a queue fault is reported, never lost silently (the inventory resumes sends). */
  const enqueue = async (step: Parameters<ApiServices['jobs']['enqueueInvitationStep']>[0]) => {
    const jobs = deps.services.jobs;
    if (!jobs) return false;
    try {
      await jobs.enqueueInvitationStep(step);
      return true;
    } catch (error) {
      deps.onFault?.(error);
      return false;
    }
  };

  return app
    .openapi(candidatesRoute, async (c) => {
      requireCapability(c, 'read');
      const { id } = c.req.valid('param');
      const query = c.req.valid('query');
      const { rows, hasMore } = await listCandidates(privileged, id, {
        ...(query.q ? { query: query.q } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        limit: query.limit,
      });
      const last = rows[rows.length - 1];
      return c.json({ items: rows, nextCursor: hasMore && last ? last.identity.id : null }, 200);
    })
    .openapi(createBatchRoute, async (c) => {
      requireCapability(c, 'manageInvitations');
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const batch = await asConflict(() =>
        createBatch(deps.db, id, body, { actorId: c.get('principal').actor.id }),
      );
      // The seats are read by the worker (the web process has no provider access).
      await enqueue({ step: 'seats', batchId: batch.id });
      return c.json(batch, 201);
    })
    .openapi(listBatchesRoute, async (c) => {
      requireCapability(c, 'read');
      const query = c.req.valid('query');
      const { rows, hasMore } = await listBatches(privileged, {
        ...(query.routeId ? { routeId: query.routeId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        limit: query.limit,
      });
      const last = rows[rows.length - 1];
      return c.json({ items: rows, nextCursor: hasMore && last ? last.id : null }, 200);
    })
    .openapi(getBatchRoute, async (c) => {
      requireCapability(c, 'read');
      const { id } = c.req.valid('param');
      const query = c.req.valid('query');
      const { batch, items, hasMore } = await getBatch(privileged, id, {
        ...(query.status ? { status: query.status } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        limit: query.limit,
      });
      const last = items[items.length - 1];
      return c.json({ batch, items, nextCursor: hasMore && last ? last.id : null }, 200);
    })
    .openapi(itemRoute, async (c) => {
      requireCapability(c, 'manageInvitations');
      const { id, itemId, action } = c.req.valid('param');
      const body = c.req.valid('json') ?? {};
      const by = { actorId: c.get('principal').actor.id };
      if (action === 'revoke') {
        await checkRevocable(deps.db, id, itemId);
        if (!(await enqueue({ step: 'revoke', batchId: id, invitationId: itemId }))) {
          throw new ProblemError('not_ready', { detail: 'the job queue is unavailable' });
        }
        await auditRevoke(deps.db, id, itemId, by);
        return c.json({ queued: true as const }, 202);
      }
      if (action === 'resolve') {
        if (body.outcome === undefined) {
          throw new ProblemError('validation_failed', {
            errors: [{ path: 'outcome', message: 'invited or not_invited is required' }],
          });
        }
        const outcome = body.outcome;
        return c.json({ status: await resolveItem(deps.db, id, itemId, outcome, by) }, 200);
      }
      const status =
        action === 'select'
          ? await asConflict(() => selectItem(deps.db, id, itemId, by))
          : await deselectItem(deps.db, id, itemId, body.reason ?? '', by);
      return c.json({ status }, 200);
    })
    .openapi(approveRoute, async (c) => {
      requireCapability(c, 'manageInvitations');
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const result = await asConflict(() =>
        approveBatch(deps.db, id, body, { actorId: c.get('principal').actor.id }),
      );
      // The approval stands even if the queue is down: the next inventory pass schedules the
      // send step of every approved batch again.
      await enqueue({ step: 'send', batchId: id });
      return c.json({ ...result, batch: await getBatchSummary(privileged, id) }, 202);
    });
}
