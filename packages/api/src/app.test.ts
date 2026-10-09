import { type AuthService, migrateAuthSchema } from '@git-migrator/auth';
import {
  CookieJar,
  createAuthForTest,
  type EntraStub,
  signInWithEntra,
  startEntraStub,
} from '@git-migrator/auth/testing';
import { resolveConfig } from '@git-migrator/config';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiDeps, createApiApp, MAX_API_BODY_BYTES } from './app.ts';
import { createApiClient } from './client.ts';
import { createEventHub } from './events.ts';
import { PROBLEM_BASE, PROBLEM_CONTENT_TYPE } from './problem.ts';

/** A hub whose listener never connects: these tests do not use `/api/v1/events`. */
const inertEvents = () =>
  createEventHub({
    listener: { start: () => undefined, subscribe: () => () => undefined, connected: false },
  });

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT_ID = 'client-id-fake';
const ORIGIN = 'http://localhost:3000';
const ROLE_VALUE = {
  admin: 'GitMigrator.Admin',
  operator: 'GitMigrator.Operator',
  viewer: 'GitMigrator.Viewer',
} as const;

const configYaml = `
environment: test
publicUrl: ${ORIGIN}
auth:
  entra: { tenantId: "${TENANT}" }
  testSignIn: { enabled: false }
  roleMappings:
    - { method: entra, claim: roles, value: "GitMigrator.Admin", role: admin }
    - { method: entra, claim: roles, value: "GitMigrator.Operator", role: operator }
    - { method: entra, claim: roles, value: "GitMigrator.Viewer", role: viewer }
`;

let t: TestDatabase;
let stub: EntraStub;
let service: AuthService;
let ready = true;
let app: ReturnType<typeof createApiApp>;
let counter = 0;

beforeAll(async () => {
  t = await createTestDatabase('gm_t021w_');
  await migrateAuthSchema(t.connectionString);
  stub = await startEntraStub({ tenantId: TENANT, clientId: CLIENT_ID });
  service = createAuthForTest(
    {
      config: resolveConfig({ text: configYaml, env: {} }),
      secrets: {
        authSecret: 'fake-better-auth-secret-0000000000000000',
        entraClientId: CLIENT_ID,
        entraClientSecret: 'fake-client-secret',
      },
      connectionString: t.connectionString,
      db: t.db.privileged,
      env: { GM_ENVIRONMENT: 'test' },
    },
    { entraAuthority: stub.authority },
  );
  const deps: ApiDeps = {
    events: inertEvents(),
    db: t.db,
    auth: service,
    publicUrl: ORIGIN,
    ready: () => ready,
  };
  app = createApiApp(deps);
}, 120_000);

afterAll(async () => {
  await service?.close();
  await stub?.close();
  await t?.drop();
});

interface Who {
  jar: CookieJar;
  email: string;
  name: string;
  oid: string;
}

/** Signs a fresh Entra user in (through the Hono mount) and returns the session cookies. */
async function signIn(role: keyof typeof ROLE_VALUE): Promise<Who> {
  counter++;
  const oid = `00000000-0000-0000-0000-${String(counter).padStart(12, '0')}`;
  const email = `person${counter}@example.test`;
  const name = `Person ${counter}`;
  const jar = new CookieJar();
  // Sign-in goes through app.request, so `/api/auth/*` is served by AuthService.handle.
  const result = await signInWithEntra(
    {
      handle: (request: Request) => app.request(request),
    } as unknown as AuthService,
    stub,
    ORIGIN,
    { oid, email, preferred_username: email, name, roles: [ROLE_VALUE[role]] },
    jar,
  );
  expect(result.error, 'sign-in must succeed').toBeNull();
  return { jar, email, name, oid };
}

const call = (
  path: string,
  init: {
    method?: string;
    jar?: CookieJar;
    key?: string;
    body?: unknown;
    origin?: string | null;
    headers?: Record<string, string>;
  } = {},
) => {
  const headers: Record<string, string> = { ...init.headers };
  if (init.jar) headers.cookie = init.jar.header();
  if (init.key) headers.authorization = `Bearer ${init.key}`;
  if (init.origin !== null && init.jar && init.method && init.method !== 'GET') {
    headers.origin = init.origin ?? ORIGIN;
  }
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return app.request(`${ORIGIN}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined
      ? {}
      : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
  });
};

const expectProblem = async (res: Response, status: number, code: string) => {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.type).toBe(`${PROBLEM_BASE}${code}`);
  expect(body.status).toBe(status);
  expect(body.code).toBe(code);
  expect(typeof body.title).toBe('string');
  return body;
};

describe('[API-001] one Hono app serves auth, RPC, v1 and health', () => {
  it('[API-001] /api/healthz answers without the database and /api/readyz checks it', async () => {
    const live = await call('/api/healthz');
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });
    const ok = await call('/api/readyz');
    expect(ok.status).toBe(200);
    ready = false;
    await expectProblem(await call('/api/readyz'), 503, 'not_ready');
    ready = true;
  });

  it('[API-001] readiness fails when the database is unreachable', async () => {
    const broken = createApiApp({
      events: inertEvents(),
      db: { ...t.db, pool: { query: () => Promise.reject(new Error('down')) } as never },
      auth: service,
      publicUrl: ORIGIN,
    });
    const res = await broken.request(`${ORIGIN}/api/readyz`);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('down');
  });

  it('[API-001] [AUTH-003] Entra sign-in works through the mount (AuthService.handle) and yields a session', async () => {
    const who = await signIn('viewer');
    const session = await call('/api/auth/get-session', { jar: who.jar });
    expect(session.status).toBe(200);
    const body = (await session.json()) as { user: { id: string } };
    expect(body.user.id).toBeTruthy();
  });

  it('[API-001] a path that does not exist answers 404 problem+json', async () => {
    const who = await signIn('viewer');
    await expectProblem(await call('/api/v1/nope', { jar: who.jar }), 404, 'not_found');
    await expectProblem(await call('/elsewhere'), 404, 'not_found');
  });
});

describe('[AUTH-020] every request resolves to an Actor or gets 401', () => {
  it('[AUTH-020] anonymous requests to RPC and v1 are 401 problem+json', async () => {
    for (const path of ['/api/model/wave/findMany', '/api/v1/me', '/api/v1/openapi.json']) {
      const res = await call(path);
      await expectProblem(res, 401, 'unauthenticated');
      expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
    }
  });

  it('[AUTH-020] the Actor, not session.user, supplies display name and email (ADR-0171)', async () => {
    const who = await signIn('operator');
    const res = await call('/api/v1/me', { jar: who.jar });
    expect(res.status).toBe(200);
    const me = (await res.json()) as Record<string, unknown>;
    expect(me).toMatchObject({
      kind: 'human',
      role: 'operator',
      email: who.email,
      displayName: who.name,
      disabled: false,
    });
    expect(JSON.stringify(me)).not.toContain('.invalid');
  });

  it('[AUTH-020] [AUTH-005] a disabled Actor holding an existing session gets 401', async () => {
    const who = await signIn('operator');
    expect((await call('/api/v1/me', { jar: who.jar })).status).toBe(200);
    expect((await call('/api/model/wave/findMany', { jar: who.jar })).status).toBe(200);
    await t.db.privileged.actor.updateMany({
      where: { email: who.email },
      data: { disabled: true },
    });
    await expectProblem(await call('/api/v1/me', { jar: who.jar }), 401, 'unauthenticated');
    await expectProblem(
      await call('/api/model/wave/findMany', { jar: who.jar }),
      401,
      'unauthenticated',
    );
    // Re-enabled, the same session works again: nothing was cached.
    await t.db.privileged.actor.updateMany({
      where: { email: who.email },
      data: { disabled: false },
    });
    expect((await call('/api/v1/me', { jar: who.jar })).status).toBe(200);
  });

  it('[AUTH-020] a session whose user has no Actor is 401', async () => {
    const who = await signIn('viewer');
    await t.db.pool.query('UPDATE app.actor SET auth_user_id = NULL WHERE email = $1', [who.email]);
    await expectProblem(await call('/api/v1/me', { jar: who.jar }), 401, 'unauthenticated');
  });
});

describe('[AUTH-004] cookie-authenticated writes must come from the public origin', () => {
  it('[AUTH-004] a session POST without or with a foreign Origin is 403, and a GET needs none', async () => {
    const who = await signIn('operator');
    const body = { data: { name: `csrf-${counter}` } };
    await expectProblem(
      await call('/api/model/wave/create', { method: 'POST', jar: who.jar, body, origin: null }),
      403,
      'origin_not_allowed',
    );
    await expectProblem(
      await call('/api/model/wave/create', {
        method: 'POST',
        jar: who.jar,
        body,
        origin: 'https://evil.example',
      }),
      403,
      'origin_not_allowed',
    );
    expect(await t.db.privileged.wave.findFirst({ where: { name: body.data.name } })).toBeNull();
    expect((await call('/api/model/wave/findMany', { jar: who.jar })).status).toBe(200);
  });
});

describe('[API-001] ZenStack RPC with session Actors', () => {
  it('[API-001] [API-012] an operator creates a Wave, a viewer cannot, and the audit plugin records it', async () => {
    const op = await signIn('operator');
    const viewer = await signIn('viewer');
    const created = await call('/api/model/wave/create', {
      method: 'POST',
      jar: op.jar,
      body: { data: { name: 'rpc-session-wave' } },
    });
    expect(created.status).toBe(201);
    const wave = ((await created.json()) as { data: { id: string } }).data;
    const operatorActor = await t.db.privileged.actor.findFirst({ where: { email: op.email } });
    const event = await t.db.privileged.auditEvent.findFirst({
      where: { subjectId: wave.id, action: 'rpc.wave.create' },
    });
    expect(event?.actorId).toBe(operatorActor?.id);

    const denied = await call('/api/model/wave/create', {
      method: 'POST',
      jar: viewer.jar,
      body: { data: { name: 'rpc-viewer-wave' } },
    });
    expect(denied.status).toBe(403);
    expect(await t.db.privileged.wave.findFirst({ where: { name: 'rpc-viewer-wave' } })).toBeNull();
  });

  it('[AUTH-021] the RPC mount runs on the facade: a function-bearing JSON body cannot reach SQL', async () => {
    const who = await signIn('viewer');
    const res = await call('/api/model/wave/findMany', {
      method: 'GET',
      jar: who.jar,
      headers: {},
    });
    expect(res.status).toBe(200);
    const evil = await call(
      `/api/model/wave/findMany?q=${encodeURIComponent(JSON.stringify({ where: { $expr: 'x' } }))}`,
      { jar: who.jar },
    );
    expect(evil.status).toBeGreaterThanOrEqual(400);
    expect(await evil.text()).not.toMatch(/select |insert |sqlParams/i);
  });
});

describe('[AUTH-040] API keys authenticate service Actors', () => {
  let admin: Who;
  let serviceId: string;
  let key: string;
  let keyId: string;

  beforeAll(async () => {
    admin = await signIn('admin');
  });

  it('[AUTH-040] [API-020] an admin creates a service Actor and issues a key, shown once', async () => {
    const actorRes = await call('/api/v1/actors', {
      method: 'POST',
      jar: admin.jar,
      body: { displayName: 'ci bot', role: 'operator' },
    });
    expect(actorRes.status).toBe(201);
    const actor = (await actorRes.json()) as { id: string; kind: string; role: string };
    expect(actor).toMatchObject({ kind: 'service', role: 'operator' });
    serviceId = actor.id;

    const keyRes = await call(`/api/v1/actors/${serviceId}/api-keys`, {
      method: 'POST',
      jar: admin.jar,
      body: { name: 'pipeline' },
    });
    expect(keyRes.status).toBe(201);
    const issued = (await keyRes.json()) as { id: string; key: string; prefix: string };
    expect(issued.key).toMatch(/^gm_[0-9A-Za-z]{8}_[0-9A-Za-z]{32}$/);
    key = issued.key;
    keyId = issued.id;
    // Never readable again: the stored form is a hash, and RPC denies the field.
    const listed = await call('/api/model/apiKey/findMany', { jar: admin.jar });
    const text = await listed.text();
    expect(text).not.toContain(key);
    expect(text).toContain(issued.prefix);
    expect(text).not.toMatch(/"hash":"[0-9a-f]{64}"/);
    const audit = await t.db.privileged.auditEvent.findMany({
      where: { action: { in: ['actor.create', 'api_key.issue'] } },
    });
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audit)).not.toContain(key);
  });

  it('[AUTH-040] the key acts as the service Actor on /api/v1 and /api/model, with its role', async () => {
    const me = await call('/api/v1/me', { key });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: serviceId, kind: 'service', role: 'operator' });
    const created = await call('/api/model/wave/create', {
      method: 'POST',
      key,
      body: { data: { name: 'rpc-key-wave' } },
    });
    expect(created.status).toBe(201);
    const wave = ((await created.json()) as { data: { id: string } }).data;
    const event = await t.db.privileged.auditEvent.findFirst({ where: { subjectId: wave.id } });
    expect(event?.actorId).toBe(serviceId);
    // An operator key cannot reach admin endpoints.
    await expectProblem(
      await call('/api/v1/actors', {
        method: 'POST',
        key,
        body: { displayName: 'x', role: 'viewer' },
      }),
      403,
      'forbidden',
    );
    expect(
      (await call('/api/model/overlay/create', { method: 'POST', key, body: { data: {} } })).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it('[AUTH-040] an invalid key is 401 even with a valid session cookie, and keys are not accepted on /api/auth', async () => {
    const wrong = `${key.slice(0, -1)}${key.endsWith('a') ? 'b' : 'a'}`;
    await expectProblem(
      await call('/api/v1/me', { key: wrong, jar: admin.jar }),
      401,
      'unauthenticated',
    );
    await expectProblem(
      await call('/api/v1/me', { headers: { authorization: 'Basic abc' } }),
      401,
      'unauthenticated',
    );
    const session = await call('/api/auth/get-session', { key });
    expect(await session.text()).toMatch(/^(null)?$/);
  });

  it('[AUTH-040] a session-less key request needs no Origin header (keys are not browser credentials)', async () => {
    const res = await call('/api/model/wave/create', {
      method: 'POST',
      key,
      body: { data: { name: 'rpc-key-wave-2' } },
    });
    expect(res.status).toBe(201);
  });

  it('[AUTH-040] a revoked key and an expired key return 401', async () => {
    const short = await call(`/api/v1/actors/${serviceId}/api-keys`, {
      method: 'POST',
      jar: admin.jar,
      body: { name: 'short', expiresAt: new Date(Date.now() + 700).toISOString() },
    });
    const shortKey = ((await short.json()) as { key: string }).key;
    expect((await call('/api/v1/me', { key: shortKey })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 900));
    await expectProblem(await call('/api/v1/me', { key: shortKey }), 401, 'unauthenticated');

    const revoke = await call(`/api/v1/api-keys/${keyId}`, { method: 'DELETE', jar: admin.jar });
    expect(revoke.status).toBe(204);
    await expectProblem(await call('/api/v1/me', { key }), 401, 'unauthenticated');
    await expectProblem(
      await call('/api/v1/api-keys/00000000-0000-7000-8000-000000000000', {
        method: 'DELETE',
        jar: admin.jar,
      }),
      404,
      'not_found',
    );
  });

  it('[AUTH-040] human Actors cannot have keys, and unknown Actors are 404', async () => {
    const human = await t.db.privileged.actor.findFirst({ where: { email: admin.email } });
    await expectProblem(
      await call(`/api/v1/actors/${human?.id}/api-keys`, {
        method: 'POST',
        jar: admin.jar,
        body: { name: 'x' },
      }),
      409,
      'conflict',
    );
    await expectProblem(
      await call('/api/v1/actors/00000000-0000-7000-8000-000000000000/api-keys', {
        method: 'POST',
        jar: admin.jar,
        body: { name: 'x' },
      }),
      404,
      'not_found',
    );
  });

  it('[AUTH-040] disabling a service Actor stops its keys at once', async () => {
    const created = await call('/api/v1/actors', {
      method: 'POST',
      jar: admin.jar,
      body: { displayName: 'temp bot', role: 'viewer' },
    });
    const actor = (await created.json()) as { id: string };
    const issued = await call(`/api/v1/actors/${actor.id}/api-keys`, {
      method: 'POST',
      jar: admin.jar,
      body: { name: 'k' },
    });
    const tempKey = ((await issued.json()) as { key: string }).key;
    expect((await call('/api/v1/me', { key: tempKey })).status).toBe(200);
    const patched = await call(`/api/v1/actors/${actor.id}`, {
      method: 'PATCH',
      jar: admin.jar,
      body: { disabled: true, role: 'operator' },
    });
    expect(patched.status).toBe(200);
    await expectProblem(await call('/api/v1/me', { key: tempKey }), 401, 'unauthenticated');
  });
});

describe('[API-020] Actor administration rules', () => {
  it('[API-020] [AUTH-020] only admins administer Actors', async () => {
    const op = await signIn('operator');
    await expectProblem(
      await call('/api/v1/actors', {
        method: 'POST',
        jar: op.jar,
        body: { displayName: 'x', role: 'viewer' },
      }),
      403,
      'forbidden',
    );
    await expectProblem(
      await call('/api/v1/api-keys/anything', { method: 'DELETE', jar: op.jar }),
      403,
      'forbidden',
    );
  });

  it('[API-020] [AUTH-005] disabling a human Actor revokes its sessions; its role is not editable; self-disable is refused', async () => {
    const admin = await signIn('admin');
    const victim = await signIn('operator');
    const victimActor = await t.db.privileged.actor.findFirstOrThrow({
      where: { email: victim.email },
    });
    const adminActor = await t.db.privileged.actor.findFirstOrThrow({
      where: { email: admin.email },
    });
    const sessions = () =>
      t.db.pool.query('SELECT count(*)::int AS n FROM auth.session WHERE "userId" = $1', [
        victimActor.authUserId,
      ]);
    expect((await sessions()).rows[0].n).toBeGreaterThan(0);

    await expectProblem(
      await call(`/api/v1/actors/${victimActor.id}`, {
        method: 'PATCH',
        jar: admin.jar,
        body: { role: 'admin' },
      }),
      409,
      'conflict',
    );
    await expectProblem(
      await call(`/api/v1/actors/${adminActor.id}`, {
        method: 'PATCH',
        jar: admin.jar,
        body: { disabled: true },
      }),
      409,
      'conflict',
    );
    const res = await call(`/api/v1/actors/${victimActor.id}`, {
      method: 'PATCH',
      jar: admin.jar,
      body: { disabled: true },
    });
    expect(res.status).toBe(200);
    expect((await sessions()).rows[0].n).toBe(0);
    await expectProblem(await call('/api/v1/me', { jar: victim.jar }), 401, 'unauthenticated');
    await expectProblem(
      await call('/api/v1/actors/00000000-0000-7000-8000-000000000000', {
        method: 'PATCH',
        jar: admin.jar,
        body: { disabled: true },
      }),
      404,
      'not_found',
    );
    const audit = await t.db.privileged.auditEvent.findFirst({
      where: { action: 'actor.update', subjectId: victimActor.id },
    });
    expect(audit?.actorId).toBe(adminActor.id);
  });
});

describe('[API-011] problem+json, validation and limits', () => {
  it('[API-011] invalid input is a 422 problem listing the fields', async () => {
    const admin = await signIn('admin');
    const body = await expectProblem(
      await call('/api/v1/actors', {
        method: 'POST',
        jar: admin.jar,
        body: { displayName: '', role: 'root' },
      }),
      422,
      'validation_failed',
    );
    const errors = body.errors as { path: string; message: string }[];
    expect(errors.map((e) => e.path).sort()).toEqual(['displayName', 'role']);
  });

  it('[API-011] a body over the limit is a 413 problem', async () => {
    const admin = await signIn('admin');
    const big = JSON.stringify({
      displayName: 'x'.repeat(MAX_API_BODY_BYTES + 10),
      role: 'viewer',
    });
    const res = await call('/api/v1/actors', {
      method: 'POST',
      jar: admin.jar,
      body: big,
      headers: { 'content-length': String(big.length) },
    });
    await expectProblem(res, 413, 'payload_too_large');
  });

  it('[API-011] an unexpected error is a generic 500 problem without details', async () => {
    const boom = createApiApp({
      events: inertEvents(),
      db: {
        ...t.db,
        privileged: new Proxy(t.db.privileged, {
          get: () => () => {
            throw new Error('secret-detail');
          },
        }) as never,
      },
      auth: service,
      publicUrl: ORIGIN,
    });
    const res = await boom.request(`${ORIGIN}/api/v1/me`, {
      headers: { authorization: 'Bearer gm_abcdefgh_abcdefghijklmnopqrstuvwxyzABCDEF' },
    });
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
    expect(await res.text()).not.toContain('secret-detail');
  });
});

describe('[API-001] OpenAPI document and typed client', () => {
  it('[API-001] [API-010] /api/v1/openapi.json is an OpenAPI 3.1 document with the endpoints and security schemes', async () => {
    const who = await signIn('viewer');
    const res = await call('/api/v1/openapi.json', { jar: who.jar });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      servers: { url: string }[];
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
      components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers[0]?.url).toBe('/api/v1');
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/actors',
      '/actors/{id}',
      '/actors/{id}/api-keys',
      '/api-keys/{id}',
      '/capability-matrix',
      '/dashboard',
      '/events',
      '/inventory/refresh',
      '/me',
      '/migrations/{id}/analyze',
      '/migrations/{id}/diff',
      '/overlays',
      '/overlays/{id}',
      '/quota',
      '/routes',
      '/routes/{id}/group-mappings',
      '/routes/{id}/group-mappings/{mappingId}/{action}',
      '/routes/{id}/identity-mappings',
      '/routes/{id}/identity-mappings/import',
      '/routes/{id}/identity-mappings/{mappingId}/{action}',
      '/routes/{id}/naming/preview',
      '/routes/{id}/target-identities',
    ]);
    expect(Object.keys(doc.components.securitySchemes)).toEqual(['bearerAuth', 'sessionCookie']);
    expect(doc.components.schemas.Problem).toBeDefined();
    expect(doc.paths['/me']?.get?.responses['401']).toBeDefined();
  });

  it('[API-003] the Hono typed client calls the custom endpoints', async () => {
    const who = await signIn('viewer');
    const client = createApiClient(ORIGIN, {
      fetch: (input: Request | string | URL, init?: RequestInit) =>
        app.request(input instanceof Request ? input : String(input), init),
      headers: { cookie: who.jar.header() },
    });
    const res = await client.api.v1.me.$get();
    expect(res.status).toBe(200);
    if (res.status === 200) {
      expect((await res.json()).email).toBe(who.email);
    }
  });
});
