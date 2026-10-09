import {
  ApiKeyError,
  type AuthService,
  type Capability,
  can,
  issueApiKey,
  revokeApiKey,
} from '@git-migrator/auth';
import type { Actor, DbHandle } from '@git-migrator/db';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { createBatch1 } from './batch1.ts';
import type { EventHub } from './events.ts';
import { eventsHandler, eventsRoute } from './events-route.ts';
import type { Principal } from './principal.ts';
import { ProblemError, ProblemSchema } from './problem.ts';
import type { ApiServices } from './services.ts';

export interface ApiEnv {
  Variables: { principal: Principal };
}

export interface V1Deps {
  readonly db: Pick<DbHandle, 'privileged'>;
  readonly auth: AuthService;
  /** Fan-out for `GET /events` (JOB-060). */
  readonly events: EventHub;
  /** Job producer, quota and registry for the batch 1 endpoints (ADR-0330). */
  readonly services?: Partial<ApiServices>;
  /** Told about a queue or database fault before it becomes a 503. */
  readonly onFault?: (error: unknown) => void;
}

/** `pg_advisory_xact_lock` key that serializes Actor changes (any fixed bigint not used elsewhere). */
export const ADMIN_CHANGE_LOCK_KEY = 7_021_001;

const ROLES = ['viewer', 'operator', 'admin'] as const;
const RoleSchema = z.enum(ROLES);

const ActorSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['human', 'service']),
    displayName: z.string(),
    email: z.string().nullable(),
    role: RoleSchema,
    disabled: z.boolean(),
  })
  .openapi('Actor');

const toActor = (actor: Actor): z.infer<typeof ActorSchema> => ({
  id: actor.id,
  kind: actor.kind,
  displayName: actor.displayName,
  email: actor.email,
  role: actor.role,
  disabled: actor.disabled,
});

const IssuedKeySchema = z
  .object({
    id: z.string(),
    actorId: z.string(),
    name: z.string(),
    prefix: z.string(),
    expiresAt: z.string().nullable(),
    key: z.string().openapi({ description: 'The full key. Shown exactly once.' }),
  })
  .openapi('IssuedApiKey');

const problemContent = { 'application/problem+json': { schema: ProblemSchema } };
const problems = (...codes: (401 | 403 | 404 | 409 | 422)[]) =>
  Object.fromEntries(
    codes.map((status) => [status, { description: 'Problem', content: problemContent }]),
  );
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { sessionCookie: [] }];
const IdParam = z.object({ id: z.string().min(1).max(64) });

/** Throws a 403 problem unless the Principal holds `capability` (AUTH-021). */
function requireCapability(c: Context<ApiEnv>, capability: Capability): void {
  if (!can(c.get('principal').actor, capability)) {
    throw new ProblemError('forbidden', { detail: `requires the ${capability} capability` });
  }
}

const meRoute = createRoute({
  method: 'get',
  path: '/me',
  summary: 'The calling Actor',
  security,
  responses: { 200: { description: 'The Actor', content: json(ActorSchema) }, ...problems(401) },
});

const createActorRoute = createRoute({
  method: 'post',
  path: '/actors',
  summary: 'Create a service Actor',
  security,
  request: {
    body: {
      required: true,
      content: json(z.object({ displayName: z.string().trim().min(1).max(200), role: RoleSchema })),
    },
  },
  responses: {
    201: { description: 'Created', content: json(ActorSchema) },
    ...problems(401, 403, 422),
  },
});

const patchActorRoute = createRoute({
  method: 'patch',
  path: '/actors/{id}',
  summary: 'Disable or enable an Actor, or change a service Actor role',
  security,
  request: {
    params: IdParam,
    body: {
      required: true,
      content: json(
        z
          .object({ disabled: z.boolean().optional(), role: RoleSchema.optional() })
          .refine((b) => b.disabled !== undefined || b.role !== undefined, {
            message: 'at least one of disabled or role is required',
          }),
      ),
    },
  },
  responses: {
    200: { description: 'Updated', content: json(ActorSchema) },
    ...problems(401, 403, 404, 409, 422),
  },
});

const issueKeyRoute = createRoute({
  method: 'post',
  path: '/actors/{id}/api-keys',
  summary: 'Issue an API key for a service Actor',
  security,
  request: {
    params: IdParam,
    body: {
      required: true,
      content: json(
        z.object({
          name: z.string().trim().min(1).max(200),
          expiresAt: z.iso
            .datetime({ offset: true })
            .refine((value) => new Date(value).getTime() > Date.now(), {
              message: 'must be in the future',
            })
            .optional(),
        }),
      ),
    },
  },
  responses: {
    201: { description: 'The key, shown once', content: json(IssuedKeySchema) },
    ...problems(401, 403, 404, 409, 422),
  },
});

const revokeKeyRoute = createRoute({
  method: 'delete',
  path: '/api-keys/{id}',
  summary: 'Revoke an API key',
  security,
  request: { params: IdParam },
  responses: { 204: { description: 'Revoked' }, ...problems(401, 403, 404) },
});

/** Validation failures answer with problem+json (API-011). */
export const validationHook = (
  result: { success: boolean; error?: z.ZodError },
  _c: Context,
): Response | undefined => {
  if (result.success || !result.error) return undefined;
  throw new ProblemError('validation_failed', {
    errors: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  });
};

/** The `/api/v1` custom endpoints of this task: identity and Actor administration (API-020). */
export function createV1(deps: V1Deps) {
  const { privileged } = deps.db;
  const v1 = new OpenAPIHono<ApiEnv>({ defaultHook: validationHook as never });
  // Registered apart from the chain below: a stream is not a typed JSON endpoint, and the typed
  // client (`hc<AppType>`) has no use for it (browsers use EventSource).
  v1.openAPIRegistry.registerPath(eventsRoute);
  v1.get('/events', eventsHandler(deps.events));

  return v1
    .openapi(meRoute, (c) => c.json(toActor(c.get('principal').actor), 200))
    .openapi(createActorRoute, async (c) => {
      requireCapability(c, 'manageActors');
      const body = c.req.valid('json');
      const by = c.get('principal').actor;
      const actor = await privileged.$transaction(async (tx) => {
        const created = await tx.actor.create({
          data: { kind: 'service', displayName: body.displayName, role: body.role },
        });
        await tx.auditEvent.create({
          data: {
            actorId: by.id,
            action: 'actor.create',
            subjectType: 'actor',
            subjectId: created.id,
            data: { kind: 'service', role: body.role },
          },
        });
        return created;
      });
      return c.json(toActor(actor), 201);
    })
    .openapi(patchActorRoute, async (c) => {
      requireCapability(c, 'manageActors');
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const by = c.get('principal').actor;
      const data = {
        ...(body.disabled === undefined ? {} : { disabled: body.disabled }),
        ...(body.role === undefined ? {} : { role: body.role }),
      };
      // READ COMMITTED with a transaction-scoped advisory lock taken first: admin-affecting changes
      // run one at a time, and each sees the committed result of the one before (ADR-0202). A
      // SERIALIZABLE transaction gave false conflicts (a 500) between unrelated demotions.
      const { target, updated } = await privileged.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_CHANGE_LOCK_KEY}::bigint)`;
        const before = await tx.actor.findUnique({ where: { id } });
        if (!before) throw new ProblemError('not_found');
        if (body.role !== undefined && before.kind !== 'service') {
          throw new ProblemError('conflict', {
            detail: 'the role of a human Actor comes from the sign-in method',
          });
        }
        if (body.disabled === true && before.id === by.id) {
          throw new ProblemError('conflict', { detail: 'an admin cannot disable themselves' });
        }
        const wasAdmin = before.role === 'admin' && !before.disabled;
        const stillAdmin =
          (body.role ?? before.role) === 'admin' && !(body.disabled ?? before.disabled);
        if (wasAdmin && !stillAdmin) {
          const others = await tx.actor.count({
            where: { role: 'admin', disabled: false, id: { not: id } },
          });
          if (others === 0) {
            throw new ProblemError('last_admin', {
              detail: 'at least one enabled administrator must remain',
            });
          }
        }
        const row = await tx.actor.update({ where: { id }, data });
        await tx.auditEvent.create({
          data: {
            actorId: by.id,
            action: 'actor.update',
            subjectType: 'actor',
            subjectId: id,
            data: {
              ...(body.disabled === undefined
                ? {}
                : { disabled: { from: before.disabled, to: row.disabled } }),
              ...(body.role === undefined ? {} : { role: { from: before.role, to: row.role } }),
            },
          },
        });
        return { target: before, updated: row };
      });
      // Streams (JOB-060) end at once on this process; on others within their lifetime.
      if (body.disabled === true) deps.events.closeOwner(id);
      if (body.disabled === true && target.authUserId) {
        // AUTH-005: a disabled Actor's sessions are revoked. The Actor check on every request
        // already rejects them; this removes the rows.
        const context = await deps.auth.auth.$context;
        await context.internalAdapter.deleteUserSessions(target.authUserId);
      }
      return c.json(toActor(updated), 200);
    })
    .openapi(issueKeyRoute, async (c) => {
      requireCapability(c, 'manageActors');
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      try {
        const issued = await issueApiKey(privileged, {
          actorId: id,
          name: body.name,
          expiresAt: body.expiresAt === undefined ? undefined : new Date(body.expiresAt),
          issuedBy: c.get('principal').actor.id,
        });
        return c.json(
          { ...issued, expiresAt: issued.expiresAt ? issued.expiresAt.toISOString() : null },
          201,
        );
      } catch (error) {
        if (error instanceof ApiKeyError) {
          throw error.code === 'actor_not_found'
            ? new ProblemError('not_found')
            : new ProblemError('conflict', { detail: error.message });
        }
        throw error;
      }
    })
    .openapi(revokeKeyRoute, async (c) => {
      requireCapability(c, 'manageActors');
      const { id } = c.req.valid('param');
      const key = await privileged.apiKey.findUnique({ where: { id }, select: { actorId: true } });
      try {
        await revokeApiKey(privileged, id, c.get('principal').actor.id);
      } catch (error) {
        if (error instanceof ApiKeyError) throw new ProblemError('not_found');
        throw error;
      }
      // The Actor's open event streams may belong to the revoked key: end them, clients reconnect.
      if (key) deps.events.closeOwner(key.actorId);
      return c.body(null, 204);
    })
    .route(
      '/',
      createBatch1({
        db: deps.db,
        services: deps.services ?? {},
        ...(deps.onFault ? { onFault: deps.onFault } : {}),
        validationHook,
      }),
    );
}
