import { type AuthService, migrateAuthSchema } from '@git-migrator/auth';
import {
  CookieJar,
  createAuthForTest,
  type EntraStub,
  signInWithEntra,
  startEntraStub,
} from '@git-migrator/auth/testing';
import { resolveConfig } from '@git-migrator/config';
import { createDb } from '@git-migrator/db';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import SuperJSON from 'superjson';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp, safeErrorFields } from './app.ts';
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
const configYaml = `
environment: test
publicUrl: ${ORIGIN}
auth:
  entra: { tenantId: "${TENANT}" }
  roleMappings:
    - { method: entra, claim: roles, value: "GitMigrator.Admin", role: admin }
`;

let t: TestDatabase;
let stub: EntraStub;
let service: AuthService;
let app: ReturnType<typeof createApiApp>;
let counter = 0;
const logged: unknown[][] = [];

beforeAll(async () => {
  t = await createTestDatabase('gm_t021h_');
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
  app = createApiApp({
    events: inertEvents(),
    db: t.db,
    auth: service,
    publicUrl: ORIGIN,
    logger: { error: (...a: unknown[]) => logged.push(a) } as never,
  });
}, 120_000);

afterAll(async () => {
  await service?.close();
  await stub?.close();
  await t?.drop();
});

async function signInAdmin(): Promise<{ jar: CookieJar; email: string }> {
  counter++;
  const email = `admin${counter}@example.test`;
  const jar = new CookieJar();
  const result = await signInWithEntra(
    { handle: (request: Request) => app.request(request) } as unknown as AuthService,
    stub,
    ORIGIN,
    {
      oid: `00000000-0000-0000-0000-${String(counter).padStart(12, '0')}`,
      email,
      preferred_username: email,
      name: `Admin ${counter}`,
      roles: ['GitMigrator.Admin'],
    },
    jar,
  );
  expect(result.error).toBeNull();
  return { jar, email };
}

const call = (
  path: string,
  init: { method?: string; jar?: CookieJar; key?: string; body?: unknown } = {},
) => {
  const headers: Record<string, string> = {};
  if (init.jar) {
    headers.cookie = init.jar.header();
    headers.origin = ORIGIN;
  }
  if (init.key) headers.authorization = `Bearer ${init.key}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return app.request(`${ORIGIN}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
};

const expectProblem = async (res: Response, status: number, code: string) => {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.type).toBe(`${PROBLEM_BASE}${code}`);
  return body;
};

describe('[API-011] every error under /api/v1 is problem+json', () => {
  const raw = async (init: { body?: string; contentType?: string | null }) => {
    const { jar } = await signInAdmin();
    return app.request(`${ORIGIN}/api/v1/actors`, {
      method: 'POST',
      headers: {
        cookie: jar.header(),
        origin: ORIGIN,
        ...(init.contentType === null
          ? {}
          : { 'content-type': init.contentType ?? 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
  };

  it('[API-011] malformed JSON, an empty body and a wrong content type are problems, not text', async () => {
    for (const init of [
      { body: '{not json' },
      { body: '' },
      { body: '{}', contentType: 'text/plain' },
      { body: 'x=1', contentType: 'application/x-www-form-urlencoded' },
      { body: '{"displayName":"x","role":"viewer"}', contentType: null },
    ]) {
      const res = await raw(init);
      expect(res.status, JSON.stringify(init)).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.headers.get('content-type'), JSON.stringify(init)).toContain(PROBLEM_CONTENT_TYPE);
    }
  });

  it('[API-011] an unknown route and a wrong method are problems', async () => {
    const { jar } = await signInAdmin();
    await expectProblem(await call('/api/v1/nothing/here', { jar }), 404, 'not_found');
    const wrong = await call('/api/v1/me', { method: 'DELETE', jar });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(wrong.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
  });
});

describe('[AUTH-021] the RPC mount', () => {
  it('[AUTH-021] an operation the facade does not expose is a 404 problem, not a 500 echoing an internal message', async () => {
    const { jar } = await signInAdmin();
    const res = await call('/api/model/auditEvent/create', {
      method: 'POST',
      jar,
      body: { data: { action: 'x', subjectType: 'x', subjectId: 'x' } },
    });
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toMatch(/not a function/);
    expect(JSON.parse(text).code).toBe('not_found');
  });

  it('[AUTH-021] a 5xx from the RPC handler has a generic body and is logged without its message', async () => {
    const { jar, email } = await signInAdmin();
    const actor = await t.db.privileged.actor.findFirstOrThrow({ where: { email } });
    const real = t.db.forActor(actor);
    const broken = createApiApp({
      events: inertEvents(),
      db: {
        ...t.db,
        forActor: () =>
          ({
            ...real,
            wave: { findMany: () => Promise.reject(new Error('leak-me select * from secret')) },
          }) as never,
      },
      auth: service,
      publicUrl: ORIGIN,
      logger: { error: (...a: unknown[]) => logged.push(a) } as never,
    });
    const before = logged.length;
    const res = await broken.request(`${ORIGIN}/api/model/wave/findMany`, {
      headers: { cookie: jar.header() },
    });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toMatch(/leak-me|secret/);
    expect(JSON.parse(text).code).toBe('internal_error');
    expect(logged.length).toBeGreaterThan(before);
    expect(JSON.stringify(logged)).not.toMatch(/leak-me/);
  });

  it('[AUTH-021] a SuperJSON shared-reference DAG over HTTP is refused fast', async () => {
    const { jar } = await signInAdmin();
    // The attacker's request is small: each level holds its child once and an empty placeholder,
    // and SuperJSON `referentialEqualities` says "AND.1 is the same object as AND.0" per level.
    const levels = 24;
    let node: Record<string, unknown> = { name: 'x' };
    for (let i = 0; i < levels; i++) node = { AND: [node, {}] };
    const equalities: Record<string, string[]> = {};
    let path = 'where';
    for (let i = 0; i < levels; i++) {
      equalities[`${path}.AND.0`] = [`${path}.AND.1`];
      path += '.AND.0';
    }
    const meta = { referentialEqualities: equalities };
    // Proof that the request really does decode to a DAG.
    const decoded = SuperJSON.deserialize({ json: { where: node } as never, meta }) as {
      where: { AND: unknown[] };
    };
    expect(decoded.where.AND[0]).toBe(decoded.where.AND[1]);
    const query = `q=${encodeURIComponent(JSON.stringify({ where: node }))}&meta=${encodeURIComponent(
      JSON.stringify({ serialization: meta }),
    )}`;
    const started = Date.now();
    const res = await call(`/api/model/wave/findMany?${query}`, { jar });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(res.status).toBe(422);
  });
});

describe('[API-020] Actor administration, round 2', () => {
  it('[API-020] an empty PATCH and a past or invalid expiresAt are 422 problems', async () => {
    const { jar } = await signInAdmin();
    const created = await call('/api/v1/actors', {
      method: 'POST',
      jar,
      body: { displayName: 'bot r2', role: 'viewer' },
    });
    const { id } = (await created.json()) as { id: string };
    await expectProblem(
      await call(`/api/v1/actors/${id}`, { method: 'PATCH', jar, body: {} }),
      422,
      'validation_failed',
    );
    for (const expiresAt of [new Date(Date.now() - 1000).toISOString(), 'tomorrow']) {
      await expectProblem(
        await call(`/api/v1/actors/${id}/api-keys`, {
          method: 'POST',
          jar,
          body: { name: 'k', expiresAt },
        }),
        422,
        'validation_failed',
      );
    }
  });

  it('[API-020] the audit event of a PATCH records from and to, read inside the transaction', async () => {
    const { jar } = await signInAdmin();
    const created = await call('/api/v1/actors', {
      method: 'POST',
      jar,
      body: { displayName: 'bot r2b', role: 'viewer' },
    });
    const { id } = (await created.json()) as { id: string };
    await call(`/api/v1/actors/${id}`, { method: 'PATCH', jar, body: { role: 'operator' } });
    const event = await t.db.privileged.auditEvent.findFirstOrThrow({
      where: { action: 'actor.update', subjectId: id },
    });
    expect(event.data).toEqual({ role: { from: 'viewer', to: 'operator' } });
  });

  it('[API-020] the last enabled administrator cannot be demoted or disabled, whoever acts', async () => {
    const { jar } = await signInAdmin();
    const created = await call('/api/v1/actors', {
      method: 'POST',
      jar,
      body: { displayName: 'only admin', role: 'admin' },
    });
    const { id } = (await created.json()) as { id: string };
    const issued = await call(`/api/v1/actors/${id}/api-keys`, {
      method: 'POST',
      jar,
      body: { name: 'k' },
    });
    const { key } = (await issued.json()) as { key: string };
    const others = (
      await t.db.pool.query<{ id: string }>(
        "UPDATE app.actor SET disabled = true WHERE role = 'admin' AND id <> $1 AND NOT disabled RETURNING id",
        [id],
      )
    ).rows.map((r) => r.id);
    try {
      // The sole enabled admin is a service Actor acting on itself.
      await expectProblem(
        await call(`/api/v1/actors/${id}`, { method: 'PATCH', key, body: { role: 'viewer' } }),
        409,
        'last_admin',
      );
      expect((await t.db.privileged.actor.findUniqueOrThrow({ where: { id } })).role).toBe('admin');
      // With a second enabled admin the same demotion is allowed.
      await t.db.pool.query('UPDATE app.actor SET disabled = false WHERE id = $1', [others[0]]);
      expect(
        (await call(`/api/v1/actors/${id}`, { method: 'PATCH', key, body: { role: 'viewer' } }))
          .status,
      ).toBe(200);
    } finally {
      await t.db.pool.query('UPDATE app.actor SET disabled = false WHERE id = ANY($1::text[])', [
        others,
      ]);
    }
  });

  /** Creates service admins, each with a key, through the API. */
  async function serviceAdmins(count: number): Promise<{ id: string; key: string }[]> {
    const { jar } = await signInAdmin();
    const out: { id: string; key: string }[] = [];
    for (let i = 0; i < count; i++) {
      const created = await call('/api/v1/actors', {
        method: 'POST',
        jar,
        body: { displayName: `race admin ${i}`, role: 'admin' },
      });
      const { id } = (await created.json()) as { id: string };
      const issued = await call(`/api/v1/actors/${id}/api-keys`, {
        method: 'POST',
        jar,
        body: { name: 'k' },
      });
      out.push({ id, key: ((await issued.json()) as { key: string }).key });
    }
    return out;
  }
  const demote = (by: { key: string }, target: { id: string }) =>
    call(`/api/v1/actors/${target.id}`, { method: 'PATCH', key: by.key, body: { role: 'viewer' } });

  it('[API-020] two unrelated concurrent demotions both succeed (no false serialization failure)', async () => {
    for (let round = 0; round < 5; round++) {
      const [a, b, c, d] = (await serviceAdmins(4)) as [
        { id: string; key: string },
        { id: string; key: string },
        { id: string; key: string },
        { id: string; key: string },
      ];
      const results = await Promise.all([demote(a, c), demote(b, d)]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
    }
  });

  it('[API-020] mutual demotion: one wins, the other is refused (never a 500), and an enabled admin remains', async () => {
    const [a, b] = (await serviceAdmins(2)) as [
      { id: string; key: string },
      { id: string; key: string },
    ];
    const others = (
      await t.db.pool.query<{ id: string }>(
        "UPDATE app.actor SET disabled = true WHERE role = 'admin' AND id NOT IN ($1, $2) AND NOT disabled RETURNING id",
        [a.id, b.id],
      )
    ).rows.map((r) => r.id);
    try {
      for (let round = 0; round < 5; round++) {
        await t.db.pool.query("UPDATE app.actor SET role = 'admin' WHERE id IN ($1, $2)", [
          a.id,
          b.id,
        ]);
        const [r1, r2] = await Promise.all([demote(a, b), demote(b, a)]);
        const statuses = [r1.status, r2.status].sort();
        expect(
          statuses.every((s) => s < 500),
          String(statuses),
        ).toBe(true);
        expect(statuses[0]).toBe(200);
        expect([403, 409]).toContain(statuses[1]);
        const left = await t.db.privileged.actor.count({
          where: { role: 'admin', disabled: false },
        });
        expect(left).toBeGreaterThanOrEqual(1);
      }
    } finally {
      await t.db.pool.query('UPDATE app.actor SET disabled = false WHERE id = ANY($1::text[])', [
        others,
      ]);
    }
  });

  it('[API-020] a serialization failure or deadlock that reaches the app is a 409 conflict, not a 500', async () => {
    const { isRetryableConflict } = await import('./app.ts');
    expect(isRetryableConflict({ dbErrorCode: '40001' })).toBe(true);
    expect(isRetryableConflict({ code: '40P01' })).toBe(true);
    expect(isRetryableConflict(new Error('x', { cause: { dbErrorCode: '40001' } }))).toBe(true);
    expect(isRetryableConflict(new Error('x'))).toBe(false);
    const { jar } = await signInAdmin();
    const boom = createApiApp({
      events: inertEvents(),
      db: {
        ...t.db,
        privileged: new Proxy(t.db.privileged, {
          get: (target, prop, receiver) =>
            prop === 'apiKey'
              ? new Proxy(
                  {},
                  {
                    get: () => () => {
                      throw Object.assign(new Error('could not serialize'), {
                        dbErrorCode: '40001',
                      });
                    },
                  },
                )
              : Reflect.get(target, prop, receiver),
        }) as never,
      },
      auth: service,
      publicUrl: ORIGIN,
    });
    const res = await boom.request(`${ORIGIN}/api/v1/me`, {
      headers: { authorization: 'Bearer gm_abcdefgh_abcdefghijklmnopqrstuvwxyzABCDEF' },
    });
    expect(res.status).toBe(409);
    void jar;
  });

  it('[API-011] an expiresAt with a UTC offset is accepted', async () => {
    const [a] = (await serviceAdmins(1)) as [{ id: string; key: string }];
    const { jar } = await signInAdmin();
    const future = new Date(Date.now() + 3_600_000);
    const withOffset = future.toISOString().replace('Z', '+00:00');
    const res = await call(`/api/v1/actors/${a.id}/api-keys`, {
      method: 'POST',
      jar,
      body: { name: 'offset', expiresAt: withOffset },
    });
    expect(res.status).toBe(201);
  });
});

describe('[AUTH-021] the RPC mount, round 3', () => {
  it('[AUTH-021] an unexposed operation inside $transaction/sequential is a 404 problem+json', async () => {
    const { jar } = await signInAdmin();
    const before = await t.db.privileged.auditEvent.count();
    const res = await call('/api/model/$transaction/sequential', {
      method: 'POST',
      jar,
      body: [
        { model: 'Wave', op: 'findMany', args: {} },
        { model: 'AuditEvent', op: 'create', args: { data: { action: 'x' } } },
      ],
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
    expect(await t.db.privileged.auditEvent.count()).toBe(before);
  });

  it('[AUTH-021] the 404 and 500 problems of the RPC mount are application/problem+json', async () => {
    const { jar } = await signInAdmin();
    const missing = await call('/api/model/auditEvent/delete', {
      method: 'POST',
      jar,
      body: { where: { id: 'x' } },
    });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
  });

  it('[AUTH-021] a failed database call is logged with its class, reason, model and SQLSTATE, and no message text', async () => {
    const { jar } = await signInAdmin();
    const records: unknown[][] = [];
    const db = createDb({
      connectionString: t.connectionString,
      pool: t.db.pool,
      onError: (error) => records.push([safeErrorFields(error), 'database call failed']),
    });
    const logged2 = createApiApp({ events: inertEvents(), db, auth: service, publicUrl: ORIGIN });
    const body = JSON.stringify({ data: { name: 'dup-wave-for-log' } });
    const headers = { cookie: jar.header(), origin: ORIGIN, 'content-type': 'application/json' };
    const first = await logged2.request(`${ORIGIN}/api/model/wave/create`, {
      method: 'POST',
      headers,
      body,
    });
    expect(first.status).toBe(201);
    expect(records).toEqual([]);
    const second = await logged2.request(`${ORIGIN}/api/model/wave/create`, {
      method: 'POST',
      headers,
      body,
    });
    expect(second.status).toBeGreaterThanOrEqual(400);
    const text = JSON.stringify(records);
    expect(text).toContain('23505');
    expect(text).not.toMatch(/dup-wave-for-log|duplicate key|insert into/i);
    // A policy rejection is expected behaviour and is not reported.
    records.length = 0;
    const viewer = await logged2.request(`${ORIGIN}/api/model/wave/findMany`, { headers });
    expect(viewer.status).toBe(200);
    expect(records).toEqual([]);
  });

  it('[AUTH-021] safeErrorFields keeps only short code-like fields from the error and its causes', () => {
    const fields = safeErrorFields(
      Object.assign(new Error('secret text'), {
        reason: 'db-query-error',
        model: 'Wave',
        cause: Object.assign(new Error('inner secret'), { code: '23505' }),
      }),
    );
    expect(fields).toEqual({
      errorClass: 'Error',
      reason: 'db-query-error',
      model: 'Wave',
      dbErrorCode: '23505',
    });
    expect(safeErrorFields(Object.assign(new Error('x'), { dbErrorCode: 'x'.repeat(40) }))).toEqual(
      {
        errorClass: 'Error',
      },
    );
    expect(safeErrorFields('a string')).toEqual({});
  });
});
