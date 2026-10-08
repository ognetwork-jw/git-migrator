import { AsyncLocalStorage } from 'node:async_hooks';
import type { Config } from '@git-migrator/config';
import type { Db } from '@git-migrator/db';
import type { Logger } from '@git-migrator/observability';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import type pg from 'pg';
import { linkTestActor, type ProvisionResult, provisionMappedActor } from './actors.ts';
import { betterAuthLogger } from './logger.ts';
import { methodHasMappings, type Role, resolveRole } from './roles.ts';
import { createAuthPool } from './storage.ts';
import { assertTestSignInAllowed } from './test-sign-in.ts';

/** The sign-in method name that role mappings use for Entra ID (`method: entra`, AUTH-010). */
export const ENTRA_METHOD = 'entra';
/** Better Auth's id for the Entra social provider. */
const ENTRA_PROVIDER_ID = 'microsoft';
const CREDENTIAL_PROVIDER_ID = 'credential';
export const AUTH_BASE_PATH = '/api/auth';
/** AUTH-004. */
export const SESSION_EXPIRES_IN_SECONDS = 8 * 60 * 60;
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60;
/** AUTH-002: the scopes requested from Entra. */
export const ENTRA_SCOPES = ['openid', 'profile', 'email'] as const;

/**
 * The error codes a failed sign-in redirects with (`<publicUrl>/auth/error?error=<code>`), and the
 * keys of `auth.error.*` in `apps/web/messages/en.json`.
 */
export const AUTH_ERROR_CODES = {
  /** AUTH-010: no role mapping matched, so an Entra app role assignment is required. */
  roleAssignmentRequired: 'role_assignment_required',
  /** AUTH-002: the account belongs to another tenant. */
  tenantNotAllowed: 'tenant_not_allowed',
  /** AUTH-005: the Actor is disabled. */
  actorDisabled: 'actor_disabled',
  /** AUTH-012: no Actor for a test sign-in user. */
  actorNotFound: 'actor_not_found',
  /** Any method other than Entra or test sign-in. */
  signInMethodNotAllowed: 'sign_in_method_not_allowed',
  /** An unexpected failure while completing the callback (never shown as a raw 500). */
  signInFailed: 'sign_in_failed',
} as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

export interface AuthSecrets {
  /** `BETTER_AUTH_SECRET`. */
  readonly authSecret: string;
  /** `ENTRA_CLIENT_ID`. */
  readonly entraClientId: string;
  /** `ENTRA_CLIENT_SECRET`. */
  readonly entraClientSecret: string;
}

export interface CreateAuthOptions {
  readonly config: Pick<Config, 'environment' | 'publicUrl' | 'auth'>;
  readonly secrets: AuthSecrets;
  /** Assembled by `buildConnectionString` (DATA-010). Better Auth gets its own pool (AUTH-001). */
  readonly connectionString: string;
  /** The privileged client used to provision Actors (AUTH-005). */
  readonly db: Db;
  /** The process environment, for the production guard (AUTH-012). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Reuse a pool instead of creating one. The caller then owns closing it. */
  readonly pool?: pg.Pool;
  /** Receives Better Auth's output (DEP-050). Defaults to the application logger. */
  readonly logger?: Logger;
}

/**
 * Seams that only `createAuthForTest` (`@git-migrator/auth/testing`) passes. `createAuth` never
 * accepts them, so production code cannot redirect sign-in or rewrite a decision.
 */
export interface AuthTestSeams {
  /** The Entra authority, pointed at the local stub. Production uses Better Auth's default. */
  readonly entraAuthority?: string;
  /** Rewrites the Entra decision before the session hook sees it. */
  readonly mutateEntraDecision?: (decision: EntraDecision) => EntraDecision;
}

/** Endpoints the app does not use. Disabled so they answer 404 (ADR-0170). */
export const DISABLED_PATHS = [
  // Provider tokens must never leave the server, and are not stored either.
  '/get-access-token',
  '/refresh-token',
  '/account-info',
  '/link-social',
  '/list-accounts',
  '/unlink-account',
  // Identity comes from the provider; Actors are edited through the API, not these.
  '/update-user',
  '/update-session',
  '/change-email',
  '/change-password',
  '/delete-user',
  '/delete-user/callback',
  '/set-password',
  // No self-service credentials or email flows.
  '/sign-up/email',
  '/request-password-reset',
  '/reset-password',
  '/verify-password',
  '/send-verification-email',
  '/verify-email',
  // Sessions are managed by sign-in, sign-out and Actor administration only.
  '/list-sessions',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
] as const;

/**
 * Disabled by a prefix check in `hooks.before`, because `disabledPaths` matches literal paths only
 * and these routes have a parameter (`/reset-password/:token`).
 */
export const DISABLED_PATH_PREFIXES = ['/reset-password/'] as const;

/**
 * The only body fields `/sign-in/social` accepts (ADR-0170). Anything else (`scopes`,
 * `additionalParams`, `idToken`, `loginHint`, `additionalData`, ...) is refused with 400, so a
 * client can neither widen what is requested from Entra nor store data without signing in.
 */
export const SOCIAL_SIGN_IN_FIELDS: ReadonlySet<string> = new Set([
  'provider',
  'callbackURL',
  'errorCallbackURL',
  'newUserCallbackURL',
]);

/** Requests to `/api/auth/*` with a larger body are refused with 413 before Better Auth reads them. */
export const MAX_AUTH_BODY_BYTES = 64 * 1024;

/** The request with its body read into memory, or `undefined` when the body is too large. */
async function withBoundedBody(request: Request): Promise<Request | undefined> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_AUTH_BODY_BYTES) return undefined;
  if (request.body === null) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_AUTH_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
  });
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Trimmed, lowercase tenant GUID; throws for a value that is not one (the `tid` claim is a GUID). */
export function normalizeTenantId(value: string): string {
  const tenant = value.trim().toLowerCase();
  if (tenant !== '' && !GUID.test(tenant)) {
    throw new Error('auth.entra.tenantId must be the tenant GUID (AUTH-002)');
  }
  return tenant;
}

export interface EntraDecision {
  /** The Entra object id the decision was made for (the account id of the sign-in). */
  readonly oid: string;
  readonly role: Role;
  readonly displayName: string;
  /** The real address from the claims, kept on the Actor only. */
  readonly email: string | null;
}

interface RequestState {
  /** Set by `validateUserInfo` once the claims passed, read when the session is created. */
  entra?: EntraDecision;
}

/** Carries the validated Entra decision from the profile gate to session creation, per request. */
const requestState = new AsyncLocalStorage<RequestState>();

const NO_TOKENS = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
} as const;

const SYNTHETIC_DOMAIN = '@entra.invalid';

/** The reserved `.invalid` TLD cannot collide with a real or seeded address. */
export function syntheticEmail(oid: string): string {
  return `${oid.trim().toLowerCase()}${SYNTHETIC_DOMAIN}`;
}

function deny(code: AuthErrorCode): never {
  throw new APIError('FORBIDDEN', { code, message: code });
}

function stringClaim(claims: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = claims[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export interface AuthService {
  /** The Better Auth instance (for `auth.api.*` in server code and tests). */
  readonly auth: ReturnType<typeof createAuthInstance>;
  /**
   * Serves `/api/auth/*` (AUTH-003). The Hono mount MUST call this and not `auth.handler`, because
   * it opens the per-request state that carries the validated role from the profile gate to the
   * session hook; without it an Entra sign-in is denied (fail closed).
   */
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Builds Better Auth for this deployment (AUTH-001 ... AUTH-005, AUTH-010, AUTH-011, AUTH-012).
 * Throws when test sign-in is enabled in production (AUTH-012).
 */
export function createAuth(options: CreateAuthOptions): AuthService {
  return createAuthWithSeams(options, {});
}

/** `createAuth` with test seams. Internal: reached only through `createAuthForTest`. */
export function createAuthWithSeams(options: CreateAuthOptions, seams: AuthTestSeams): AuthService {
  assertTestSignInAllowed(options.config, options.env);
  const ownsPool = options.pool === undefined;
  const pool = options.pool ?? createAuthPool(options.connectionString);
  const auth = createAuthInstance(options, seams, pool);
  return {
    auth,
    handle: async (incoming) => {
      const request = await withBoundedBody(incoming);
      if (request === undefined) return new Response(null, { status: 413 });
      const response = await requestState.run({}, () => auth.handler(request));
      if (response.status >= 500 && new URL(request.url).pathname.includes('/callback/')) {
        // A failure while finishing a sign-in ends on the error page, never on a raw 500.
        const target = new URL('/auth/error', options.config.publicUrl);
        target.searchParams.set('error', AUTH_ERROR_CODES.signInFailed);
        return Response.redirect(target.toString(), 302);
      }
      return response;
    },
    close: async () => {
      if (ownsPool) await pool.end();
    },
  };
}

function createAuthInstance(options: CreateAuthOptions, seams: AuthTestSeams, pool: pg.Pool) {
  const { config, secrets, db } = options;
  const tenantId = normalizeTenantId(config.auth.entra.tenantId);
  const mappings = config.auth.roleMappings;
  const testSignIn = config.auth.testSignIn.enabled;
  const errorURL = new URL('/auth/error', config.publicUrl).toString();
  const secure = config.publicUrl.startsWith('https://');

  const instance = betterAuth({
    appName: 'git-migrator',
    baseURL: config.publicUrl,
    basePath: AUTH_BASE_PATH,
    secret: secrets.authSecret,
    trustedOrigins: [new URL(config.publicUrl).origin],
    database: pool,
    onAPIError: { errorURL },
    logger: betterAuthLogger(options.logger),
    disabledPaths: [...DISABLED_PATHS, ...(testSignIn ? [] : ['/sign-in/email'])],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // `disabledPaths` matches literal paths only; this one has a parameter.
        if (DISABLED_PATH_PREFIXES.some((prefix) => ctx.path.startsWith(prefix))) {
          throw new APIError('NOT_FOUND');
        }
        if (ctx.path !== '/sign-in/social') return;
        const body: unknown = ctx.body;
        if (
          typeof body !== 'object' ||
          body === null ||
          Array.isArray(body) ||
          Object.keys(body).some((field) => !SOCIAL_SIGN_IN_FIELDS.has(field))
        ) {
          throw new APIError('BAD_REQUEST', {
            code: AUTH_ERROR_CODES.signInMethodNotAllowed,
            message: AUTH_ERROR_CODES.signInMethodNotAllowed,
          });
        }
      }),
      // The user's Better Auth email is a synthetic address (ADR-0171). The real one is the
      // Actor's, so the session response carries that instead.
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/get-session') return;
        const returned = ctx.context.returned as
          | { user?: { id?: string; email?: string }; session?: unknown }
          | null
          | undefined;
        const user = returned?.user;
        if (!user?.email?.endsWith(SYNTHETIC_DOMAIN) || typeof user.id !== 'string') return;
        const actor = await db.actor.findUnique({
          where: { authUserId: user.id },
          select: { email: true },
        });
        return ctx.json({ ...returned, user: { ...user, email: actor?.email ?? '' } });
      }),
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      // No cookie cache: sign-out and revocation must take effect server-side at once (AUTH-004).
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: secure,
      // Better Auth skips its origin and CSRF checks when NODE_ENV is "test" or TEST is set; they
      // are switched on explicitly so no environment variable can turn them off.
      disableOriginCheck: false,
      defaultCookieAttributes: { httpOnly: true, secure, sameSite: 'lax' },
    },
    account: {
      accountLinking: { enabled: false },
      // Tokens are not stored at all (the hooks below null them); this is the second layer.
      encryptOAuthTokens: true,
    },
    emailAndPassword: {
      enabled: testSignIn,
      // Test users exist only because the seed script created them (AUTH-012).
      disableSignUp: true,
      autoSignIn: false,
    },
    socialProviders: {
      [ENTRA_PROVIDER_ID]: {
        clientId: secrets.entraClientId,
        clientSecret: secrets.entraClientSecret,
        tenantId,
        ...(seams.entraAuthority === undefined ? {} : { authority: seams.entraAuthority }),
        scope: [...ENTRA_SCOPES],
        disableDefaultScope: true,
        // Redirect code flow only: an id token posted by a client is never accepted.
        disableIdTokenSignIn: true,
        // The profile photo needs Graph (User.Read), which the sign-in does not request.
        disableProfilePhoto: true,
        // Name and email follow the provider at every sign-in (AUTH-005).
        overrideUserInfoOnSignIn: true,
        // AUTH-011: the `roles` claim reaches `validateUserInfo` as `source.oauth.profile`.
        // The identity is the `oid`: `auth.user.email` holds a synthetic, oid-derived address, so
        // a reused or changed real address can never collide or link (ADR-0171).
        mapProfileToUser: (claims: Record<string, unknown>) => {
          const oid = stringClaim(claims, 'oid');
          return oid === undefined ? {} : { email: syntheticEmail(oid) };
        },
      },
    },
    user: {
      validateUserInfo: async ({ user, source }, ctx) => {
        if (source.method === 'email-password') {
          return testSignIn ? undefined : { error: AUTH_ERROR_CODES.signInMethodNotAllowed };
        }
        if (source.method !== 'oauth' || source.oauth?.providerId !== ENTRA_PROVIDER_ID) {
          return { error: AUTH_ERROR_CODES.signInMethodNotAllowed };
        }
        const claims = source.oauth.profile ?? {};
        // AUTH-002: with a tenant-specific authority the issuer check already binds the token to the
        // tenant on the id-token path; the authorization-code path decodes the token, so the
        // tenant is checked here as well.
        if (tenantId === '' || stringClaim(claims, 'tid')?.toLowerCase() !== tenantId) {
          return { error: AUTH_ERROR_CODES.tenantNotAllowed };
        }
        const role = resolveRole(mappings, ENTRA_METHOD, claims);
        if (role === undefined) {
          // AUTH-010: no match is a denial. A user who lost the assignment also loses sessions.
          if (source.action === 'sign-in' && typeof user.id === 'string') {
            await ctx.context.internalAdapter.deleteUserSessions(user.id);
          }
          return { error: AUTH_ERROR_CODES.roleAssignmentRequired };
        }
        const oid = stringClaim(claims, 'oid')?.toLowerCase();
        if (oid === undefined) return { error: AUTH_ERROR_CODES.signInFailed };
        const email = (stringClaim(claims, 'email') ?? stringClaim(claims, 'preferred_username'))
          ?.trim()
          .toLowerCase();
        const state = requestState.getStore();
        if (state) {
          const decision: EntraDecision = {
            oid,
            role,
            email: email ?? null,
            displayName: (user.name ?? '').trim() || stringClaim(claims, 'name') || email || oid,
          };
          state.entra = seams.mutateEntraDecision?.(decision) ?? decision;
        }
        return undefined;
      },
    },
    databaseHooks: {
      // OAuth tokens are never persisted (ADR-0170): no endpoint needs them.
      account: {
        create: { before: async () => ({ data: NO_TOKENS }) },
        update: { before: async () => ({ data: NO_TOKENS }) },
      },
      session: {
        create: {
          before: async (session) => {
            const context = await instance.$context;
            const userId = session.userId;
            const accounts = await context.internalAdapter.findAccounts(userId);
            const user = await context.internalAdapter.findUserById(userId);
            if (!user) deny(AUTH_ERROR_CODES.actorNotFound);

            let outcome: ProvisionResult | undefined;
            if (accounts.some((a) => a.providerId === ENTRA_PROVIDER_ID)) {
              if (!methodHasMappings(mappings, ENTRA_METHOD)) {
                deny(AUTH_ERROR_CODES.roleAssignmentRequired);
              }
              const decision = requestState.getStore()?.entra;
              if (!decision) deny(AUTH_ERROR_CODES.roleAssignmentRequired);
              // The decision must be for the identity this session is for.
              const entraAccount = accounts.find((a) => a.providerId === ENTRA_PROVIDER_ID);
              if (entraAccount?.accountId.toLowerCase() !== decision.oid) {
                deny(AUTH_ERROR_CODES.roleAssignmentRequired);
              }
              outcome = await provisionMappedActor(db, {
                authUserId: userId,
                displayName: decision.displayName,
                email: decision.email,
                role: decision.role,
              });
            } else if (
              testSignIn &&
              accounts.some((a) => a.providerId === CREDENTIAL_PROVIDER_ID)
            ) {
              outcome = await linkTestActor(db, { authUserId: userId, email: user.email });
            } else {
              deny(AUTH_ERROR_CODES.signInMethodNotAllowed);
            }
            if (!outcome) deny(AUTH_ERROR_CODES.actorNotFound);
            if (outcome.status === 'disabled') {
              // AUTH-005: a disabled Actor is rejected and its existing sessions are revoked.
              await context.internalAdapter.deleteUserSessions(userId);
              deny(AUTH_ERROR_CODES.actorDisabled);
            }
            return undefined;
          },
        },
      },
    },
  });
  return instance;
}
