import type { AuthService } from '@git-migrator/auth';
import { type DbHandle, schema } from '@git-migrator/db';
import type { Logger } from '@git-migrator/observability';
import { RPCApiHandler } from '@zenstackhq/server/api';
import { createHonoHandler } from '@zenstackhq/server/hono';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { EventHub } from './events.ts';
import { type Principal, resolvePrincipal } from './principal.ts';
import {
  PROBLEM_BASE,
  PROBLEM_CONTENT_TYPE,
  ProblemError,
  problemBody,
  problemCodeForStatus,
  problemResponse,
} from './problem.ts';
import { type ApiEnv, createV1 } from './v1.ts';

/** Largest request body `/api/model/*` and `/api/v1/*` read (the auth routes have their own cap). */
export const MAX_API_BODY_BYTES = 1024 * 1024;
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ApiDeps {
  readonly db: Pick<DbHandle, 'privileged' | 'forActor' | 'pool'>;
  /** Better Auth. The mount calls `auth.handle`, never `auth.auth.handler` (AUTH-003). */
  readonly auth: AuthService;
  /** `publicUrl` of the configuration. Session-cookie writes must come from this origin. */
  readonly publicUrl: string;
  readonly logger?: Logger;
  /**
   * Fan-out of domain events to SSE clients (JOB-060). The process owner creates it and closes it
   * on shutdown; the app never owns a listener connection.
   */
  readonly events: EventHub;
  /** Extra readiness check, run after `select 1` (for example "configuration loaded"). */
  readonly ready?: () => boolean | Promise<boolean>;
}

/** The only facts about an error that are logged: its class and a few short, non-free-text codes. */
export function safeErrorFields(error: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const short = (value: unknown, max: number): string | undefined =>
    (typeof value === 'string' || typeof value === 'number') && String(value).length <= max
      ? String(value).replace(/[^\w.:-]/g, '_')
      : undefined;
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth++) {
    const e = current as Record<string, unknown>;
    out.errorClass ??= short((current as object).constructor?.name, 64) ?? 'Error';
    const reason = short(e.reason, 40);
    const dbErrorCode = short(e.dbErrorCode ?? e.code, 16);
    const model = short(e.model, 64);
    if (reason) out.reason ??= reason;
    if (dbErrorCode) out.dbErrorCode ??= dbErrorCode;
    if (model) out.model ??= model;
    current = e.cause;
  }
  return out;
}

/** True for PostgreSQL serialization failures (40001) and deadlocks (40P01), on the error or its causes. */
export function isRetryableConflict(error: unknown): boolean {
  const codes = new Set(['40001', '40P01']);
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth++) {
    const e = current as Record<string, unknown>;
    if (codes.has(String(e.dbErrorCode)) || codes.has(String(e.code))) return true;
    current = e.cause;
  }
  return false;
}

export const API_TITLE = 'git-migrator API';

/**
 * The Hono app of API-001: `/api/auth/*`, `/api/model/*` (ZenStack RPC), `/api/v1/*` (custom
 * endpoints and the OpenAPI document) and the health endpoints. Every route outside `/api/auth/*`
 * and health resolves the request to an Actor first (AUTH-020) and answers 401 otherwise.
 */
export function createApiApp(deps: ApiDeps) {
  const app = new Hono<ApiEnv>();
  const publicOrigin = new URL(deps.publicUrl).origin;
  // The RPC handler gets no log sink: a function sink makes ZenStack build its debug messages
  // (the whole request, serialized) for every call. Failed database calls are reported by the
  // facade through `createDb({ onError })` instead, reduced to safe fields (`safeErrorFields`).
  const rpc = new RPCApiHandler({ schema });
  // Wraps the RPC handler: an operation the facade does not expose is a 404 (not a 500 that echoes
  // "is not a function"), also inside `$transaction/sequential`, and no 5xx body carries an
  // internal message.
  const guardedRpc = {
    schema,
    get log() {
      return rpc.log;
    },
    handleRequest: async (request: Parameters<typeof rpc.handleRequest>[0]) => {
      const [model, operation] = request.path.split('/').filter(Boolean);
      const client = request.client as unknown as Record<
        string,
        Record<string, unknown> | undefined
      >;
      const exposed = (m: unknown, op: unknown): boolean | undefined => {
        if (typeof m !== 'string') return undefined;
        const key = Object.keys(client).find((k) => k.toLowerCase() === m.toLowerCase());
        if (key === undefined) return undefined;
        return typeof op === 'string' && typeof client[key]?.[op] === 'function';
      };
      if (model && !model.startsWith('$') && exposed(model, operation) === false) {
        return { status: 404, body: problemBody('not_found') };
      }
      if (model === '$transaction' && Array.isArray(request.requestBody)) {
        for (const item of request.requestBody as Array<{ model?: unknown; op?: unknown }>) {
          if (typeof item === 'object' && item !== null && exposed(item.model, item.op) === false) {
            return { status: 404, body: problemBody('not_found') };
          }
        }
      }
      const response = await rpc.handleRequest(request);
      if (response.status >= 500) {
        const error = (response.body as { error?: unknown } | undefined)?.error;
        deps.logger?.error(
          { status: response.status, ...safeErrorFields(error) },
          'RPC request failed',
        );
        return { status: 500, body: problemBody('internal_error') };
      }
      return response;
    },
  };

  app.get('/api/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/api/readyz', async (c) => {
    try {
      await deps.db.pool.query('select 1');
      if (deps.ready && !(await deps.ready())) return problemResponse('not_ready');
    } catch {
      return problemResponse('not_ready');
    }
    return c.json({ status: 'ready' });
  });

  // AuthService.handle, not auth.handler: it opens the per-request state that carries the Entra
  // decision to the session hook (T-020). Authorization headers are not read here (AUTH-040).
  app.all('/api/auth/*', (c) => deps.auth.handle(c.req.raw));

  const authenticate = async (c: Context<ApiEnv>, next: () => Promise<void>) => {
    const principal = await resolvePrincipal(
      { auth: deps.auth, privileged: deps.db.privileged },
      c.req.raw.headers,
    );
    if (!principal) {
      return problemResponse('unauthenticated', {
        headers: { 'www-authenticate': 'Bearer realm="git-migrator"' },
      });
    }
    // Cookies are sent by browsers on cross-site requests; an API key never is. SameSite=Lax
    // already stops cross-site POSTs, and this closes the same-site gap (AUTH-004).
    if (
      principal.via === 'session' &&
      !SAFE_METHODS.has(c.req.method) &&
      c.req.header('origin') !== publicOrigin
    ) {
      return problemResponse('origin_not_allowed');
    }
    c.set('principal', principal);
    await next();
    return undefined;
  };
  const limit = bodyLimit({
    maxSize: MAX_API_BODY_BYTES,
    onError: () => problemResponse('payload_too_large'),
  });

  // Every error under /api/v1 is problem+json, whoever produced it (API-011): a safety net for
  // responses that did not come from a handler (the JSON validator's 400, content-type 415, ...).
  app.use('/api/v1/*', async (c, next) => {
    await next();
    const type = c.res.headers.get('content-type') ?? '';
    if (c.res.status >= 400 && !type.includes(PROBLEM_CONTENT_TYPE)) {
      c.res = problemResponse(problemCodeForStatus(c.res.status));
    }
  });
  app.use('/api/model/*', authenticate as never, limit);
  app.use('/api/v1/*', authenticate as never, limit);

  const rpcHandler = createHonoHandler({
    apiHandler: guardedRpc as never,
    // The policy-enforcing allow-list facade bound to the Actor (AUTH-021, ADR-0122).
    getClient: (c) => deps.db.forActor((c.get('principal' as never) as Principal).actor) as never,
  });
  app.all('/api/model/*', async (c, next) => {
    const response = (await rpcHandler(c, next)) as Response;
    // createHonoHandler sends JSON; the problems this mount makes itself keep their media type.
    if (response.status !== 404 && response.status !== 500) return response;
    const text = await response.clone().text();
    try {
      const body = JSON.parse(text) as { type?: unknown };
      if (typeof body.type === 'string' && body.type.startsWith(PROBLEM_BASE)) {
        return new Response(text, {
          status: response.status,
          headers: { 'content-type': PROBLEM_CONTENT_TYPE },
        });
      }
    } catch {
      // Not JSON: leave it as it is.
    }
    return response;
  });

  const v1 = createV1({ db: deps.db, auth: deps.auth, events: deps.events });
  v1.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: { title: API_TITLE, version: '1.0.0' },
    servers: [{ url: '/api/v1' }],
  });
  v1.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'A service Actor API key: `Authorization: Bearer gm_...` (AUTH-040).',
  });
  v1.openAPIRegistry.registerComponent('securitySchemes', 'sessionCookie', {
    type: 'apiKey',
    in: 'cookie',
    name: 'better-auth.session_token',
  });
  const routes = app.route('/api/v1', v1);

  app.notFound(() => problemResponse('not_found'));
  app.onError((error) => {
    if (error instanceof ProblemError) return error.getResponse();
    // Any other HTTPException (malformed JSON, body too large, ...) becomes a problem by status.
    if (error instanceof HTTPException) {
      return problemResponse(problemCodeForStatus(error.status));
    }
    // A serialization failure or deadlock that reaches here is a conflict the caller can retry.
    if (isRetryableConflict(error)) return problemResponse('conflict');
    // Safe fields only: the message may carry request data.
    deps.logger?.error(safeErrorFields(error), 'unhandled error in the API');
    return problemResponse('internal_error');
  });

  return routes;
}

export type AppType = ReturnType<typeof createApiApp>;
