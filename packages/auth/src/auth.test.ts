import { type Config, resolveConfig } from '@git-migrator/config';
import { TEST_ACTORS } from '@git-migrator/db';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { createLogger } from '@git-migrator/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTH_BASE_PATH,
  AUTH_ERROR_CODES,
  type AuthService,
  type CreateAuthOptions,
  createAuth,
  DISABLED_PATH_PREFIXES,
  DISABLED_PATHS,
  MAX_AUTH_BODY_BYTES,
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  syntheticEmail,
} from './auth.ts';
import { migrateAuthSchema } from './storage.ts';
import { createCredentialUser, seedTestSignInUsers } from './test-sign-in.ts';
import {
  CookieJar,
  createAuthForTest,
  type EntraStub,
  signInWithEntra,
  startEntraStub,
} from './testing/index.ts';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT_ID = 'client-id-fake';
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'fake-test-password';
const SECRETS = {
  authSecret: 'fake-better-auth-secret-0000000000000000',
  entraClientId: CLIENT_ID,
  entraClientSecret: 'fake-client-secret',
};

const configYaml = (testSignIn: boolean, publicUrl = ORIGIN): string => `
environment: test
publicUrl: ${publicUrl}
auth:
  entra: { tenantId: "${TENANT}" }
  testSignIn: { enabled: ${testSignIn} }
  roleMappings:
    - { method: entra, claim: roles, value: "GitMigrator.Admin", role: admin }
    - { method: entra, claim: roles, value: "GitMigrator.Operator", role: operator }
    - { method: entra, claim: roles, value: "GitMigrator.Viewer", role: viewer }
`;

let t: TestDatabase;
let stub: EntraStub;
let entra: AuthService;
let testSignIn: AuthService;
let config: Config;
let testConfig: Config;
let counter = 0;

/** A fresh Entra identity: its own `oid` and email, so tests never share users. */
const identity = (roles: string[], extra: Record<string, unknown> = {}) => {
  counter++;
  return {
    oid: `00000000-0000-0000-0000-${String(counter).padStart(12, '0')}`,
    email: `user${counter}@example.test`,
    preferred_username: `user${counter}@example.test`,
    name: `User ${counter}`,
    roles,
    ...extra,
  };
};

const authEmail = (who: { oid: string }): string => syntheticEmail(who.oid);

const count = async (sql: string, values: unknown[] = []): Promise<number> =>
  Number((await t.db.pool.query<{ n: string }>(sql, values)).rows[0]?.n);

const actorByEmail = (email: string) => t.db.privileged.actor.findFirst({ where: { email } });

beforeAll(async () => {
  t = await createTestDatabase('gm_t020_');
  await migrateAuthSchema(t.connectionString);
  stub = await startEntraStub({ tenantId: TENANT, clientId: CLIENT_ID });
  config = resolveConfig({ text: configYaml(false), env: {} });
  testConfig = resolveConfig({ text: configYaml(true), env: {} });
  const base = {
    secrets: SECRETS,
    connectionString: t.connectionString,
    db: t.db.privileged,
    env: { GM_ENVIRONMENT: 'test' },
  };
  const seams = { entraAuthority: stub.authority };
  entra = createAuthForTest({ ...base, config }, seams);
  testSignIn = createAuthForTest({ ...base, config: testConfig }, seams);
}, 120_000);

afterAll(async () => {
  await entra?.close();
  await testSignIn?.close();
  await stub?.close();
  await t?.drop();
});

describe('storage (AUTH-001, DATA-030 step 3)', () => {
  it('[AUTH-001] the Better Auth tables live in schema auth and nothing leaks into app or public', async () => {
    const tables = await t.db.pool.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name FROM information_schema.tables
       WHERE table_name IN ('user', 'session', 'account', 'verification')`,
    );
    expect(tables.rows.map((r) => `${r.table_schema}.${r.table_name}`).sort()).toEqual([
      'auth.account',
      'auth.session',
      'auth.user',
      'auth.verification',
    ]);
  });

  it('[AUTH-001] runs Better Auth through its own pool whose search_path is auth', async () => {
    const result = await entra.auth.$context.then((c) => c.adapter.findMany({ model: 'user' }));
    expect(Array.isArray(result)).toBe(true);
    const pool = (await import('./storage.ts')).createAuthPool(t.connectionString, 1);
    try {
      const shown = await pool.query('SHOW search_path');
      expect(shown.rows[0]?.search_path).toBe('auth');
    } finally {
      await pool.end();
    }
  });

  it('[DATA-030] the Better Auth migration is idempotent', async () => {
    expect(await migrateAuthSchema(t.connectionString)).toEqual([]);
  });

  it('[DATA-030] a fresh database gets the four tables created by the migration', async () => {
    const fresh = await createTestDatabase('gm_t020m_');
    try {
      const created = await migrateAuthSchema(fresh.connectionString);
      expect([...created].sort()).toEqual(['account', 'session', 'user', 'verification']);
      expect(
        Number(
          (
            await fresh.db.pool.query<{ n: string }>(
              `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'auth'`,
            )
          ).rows[0]?.n,
        ),
      ).toBe(4);
    } finally {
      await fresh.drop();
    }
  }, 60_000);
});

describe('Entra ID sign-in (AUTH-002, AUTH-003, AUTH-004)', () => {
  it('[AUTH-002] sends the user to the configured tenant with the scopes openid profile email', async () => {
    const response = await entra.handle(
      new Request(`${ORIGIN}${AUTH_BASE_PATH}/sign-in/social`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ provider: 'microsoft', callbackURL: '/' }),
      }),
    );
    const { url } = (await response.json()) as { url: string };
    const parsed = new URL(url);
    expect(parsed.origin).toBe(stub.authority);
    expect(parsed.pathname).toBe(`/${TENANT}/oauth2/v2.0/authorize`);
    expect(parsed.searchParams.get('scope')).toBe('openid profile email');
    expect(parsed.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('[AUTH-002] rejects an account from another tenant and creates nothing', async () => {
    const who = identity(['GitMigrator.Admin'], { tid: 'some-other-tenant' });
    const before = await count('SELECT count(*) AS n FROM auth.user');
    const result = await signInWithEntra(entra, stub, ORIGIN, who);
    expect(result.error).toBe(AUTH_ERROR_CODES.tenantNotAllowed);
    expect(result.jar.has('session_token')).toBe(false);
    expect(await count('SELECT count(*) AS n FROM auth.user')).toBe(before);
    expect(await actorByEmail(who.email)).toBeNull();
  });

  it('[AUTH-003] is served from /api/auth/* through the handler', async () => {
    const ok = await entra.handle(new Request(`${ORIGIN}${AUTH_BASE_PATH}/ok`));
    expect(ok.status).toBe(200);
    expect(AUTH_BASE_PATH).toBe('/api/auth');
  });

  it('[AUTH-003] session cookies are HttpOnly and SameSite=Lax, and not Secure on a plain-http dev origin', async () => {
    const result = await signInWithEntra(entra, stub, ORIGIN, identity(['GitMigrator.Viewer']));
    const session = result.response.headers.getSetCookie().find((c) => c.includes('session_token'));
    expect(session).toBeDefined();
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).not.toMatch(/;\s*Secure/i);
  });

  it('[AUTH-003] cookies are Secure when the public URL is https', async () => {
    const https = createAuthForTest(
      {
        config: resolveConfig({ text: configYaml(false, 'https://gm.example.test'), env: {} }),
        secrets: SECRETS,
        connectionString: t.connectionString,
        db: t.db.privileged,
        env: {},
      },
      { entraAuthority: stub.authority },
    );
    try {
      const start = await https.handle(
        new Request(`https://gm.example.test${AUTH_BASE_PATH}/sign-in/social`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'https://gm.example.test' },
          body: JSON.stringify({ provider: 'microsoft', callbackURL: '/' }),
        }),
      );
      const cookies = start.headers.getSetCookie();
      expect(cookies.length).toBeGreaterThan(0);
      for (const cookie of cookies) {
        expect(cookie).toMatch(/;\s*Secure/i);
        expect(cookie).toMatch(/HttpOnly/i);
        expect(cookie).toMatch(/SameSite=Lax/i);
      }
    } finally {
      await https.close();
    }
  });

  it('[AUTH-004] sessions last 8 hours and refresh after 1 hour', async () => {
    expect(SESSION_EXPIRES_IN_SECONDS).toBe(8 * 3600);
    expect(SESSION_UPDATE_AGE_SECONDS).toBe(3600);
    const who = identity(['GitMigrator.Viewer']);
    await signInWithEntra(entra, stub, ORIGIN, who);
    const row = await t.db.pool.query<{ seconds: string }>(
      `SELECT extract(epoch FROM s."expiresAt" - s."createdAt") AS seconds
       FROM auth.session s JOIN auth."user" u ON u.id = s."userId" WHERE u.email = $1`,
      [authEmail(who)],
    );
    // The column names are Better Auth's own; fall back to its camelCase names if needed.
    expect(Math.round(Number(row.rows[0]?.seconds))).toBe(SESSION_EXPIRES_IN_SECONDS);
  });

  it('[AUTH-004] sign-out invalidates the session on the server', async () => {
    const who = identity(['GitMigrator.Operator']);
    const result = await signInWithEntra(entra, stub, ORIGIN, who);
    const headers = { cookie: result.jar.header(), origin: ORIGIN };
    const before = await entra.auth.api.getSession({ headers: new Headers(headers) });
    expect(before?.user.email).toBe(who.email);

    const out = await entra.handle(
      new Request(`${ORIGIN}${AUTH_BASE_PATH}/sign-out`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(out.status).toBe(200);
    // Replaying the old cookie after sign-out must not work: the row is gone, not just the cookie.
    const replay = await entra.auth.api.getSession({ headers: new Headers(headers) });
    expect(replay).toBeNull();
    expect(
      await count(
        `SELECT count(*) AS n FROM auth.session s JOIN auth."user" u ON u.id = s."userId"
         WHERE u.email = $1`,
        [authEmail(who)],
      ),
    ).toBe(0);
  });
});

describe('Actor provisioning and role sync (AUTH-005, AUTH-010, AUTH-011)', () => {
  it('[AUTH-005] the first sign-in creates a human Actor linked by authUserId, with name and email from the profile', async () => {
    const who = identity(['GitMigrator.Operator']);
    const result = await signInWithEntra(entra, stub, ORIGIN, who);
    expect(result.error).toBeNull();
    expect(result.location).toBe('/');
    expect(result.jar.has('session_token')).toBe(true);

    const user = await entra.auth.$context.then((c) =>
      c.internalAdapter.findUserByEmail(authEmail(who)),
    );
    expect(user).not.toBeNull();
    const actor = await actorByEmail(who.email);
    expect(actor).toMatchObject({
      kind: 'human',
      displayName: who.name,
      email: who.email,
      role: 'operator',
      disabled: false,
      authUserId: user?.user.id,
    });
  });

  it('[AUTH-011] reads the roles claim from the Entra ID token and maps it through config', async () => {
    const admin = identity(['GitMigrator.Admin']);
    const viewer = identity(['GitMigrator.Viewer']);
    await signInWithEntra(entra, stub, ORIGIN, admin);
    await signInWithEntra(entra, stub, ORIGIN, viewer);
    expect((await actorByEmail(admin.email))?.role).toBe('admin');
    expect((await actorByEmail(viewer.email))?.role).toBe('viewer');
  });

  it('[AUTH-010] the highest mapped role wins when the token carries several', async () => {
    const who = identity(['GitMigrator.Viewer', 'GitMigrator.Admin', 'Unrelated.Role']);
    await signInWithEntra(entra, stub, ORIGIN, who);
    expect((await actorByEmail(who.email))?.role).toBe('admin');
  });

  it('[AUTH-005] every later sign-in updates displayName and email and re-evaluates the role', async () => {
    const who = identity(['GitMigrator.Viewer']);
    await signInWithEntra(entra, stub, ORIGIN, who);
    const first = await actorByEmail(who.email);
    expect(first?.role).toBe('viewer');

    const renamed = { ...who, name: 'Renamed Person', roles: ['GitMigrator.Admin'] };
    const second = await signInWithEntra(entra, stub, ORIGIN, renamed);
    expect(second.error).toBeNull();
    const after = await t.db.privileged.actor.findUnique({ where: { id: first?.id ?? '' } });
    expect(after).toMatchObject({ displayName: 'Renamed Person', role: 'admin' });
    expect(await count('SELECT count(*) AS n FROM app.actor WHERE email = $1', [who.email])).toBe(
      1,
    );

    const emailChanged = {
      ...renamed,
      email: `moved-${who.email}`,
      preferred_username: `moved-${who.email}`,
    };
    await signInWithEntra(entra, stub, ORIGIN, emailChanged);
    expect(
      (await t.db.privileged.actor.findUnique({ where: { id: first?.id ?? '' } }))?.email,
    ).toBe(`moved-${who.email}`);
  });

  it('[AUTH-010] Entra is the source of truth: a role stored on the Actor is overwritten at sign-in', async () => {
    const who = identity(['GitMigrator.Viewer']);
    await signInWithEntra(entra, stub, ORIGIN, who);
    const actor = await actorByEmail(who.email);
    await t.db.privileged.actor.update({ where: { id: actor?.id ?? '' }, data: { role: 'admin' } });
    await signInWithEntra(entra, stub, ORIGIN, who);
    expect((await actorByEmail(who.email))?.role).toBe('viewer');
  });

  it('[AUTH-005] falls back to preferred_username when the token has no email claim', async () => {
    const who = identity(['GitMigrator.Viewer']);
    const { email: _omitted, ...withoutEmail } = who;
    const result = await signInWithEntra(entra, stub, ORIGIN, {
      ...withoutEmail,
      email: undefined,
    });
    expect(result.error).toBeNull();
    expect((await actorByEmail(who.preferred_username))?.displayName).toBe(who.name);
  });

  it('[AUTH-005] a seeded Actor with the same email is not taken over by an Entra identity (ADR-0170)', async () => {
    const seeded = await t.db.privileged.actor.create({
      data: {
        kind: 'human',
        displayName: 'Seeded',
        email: 'seeded-only@test.local',
        role: 'admin',
      },
    });
    const result = await signInWithEntra(entra, stub, ORIGIN, {
      ...identity(['GitMigrator.Viewer']),
      email: 'seeded-only@test.local',
    });
    expect(result.error).toBeNull();
    const untouched = await t.db.privileged.actor.findUnique({ where: { id: seeded.id } });
    expect(untouched).toMatchObject({ authUserId: null, role: 'admin', displayName: 'Seeded' });
    expect(
      await count(`SELECT count(*) AS n FROM app.actor WHERE email = 'seeded-only@test.local'`),
    ).toBe(2);
  });
});

describe('closed token surface (AUTH-002, AUTH-004, AUTH-010)', () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    entra.handle(
      new Request(`${ORIGIN}${AUTH_BASE_PATH}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
        body: JSON.stringify(body),
      }),
    );

  it('[AUTH-004] an id token sent by a client is never a sign-in', async () => {
    const who = identity(['GitMigrator.Operator']);
    const response = await post('/sign-in/social', {
      provider: 'microsoft',
      idToken: { token: stub.signIdToken(who) },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await actorByEmail(who.email)).toBeNull();
  });

  it('[AUTH-002] a client cannot widen the scopes or add authorize parameters', async () => {
    for (const extra of [
      { scopes: ['Mail.Read'] },
      { scopes: ['offline_access'] },
      { additionalParams: { prompt: 'none' } },
      { loginHint: 'someone@example.test' },
      { disableRedirect: true },
      { requestSignUp: true },
    ]) {
      const response = await post('/sign-in/social', {
        provider: 'microsoft',
        callbackURL: '/',
        ...extra,
      });
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it('[AUTH-002] only the allowlisted fields are accepted: additionalData is refused and stores nothing', async () => {
    const before = await count('SELECT count(*) AS n FROM auth.verification');
    const response = await post('/sign-in/social', {
      provider: 'microsoft',
      callbackURL: '/',
      additionalData: { blob: 'x'.repeat(10_000) },
    });
    expect(response.status).toBe(400);
    expect(await count('SELECT count(*) AS n FROM auth.verification')).toBe(before);
    for (const body of [[], 'microsoft', null]) {
      expect((await post('/sign-in/social', body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('[AUTH-003] a request body larger than the cap is refused with 413 before Better Auth reads it', async () => {
    const before = await count('SELECT count(*) AS n FROM auth.verification');
    const response = await post('/sign-in/social', {
      provider: 'microsoft',
      callbackURL: `/${'a'.repeat(MAX_AUTH_BODY_BYTES)}`,
    });
    expect(response.status).toBe(413);
    expect(await count('SELECT count(*) AS n FROM auth.verification')).toBe(before);
    const declared = await entra.handle(
      new Request(`${ORIGIN}${AUTH_BASE_PATH}/sign-in/social`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          'content-length': String(MAX_AUTH_BODY_BYTES + 1),
        },
        body: '{}',
      }),
    );
    expect(declared.status).toBe(413);
  });

  it('[AUTH-002] the production createAuth takes no test seams: the authority stays the Entra default', async () => {
    const production = createAuth({
      config,
      secrets: SECRETS,
      connectionString: t.connectionString,
      db: t.db.privileged,
      env: {},
      entraAuthority: stub.authority,
    } as CreateAuthOptions);
    try {
      const response = await production.handle(
        new Request(`${ORIGIN}${AUTH_BASE_PATH}/sign-in/social`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          body: JSON.stringify({ provider: 'microsoft', callbackURL: '/' }),
        }),
      );
      const { url } = (await response.json()) as { url: string };
      expect(new URL(url).origin).toBe('https://login.microsoftonline.com');
    } finally {
      await production.close();
    }
  });

  it('[AUTH-004] the token and account endpoints answer 404 for a signed-in user', async () => {
    const signedIn = await signInWithEntra(entra, stub, ORIGIN, identity(['GitMigrator.Admin']));
    const headers = { cookie: signedIn.jar.header() };
    for (const path of DISABLED_PATHS) {
      const response = await post(path, {}, headers);
      expect(response.status, path).toBe(404);
    }
    const sessionStillWorks = await entra.auth.api.getSession({ headers: new Headers(headers) });
    expect(sessionStillWorks).not.toBeNull();
  });

  it('[AUTH-004] OAuth tokens are not stored in the Better Auth tables, on first or later sign-ins', async () => {
    const who = identity(['GitMigrator.Viewer']);
    await signInWithEntra(entra, stub, ORIGIN, who);
    await signInWithEntra(entra, stub, ORIGIN, who);
    const rows = await t.db.pool.query<Record<string, unknown>>(
      `SELECT a."accessToken", a."refreshToken", a."idToken" FROM auth.account a
       JOIN auth."user" u ON u.id = a."userId" WHERE u.email = $1`,
      [authEmail(who)],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toEqual({ accessToken: null, refreshToken: null, idToken: null });
  });

  it('[AUTH-004] sign-out leaves nothing a former session holder could replay', async () => {
    const who = identity(['GitMigrator.Operator']);
    const signedIn = await signInWithEntra(entra, stub, ORIGIN, who);
    const headers = { cookie: signedIn.jar.header(), origin: ORIGIN };
    await post('/sign-out', {}, headers);
    const replay = await post('/get-access-token', { providerId: 'microsoft' }, headers);
    expect(replay.status).toBe(404);
    expect(await entra.auth.api.getSession({ headers: new Headers(headers) })).toBeNull();
  });
});

describe('identity is the oid, not the email (AUTH-005, AUTH-010)', () => {
  it('[AUTH-005] auth.user holds a synthetic oid-based address; the real address lives on the Actor', async () => {
    const who = identity(['GitMigrator.Viewer']);
    await signInWithEntra(entra, stub, ORIGIN, who);
    const users = await t.db.pool.query<{ email: string }>(
      'SELECT email FROM auth."user" WHERE email = $1',
      [authEmail(who)],
    );
    expect(users.rows).toHaveLength(1);
    expect(authEmail(who)).toMatch(/@entra\.invalid$/);
    expect((await actorByEmail(who.email))?.email).toBe(who.email);
    expect(await count('SELECT count(*) AS n FROM auth."user" WHERE email = $1', [who.email])).toBe(
      0,
    );
  });

  it("[AUTH-005] a user who changes email onto another user's address keeps signing in, and so does the other", async () => {
    const a = identity(['GitMigrator.Viewer']);
    const b = identity(['GitMigrator.Operator']);
    expect((await signInWithEntra(entra, stub, ORIGIN, a)).error).toBeNull();
    expect((await signInWithEntra(entra, stub, ORIGIN, b)).error).toBeNull();
    const moved = { ...b, email: a.email, preferred_username: a.email };
    expect((await signInWithEntra(entra, stub, ORIGIN, moved)).error).toBeNull();
    expect((await signInWithEntra(entra, stub, ORIGIN, a)).error).toBeNull();
    const actors = await t.db.privileged.actor.findMany({ where: { email: a.email } });
    expect(actors.map((x) => x.role).sort()).toEqual(['operator', 'viewer']);
  });

  it("[AUTH-005] a new oid with a former user's email signs in as a new Actor", async () => {
    const former = identity(['GitMigrator.Viewer']);
    await signInWithEntra(entra, stub, ORIGIN, former);
    const successor = identity(['GitMigrator.Admin'], {
      email: former.email,
      preferred_username: former.email,
    });
    const result = await signInWithEntra(entra, stub, ORIGIN, successor);
    expect(result.error).toBeNull();
    const actors = await t.db.privileged.actor.findMany({ where: { email: former.email } });
    expect(actors.map((x) => x.role).sort()).toEqual(['admin', 'viewer']);
  });

  it('[AUTH-005] an unexpected failure while completing a sign-in ends on the error page, not a 500', async () => {
    const broken = createAuthForTest(
      {
        config,
        secrets: SECRETS,
        connectionString: t.connectionString,
        db: {} as never,
        env: {},
      },
      { entraAuthority: stub.authority },
    );
    try {
      const result = await signInWithEntra(broken, stub, ORIGIN, identity(['GitMigrator.Admin']));
      expect(result.status).toBe(302);
      expect(new URL(result.location ?? '', ORIGIN).pathname).toBe('/auth/error');
      expect(result.error).toMatch(/^[a-z_]+$/);
      expect(result.jar.has('session_token')).toBe(false);
    } finally {
      await broken.close();
    }
  });
});

describe('audit of the sign-in sync (AUTH-022)', () => {
  it('[AUTH-022] actor creation and role changes by the sync are audited as the system', async () => {
    const who = identity(['GitMigrator.Viewer']);
    await signInWithEntra(entra, stub, ORIGIN, who);
    const actor = await actorByEmail(who.email);
    await signInWithEntra(entra, stub, ORIGIN, who); // no role change: no event
    await signInWithEntra(entra, stub, ORIGIN, { ...who, roles: ['GitMigrator.Admin'] });
    const events = await t.db.privileged.auditEvent.findMany({
      where: { subjectType: 'actor', subjectId: actor?.id ?? '' },
      orderBy: { at: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual([
      'actor.created_by_sign_in',
      'actor.role_changed_by_sign_in',
    ]);
    expect(events.every((e) => e.actorId === null)).toBe(true);
    expect(events[1]?.data).toEqual({ oldRole: 'viewer', newRole: 'admin' });
  });
});

describe('tenant id and logging (AUTH-002, DEP-050)', () => {
  it('[AUTH-002] a tenant id written in upper case with spaces still matches the tid claim', async () => {
    const upper = createAuthForTest(
      {
        config: resolveConfig({
          text: configYaml(false).replace(TENANT, ` ${TENANT.toUpperCase()} `),
          env: {},
        }),
        secrets: SECRETS,
        connectionString: t.connectionString,
        db: t.db.privileged,
        env: {},
      },
      { entraAuthority: stub.authority },
    );
    try {
      const result = await signInWithEntra(upper, stub, ORIGIN, identity(['GitMigrator.Viewer']));
      expect(result.error).toBeNull();
    } finally {
      await upper.close();
    }
  });

  it('[AUTH-002] a tenant that is not a GUID is refused at startup', () => {
    expect(() =>
      createAuth({
        config: resolveConfig({ text: configYaml(false).replace(TENANT, 'contoso.com'), env: {} }),
        secrets: SECRETS,
        connectionString: t.connectionString,
        db: t.db.privileged,
        env: {},
      }),
    ).toThrow(/tenant GUID/);
  });

  it('[DEP-050] Better Auth output goes through the redacting JSON logger, keeping the error', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', destination: { write: (l) => lines.push(l) } });
    const logged = createAuthForTest(
      {
        config,
        secrets: SECRETS,
        connectionString: t.connectionString,
        db: t.db.privileged,
        env: {},
        logger,
      },
      { entraAuthority: stub.authority },
    );
    try {
      const ctx = await logged.auth.$context;
      const token = `eyJhbGciOiJSUzI1NiJ9.${'a'.repeat(40)}.${'b'.repeat(40)}`;
      const failure = new Error(`boom for ada@example.test ${token}`, {
        cause: new Error('inner grace@example.test'),
      });
      ctx.logger.error(`failed for bob@example.test with Bearer ${token}`, failure, {
        who: 'carol@example.test',
      });
    } finally {
      await logged.close();
    }
    const text = lines.join('');
    for (const secret of ['ada@', 'bob@', 'carol@', 'grace@', 'a'.repeat(40)]) {
      expect(text).not.toContain(secret);
    }
    const line = JSON.parse(lines[0] ?? '{}') as {
      component?: string;
      err?: { message?: string };
    };
    expect(line.component).toBe('auth');
    expect(line.err?.message).toContain('boom');
    expect(text).toContain('inner');
  });

  it('[DEP-050] the Better Auth migration logs through the same JSON logger', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', destination: { write: (l) => lines.push(l) } });
    const fresh = await createTestDatabase('gm_t020l_');
    try {
      // A table named like Better Auth's, with a wrong column type, makes the migrator report.
      await fresh.db.pool.query('CREATE TABLE auth."user" (id text PRIMARY KEY, name integer)');
      await migrateAuthSchema(fresh.connectionString, logger).catch(() => undefined);
    } finally {
      await fresh.drop();
    }
    const parsed = lines.map((l) => JSON.parse(l) as { component?: string });
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.every((l) => l.component === 'auth')).toBe(true);
  }, 60_000);

  it('[DEP-050] a huge address-like callbackURL is refused quickly, and its log lines stay short', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', destination: { write: (l) => lines.push(l) } });
    const logged = createAuthForTest(
      {
        config,
        secrets: SECRETS,
        connectionString: t.connectionString,
        db: t.db.privileged,
        env: {},
        logger,
      },
      { entraAuthority: stub.authority },
    );
    try {
      const callbackURL = `https://evil.example/${'a'.repeat(30_000)}@${'b'.repeat(30_000)}`;
      const started = performance.now();
      const response = await logged.handle(
        new Request(`${ORIGIN}${AUTH_BASE_PATH}/sign-in/social`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          body: JSON.stringify({ provider: 'microsoft', callbackURL }),
        }),
      );
      expect(response.status).toBe(403);
      expect(performance.now() - started).toBeLessThan(1_500);
    } finally {
      await logged.close();
    }
    for (const line of lines) expect(line.length).toBeLessThan(16 * 1024);
  });
});

describe('route surface and request checks (AUTH-003, AUTH-004)', () => {
  const KEPT = new Set([
    '/sign-in/social',
    '/sign-in/email',
    '/callback/:id',
    '/get-session',
    '/sign-out',
    '/ok',
    '/error',
  ]);

  it('[AUTH-004] every Better Auth route is either kept on purpose or unreachable', async () => {
    const routes = Object.values(testSignIn.auth.api as Record<string, { path?: string }>)
      .map((endpoint) => endpoint.path)
      .filter((path): path is string => typeof path === 'string');
    expect(routes.length).toBeGreaterThan(10);
    // Structural: a route is kept on purpose or disabled on purpose, never 404 by accident.
    const disabled = new Set<string>(DISABLED_PATHS);
    const unaccounted = routes.filter(
      (route) =>
        !KEPT.has(route) &&
        !disabled.has(route) &&
        !DISABLED_PATH_PREFIXES.some((prefix) => route.startsWith(prefix)),
    );
    expect(unaccounted).toEqual([]);
    const unexpected: string[] = [];
    for (const route of routes) {
      if (KEPT.has(route)) continue;
      const concrete = route.replaceAll(/:[A-Za-z]+/g, 'x');
      for (const method of ['GET', 'POST']) {
        const response = await entra.handle(
          new Request(`${ORIGIN}${AUTH_BASE_PATH}${concrete}`, {
            method,
            headers: { 'content-type': 'application/json', origin: ORIGIN },
            body: method === 'POST' ? '{}' : undefined,
          }),
        );
        if (response.status !== 404) unexpected.push(`${method} ${route} -> ${response.status}`);
      }
    }
    // A route a Better Auth upgrade adds shows up here until it is kept or disabled on purpose.
    expect(unexpected).toEqual([]);
  });

  it('[AUTH-003] a foreign callbackURL or errorCallbackURL is refused', async () => {
    for (const extra of [
      { callbackURL: 'https://evil.example/' },
      { callbackURL: '/', errorCallbackURL: 'https://evil.example/' },
      { callbackURL: '/', newUserCallbackURL: 'https://evil.example/' },
    ]) {
      const response = await entra.handle(
        new Request(`${ORIGIN}${AUTH_BASE_PATH}/sign-in/social`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          body: JSON.stringify({ provider: 'microsoft', ...extra }),
        }),
      );
      expect(response.status, JSON.stringify(extra)).toBe(403);
    }
  });

  it('[AUTH-003] a cookie-bearing POST from a foreign Origin is refused, a same-origin one works', async () => {
    const signedIn = await signInWithEntra(entra, stub, ORIGIN, identity(['GitMigrator.Viewer']));
    const post = (origin: string) =>
      entra.handle(
        new Request(`${ORIGIN}${AUTH_BASE_PATH}/sign-out`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: signedIn.jar.header(), origin },
          body: '{}',
        }),
      );
    expect((await post('https://evil.example')).status).toBe(403);
    expect(
      await entra.auth.api.getSession({ headers: new Headers({ cookie: signedIn.jar.header() }) }),
    ).not.toBeNull();
    expect((await post(ORIGIN)).status).toBe(200);
  });

  it('[AUTH-004] the session response never carries the synthetic address', async () => {
    const who = identity(['GitMigrator.Operator']);
    const signedIn = await signInWithEntra(entra, stub, ORIGIN, who);
    const response = await entra.handle(
      new Request(`${ORIGIN}${AUTH_BASE_PATH}/get-session`, {
        headers: { cookie: signedIn.jar.header() },
      }),
    );
    const text = await response.text();
    expect(text).not.toContain('.invalid');
    expect((JSON.parse(text) as { user: { email: string } }).user.email).toBe(who.email);
    const viaApi = await entra.auth.api.getSession({
      headers: new Headers({ cookie: signedIn.jar.header() }),
    });
    expect(viaApi?.user.email).toBe(who.email);
  });

  it('[AUTH-010] a decision made for a different oid never becomes a session', async () => {
    const mixed = createAuthForTest(
      {
        config,
        secrets: SECRETS,
        connectionString: t.connectionString,
        db: t.db.privileged,
        env: {},
      },
      {
        entraAuthority: stub.authority,
        mutateEntraDecision: (d) => ({ ...d, oid: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }),
      },
    );
    try {
      const who = identity(['GitMigrator.Admin']);
      const result = await signInWithEntra(mixed, stub, ORIGIN, who);
      expect(result.error).toBe(AUTH_ERROR_CODES.roleAssignmentRequired);
      expect(result.jar.has('session_token')).toBe(false);
      expect(await actorByEmail(who.email)).toBeNull();
    } finally {
      await mixed.close();
    }
  });
});

describe('role mapping denial (AUTH-010)', () => {
  it('[AUTH-010] denies a sign-in with no matching role, explains why and creates no session', async () => {
    const who = identity(['Some.Other.Role']);
    const users = await count('SELECT count(*) AS n FROM auth.user');
    const sessions = await count('SELECT count(*) AS n FROM auth.session');
    const actors = await count('SELECT count(*) AS n FROM app.actor');

    const result = await signInWithEntra(entra, stub, ORIGIN, who);
    expect(result.status).toBe(302);
    expect(new URL(result.location ?? '', ORIGIN).pathname).toBe('/auth/error');
    expect(result.error).toBe(AUTH_ERROR_CODES.roleAssignmentRequired);
    expect(result.jar.has('session_token')).toBe(false);
    expect(await count('SELECT count(*) AS n FROM auth.user')).toBe(users);
    expect(await count('SELECT count(*) AS n FROM auth.session')).toBe(sessions);
    expect(await count('SELECT count(*) AS n FROM app.actor')).toBe(actors);
  });

  it('[AUTH-010] denies a token without a roles claim', async () => {
    const result = await signInWithEntra(entra, stub, ORIGIN, identity([]));
    expect(result.error).toBe(AUTH_ERROR_CODES.roleAssignmentRequired);
  });

  it('[AUTH-010] a user who lost the app role assignment is denied, keeps the stored role and loses their sessions', async () => {
    const who = identity(['GitMigrator.Operator']);
    const first = await signInWithEntra(entra, stub, ORIGIN, who);
    expect(first.error).toBeNull();
    const headers = new Headers({ cookie: first.jar.header() });
    expect(await entra.auth.api.getSession({ headers })).not.toBeNull();

    const denied = await signInWithEntra(entra, stub, ORIGIN, { ...who, roles: [] });
    expect(denied.error).toBe(AUTH_ERROR_CODES.roleAssignmentRequired);
    expect(await entra.auth.api.getSession({ headers })).toBeNull();
    expect((await actorByEmail(who.email))?.role).toBe('operator');
  });

  it('[AUTH-010] without the per-request state the Entra sign-in fails closed', async () => {
    const who = identity(['GitMigrator.Admin']);
    const direct = { ...entra, handle: (r: Request) => entra.auth.handler(r) } as AuthService;
    const result = await signInWithEntra(direct, stub, ORIGIN, who);
    expect(result.error).toBe(AUTH_ERROR_CODES.roleAssignmentRequired);
    expect(result.jar.has('session_token')).toBe(false);
    expect(await actorByEmail(who.email)).toBeNull();
  });

  it('[AUTH-010] with no mappings configured no Entra user can sign in', async () => {
    const bare = createAuthForTest(
      {
        config: resolveConfig({
          text: `environment: test\npublicUrl: ${ORIGIN}\nauth:\n  entra: { tenantId: "${TENANT}" }\n`,
          env: {},
        }),
        secrets: SECRETS,
        connectionString: t.connectionString,
        db: t.db.privileged,
        env: {},
      },
      { entraAuthority: stub.authority },
    );
    try {
      const result = await signInWithEntra(bare, stub, ORIGIN, identity(['GitMigrator.Admin']));
      expect(result.error).toBe(AUTH_ERROR_CODES.roleAssignmentRequired);
    } finally {
      await bare.close();
    }
  });
});

describe('disabled Actors (AUTH-005)', () => {
  it('[AUTH-005] a disabled Actor cannot sign in and its existing sessions are revoked', async () => {
    const who = identity(['GitMigrator.Admin']);
    const first = await signInWithEntra(entra, stub, ORIGIN, who);
    const other = await signInWithEntra(entra, stub, ORIGIN, who);
    const headers = new Headers({ cookie: first.jar.header() });
    expect(await entra.auth.api.getSession({ headers })).not.toBeNull();
    expect(other.error).toBeNull();

    const actor = await actorByEmail(who.email);
    await t.db.privileged.actor.update({
      where: { id: actor?.id ?? '' },
      data: { disabled: true },
    });

    const rejected = await signInWithEntra(entra, stub, ORIGIN, who);
    expect(rejected.error).toBe(AUTH_ERROR_CODES.actorDisabled);
    expect(rejected.jar.has('session_token')).toBe(false);
    expect(await entra.auth.api.getSession({ headers })).toBeNull();
    expect(
      await count(
        `SELECT count(*) AS n FROM auth.session s JOIN auth."user" u ON u.id = s."userId"
         WHERE u.email = $1`,
        [authEmail(who)],
      ),
    ).toBe(0);
    // The disabled Actor is not modified by the rejected sign-in.
    expect(
      await t.db.privileged.actor.findUnique({ where: { id: actor?.id ?? '' } }),
    ).toMatchObject({
      disabled: true,
      role: 'admin',
    });
  });
});

describe('test sign-in (AUTH-012)', () => {
  const signInWithPassword = (service: AuthService, email: string, password: string) =>
    service.handle(
      new Request(`${ORIGIN}${AUTH_BASE_PATH}/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email, password }),
      }),
    );

  beforeAll(async () => {
    // The seed script creates the Actors (db package); this creates their sign-in users.
    const { seedDev } = await import('@git-migrator/db');
    await seedDev(t.db.privileged);
  });

  it('[AUTH-012] the seed creates one sign-in user per role and is idempotent', async () => {
    const first = await seedTestSignInUsers(testSignIn, {
      config: testConfig,
      env: { GM_ENVIRONMENT: 'test' },
      password: PASSWORD,
    });
    expect(first).toEqual({ created: TEST_ACTORS.length, passwordUpdated: 0 });
    expect(
      await seedTestSignInUsers(testSignIn, {
        config: testConfig,
        env: { GM_ENVIRONMENT: 'test' },
        password: PASSWORD,
      }),
    ).toEqual({ created: 0, passwordUpdated: 0 });
    for (const spec of TEST_ACTORS) {
      expect(spec.email).toMatch(/^(viewer|operator|admin)@test\.local$/);
    }
  });

  it('[AUTH-012] signs in with email and password, links the seeded Actor by email and keeps its role', async () => {
    for (const spec of TEST_ACTORS) {
      const before = await actorByEmail(spec.email);
      expect(before?.authUserId).toBeNull();
      const response = await signInWithPassword(testSignIn, spec.email, PASSWORD);
      expect(response.status).toBe(200);
      const jar = new CookieJar();
      jar.absorb(response);
      expect(jar.has('session_token')).toBe(true);
      const after = await actorByEmail(spec.email);
      expect(after?.authUserId).not.toBeNull();
      expect(after).toMatchObject({ id: before?.id, role: spec.role });
    }
  });

  it('[AUTH-012] test sign-in users are exempt from role mapping and survive repeated sign-ins', async () => {
    const response = await signInWithPassword(testSignIn, 'viewer@test.local', PASSWORD);
    expect(response.status).toBe(200);
    expect((await actorByEmail('viewer@test.local'))?.role).toBe('viewer');
  });

  it('[AUTH-012] rejects a wrong password and creates no session', async () => {
    const before = await count('SELECT count(*) AS n FROM auth.session');
    const response = await signInWithPassword(testSignIn, 'admin@test.local', 'not-the-password');
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await count('SELECT count(*) AS n FROM auth.session')).toBe(before);
  });

  it('[AUTH-012] self-registration is off: only seeded users exist', async () => {
    const response = await testSignIn.handle(
      new Request(`${ORIGIN}${AUTH_BASE_PATH}/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: 'new@test.local', password: PASSWORD, name: 'New' }),
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(
      await count(`SELECT count(*) AS n FROM auth."user" WHERE email = 'new@test.local'`),
    ).toBe(0);
  });

  it('[AUTH-012] email and password sign-in is not available unless auth.testSignIn.enabled', async () => {
    const response = await signInWithPassword(entra, 'admin@test.local', PASSWORD);
    expect(response.status).toBeGreaterThanOrEqual(400);
    const jar = new CookieJar();
    jar.absorb(response);
    expect(jar.has('session_token')).toBe(false);
  });

  it('[AUTH-012] a disabled test Actor cannot sign in', async () => {
    const actor = await actorByEmail('operator@test.local');
    await t.db.privileged.actor.update({
      where: { id: actor?.id ?? '' },
      data: { disabled: true },
    });
    try {
      const response = await signInWithPassword(testSignIn, 'operator@test.local', PASSWORD);
      expect(response.status).toBe(403);
    } finally {
      await t.db.privileged.actor.update({
        where: { id: actor?.id ?? '' },
        data: { disabled: false },
      });
    }
  });

  it('[AUTH-012] a test user without an Actor is denied', async () => {
    const context = await testSignIn.auth.$context;
    await createCredentialUser(testSignIn, {
      email: 'orphan@test.local',
      name: 'Orphan',
      passwordHash: await context.password.hash(PASSWORD),
    });
    const response = await signInWithPassword(testSignIn, 'orphan@test.local', PASSWORD);
    expect(response.status).toBe(403);
  });

  it('[AUTH-012] a changed GM_TEST_USER_PASSWORD replaces the stored password at the next seed', async () => {
    const result = await seedTestSignInUsers(testSignIn, {
      config: testConfig,
      env: { GM_ENVIRONMENT: 'test' },
      password: 'a-different-fake-password',
    });
    expect(result).toEqual({ created: 0, passwordUpdated: TEST_ACTORS.length });
    expect((await signInWithPassword(testSignIn, 'admin@test.local', PASSWORD)).status).toBe(401);
    expect(
      (await signInWithPassword(testSignIn, 'admin@test.local', 'a-different-fake-password'))
        .status,
    ).toBe(200);
  });

  it('[AUTH-012] the seed refuses to run when test sign-in is off or the password is empty', async () => {
    await expect(
      seedTestSignInUsers(entra, { config, env: { GM_ENVIRONMENT: 'test' }, password: PASSWORD }),
    ).rejects.toThrow(/testSignIn/);
    await expect(
      seedTestSignInUsers(testSignIn, { config: testConfig, env: {}, password: '' }),
    ).rejects.toThrow(/GM_TEST_USER_PASSWORD/);
  });

  it('[AUTH-012] startup aborts when test sign-in is enabled and GM_ENVIRONMENT is production', () => {
    expect(() =>
      createAuth({
        config: testConfig,
        secrets: SECRETS,
        connectionString: t.connectionString,
        db: t.db.privileged,
        env: { GM_ENVIRONMENT: 'production' },
      }),
    ).toThrow(/AUTH-012/);
    expect(() =>
      createAuth({
        config: { ...testConfig, environment: 'production' },
        secrets: SECRETS,
        connectionString: t.connectionString,
        db: t.db.privileged,
        env: {},
      }),
    ).toThrow(/AUTH-012/);
  });

  it('[AUTH-012] the seed also refuses to run in production', async () => {
    await expect(
      seedTestSignInUsers(testSignIn, {
        config: testConfig,
        env: { GM_ENVIRONMENT: 'production' },
        password: PASSWORD,
      }),
    ).rejects.toThrow(/AUTH-012/);
  });
});
