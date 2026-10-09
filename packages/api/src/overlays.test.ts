import { type AuthService, issueApiKey } from '@git-migrator/auth';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { createBuiltinRegistry } from '@git-migrator/registry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from './app.ts';
import { createEventHub } from './events.ts';
import { PROBLEM_BASE, PROBLEM_CONTENT_TYPE } from './problem.ts';
import type { ApiServices } from './services.ts';

const ORIGIN = 'http://localhost:3000';
const ROLES = ['viewer', 'operator', 'admin'] as const;
type Role = (typeof ROLES)[number];

let t: TestDatabase;
let app: ReturnType<typeof createApiApp>;
let bare: ReturnType<typeof createApiApp>;
const keys = {} as Record<Role, string>;
const actorIds = {} as Record<Role, string>;

const services = { registry: createBuiltinRegistry() } as unknown as ApiServices;

beforeAll(async () => {
  t = await createTestDatabase('gm_t091_');
  const db = t.db.privileged;
  await db.endpoint.create({
    data: {
      id: 'src',
      providerType: 'bitbucket-cloud',
      displayName: 'src',
      baseUrl: 'http://src.test',
      status: 'active',
      configHash: 'h',
    },
  });
  await db.endpoint.create({
    data: {
      id: 'dst',
      providerType: 'github',
      displayName: 'dst',
      baseUrl: 'http://dst.test',
      status: 'active',
      configHash: 'h',
    },
  });
  await db.route.create({
    data: {
      id: 'route-1',
      sourceEndpointId: 'src',
      targetEndpointId: 'dst',
      targetNamespacePath: 'acme',
      policies: {},
      defaults: {},
      configHash: 'h',
      sourcePostAction: 'read-only',
    },
  });
  const hub = createEventHub({
    listener: { start: () => undefined, subscribe: () => () => undefined, connected: false },
  });
  app = createApiApp({
    db: t.db,
    auth: {} as AuthService,
    publicUrl: ORIGIN,
    events: hub,
    services,
  });
  bare = createApiApp({ db: t.db, auth: {} as AuthService, publicUrl: ORIGIN, events: hub });
  for (const role of ROLES) {
    const actor = await db.actor.create({
      data: { kind: 'service', displayName: `svc ${role}`, role },
    });
    const issued = await issueApiKey(db, { actorId: actor.id, name: 'k', issuedBy: actor.id });
    keys[role] = issued.key;
    actorIds[role] = actor.id;
  }
}, 120_000);

afterAll(async () => {
  await t?.drop();
});

const call = (
  path: string,
  init: { method?: string; role?: Role; body?: unknown; raw?: string; target?: typeof app } = {},
) => {
  const headers: Record<string, string> = {};
  if (init.role) headers.authorization = `Bearer ${keys[init.role]}`;
  const body = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  if (body !== undefined) headers['content-type'] = 'application/json';
  return (init.target ?? app).request(`${ORIGIN}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(body === undefined ? {} : { body }),
  });
};

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
  const body = (await res.json()) as {
    type: string;
    errors?: { path: string; message: string }[];
  };
  expect(body.type).toBe(`${PROBLEM_BASE}${code}`);
  return body;
}

const create = (data: unknown, extra: Record<string, unknown> = {}) =>
  call('/overlays', {
    method: 'POST',
    role: 'admin',
    body: { routeId: 'route-1', facetKey: 'webhooks', data, ...extra },
  });

describe('[API-021] [AUTH-021] the overlay endpoints enforce manageRules', () => {
  const cases = [
    { name: 'POST /overlays', method: 'POST', path: '/overlays' },
    { name: 'PATCH /overlays/{id}', method: 'PATCH', path: '/overlays/missing' },
    { name: 'DELETE /overlays/{id}', method: 'DELETE', path: '/overlays/missing' },
  ];
  for (const endpoint of cases) {
    const body =
      endpoint.method === 'DELETE'
        ? undefined
        : { routeId: 'route-1', facetKey: 'webhooks', data: {}, enabled: true };
    it(`[API-021] ${endpoint.name} answers 401 without a credential and 403 below admin`, async () => {
      await expectProblem(
        await call(endpoint.path, { method: endpoint.method, body }),
        401,
        'unauthenticated',
      );
      for (const role of ['viewer', 'operator'] as const) {
        await expectProblem(
          await call(endpoint.path, { method: endpoint.method, role, body }),
          403,
          'forbidden',
        );
      }
    });
  }

  it('[API-021] a missing registry service answers 503 not_ready', async () => {
    await expectProblem(
      await call('/overlays', {
        method: 'POST',
        role: 'admin',
        target: bare,
        body: { routeId: 'route-1', facetKey: 'webhooks', data: {} },
      }),
      503,
      'not_ready',
    );
  });
});

describe('[DOM-001] [DOM-003] [UI-032] overlay writes are validated against the Facet schema', () => {
  it('[UI-032] accepts a valid partial document, stores it as given and audits the write', async () => {
    const data = { hooks: [{ active: false }] };
    const res = await create(data);
    expect(res.status).toBe(201);
    const view = (await res.json()) as { id: string; data: unknown; enabled: boolean };
    expect(view.data).toEqual(data);
    expect(view.enabled).toBe(true);
    const stored = await t.db.privileged.overlay.findUniqueOrThrow({ where: { id: view.id } });
    expect(stored.data).toEqual(data);
    const event = await t.db.privileged.auditEvent.findFirst({
      where: { subjectId: view.id, action: 'overlay.create' },
    });
    expect(event?.actorId).toBe(actorIds.admin);
    expect(JSON.stringify(event?.data)).not.toContain('active');
  });

  it('[DOM-001] refuses a document that is not valid for the Facet with 422 and paths', async () => {
    const before = await t.db.privileged.overlay.count();
    const wrongType = await expectProblem(
      await create({ hooks: [{ active: 'yes' }] }),
      422,
      'validation_failed',
    );
    expect(wrongType.errors?.[0]?.path).toBe('data.hooks.0.active');
    const unknownKey = await expectProblem(await create({ nope: 1 }), 422, 'validation_failed');
    expect(unknownKey.errors?.[0]?.message).toMatch(/nope/);
    await expectProblem(await create([]), 422, 'validation_failed');
    await expectProblem(await create('text'), 422, 'validation_failed');
    expect(await t.db.privileged.overlay.count()).toBe(before);
  });

  it('[DOM-003] refuses __proto__, constructor and prototype keys at any depth', async () => {
    const before = await t.db.privileged.overlay.count();
    for (const raw of [
      '{"__proto__":{"polluted":true}}',
      '{"hooks":[{"constructor":{"x":1}}]}',
      '{"hooks":[{"active":true,"prototype":1}]}',
    ]) {
      const body = `{"routeId":"route-1","facetKey":"webhooks","data":${raw}}`;
      const problem = await expectProblem(
        await call('/overlays', { method: 'POST', role: 'admin', raw: body }),
        422,
        'validation_failed',
      );
      expect(problem.errors?.[0]?.message).toMatch(/not allowed/);
    }
    expect(await t.db.privileged.overlay.count()).toBe(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('[DOM-003] refuses a document over 64 KB', async () => {
    const problem = await expectProblem(
      await create({ hooks: [{ url: `https://h.test/${'a'.repeat(70_000)}` }] }),
      422,
      'validation_failed',
    );
    expect(problem.errors?.[0]?.message).toMatch(/larger than/);
  });

  it('[DOM-001] refuses an unknown Facet and an unknown Route', async () => {
    const facet = await expectProblem(
      await call('/overlays', {
        method: 'POST',
        role: 'admin',
        body: { routeId: 'route-1', facetKey: 'nope', data: {} },
      }),
      422,
      'validation_failed',
    );
    expect(facet.errors?.[0]?.path).toBe('facetKey');
    const route = await expectProblem(
      await call('/overlays', {
        method: 'POST',
        role: 'admin',
        body: { routeId: 'nope', facetKey: 'webhooks', data: {} },
      }),
      422,
      'validation_failed',
    );
    expect(route.errors?.[0]?.path).toBe('routeId');
  });

  it('[UI-032] updates the document and the flag, validates the update, and audits it', async () => {
    const made = (await (await create({})).json()) as { id: string };
    const patched = await call(`/overlays/${made.id}`, {
      method: 'PATCH',
      role: 'admin',
      body: { data: { hooks: [{ active: true }] }, enabled: false },
    });
    expect(patched.status).toBe(200);
    const view = (await patched.json()) as { data: unknown; enabled: boolean };
    expect(view).toMatchObject({ data: { hooks: [{ active: true }] }, enabled: false });

    const bad = await expectProblem(
      await call(`/overlays/${made.id}`, {
        method: 'PATCH',
        role: 'admin',
        body: { data: { hooks: [{ zzz: 1 }] } },
      }),
      422,
      'validation_failed',
    );
    expect(bad.errors?.length).toBeGreaterThan(0);
    const stored = await t.db.privileged.overlay.findUniqueOrThrow({ where: { id: made.id } });
    expect(stored.data).toEqual({ hooks: [{ active: true }] });

    await expectProblem(
      await call(`/overlays/${made.id}`, { method: 'PATCH', role: 'admin', body: {} }),
      422,
      'validation_failed',
    );
    await expectProblem(
      await call('/overlays/missing', { method: 'PATCH', role: 'admin', body: { enabled: true } }),
      404,
      'not_found',
    );
    const event = await t.db.privileged.auditEvent.findFirst({
      where: { subjectId: made.id, action: 'overlay.update' },
    });
    expect(event?.actorId).toBe(actorIds.admin);
  });

  it('[UI-032] deletes an Overlay and answers 404 for one that is gone', async () => {
    const made = (await (await create({})).json()) as { id: string };
    const res = await call(`/overlays/${made.id}`, { method: 'DELETE', role: 'admin' });
    expect(res.status).toBe(204);
    expect(await t.db.privileged.overlay.findUnique({ where: { id: made.id } })).toBeNull();
    const event = await t.db.privileged.auditEvent.findFirst({
      where: { subjectId: made.id, action: 'overlay.delete' },
    });
    expect(event?.actorId).toBe(actorIds.admin);
    await expectProblem(
      await call(`/overlays/${made.id}`, { method: 'DELETE', role: 'admin' }),
      404,
      'not_found',
    );
  });

  it('[DOM-003] the RPC mount no longer writes Overlays, even for an admin', async () => {
    const res = await app.request(`${ORIGIN}/api/model/overlay/create`, {
      method: 'POST',
      headers: { authorization: `Bearer ${keys.admin}`, 'content-type': 'application/json' },
      body: JSON.stringify({ data: { routeId: 'route-1', facetKey: 'webhooks', data: { x: 1 } } }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const rows = await t.db.privileged.overlay.findMany({ where: { facetKey: 'webhooks' } });
    expect(JSON.stringify(rows)).not.toContain('"x":1');
  });
});
