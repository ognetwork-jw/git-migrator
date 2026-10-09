import { type AuthService, issueApiKey } from '@git-migrator/auth';
import { parsePathPattern } from '@git-migrator/core';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { createBuiltinRegistry } from '@git-migrator/registry';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiApp } from './app.ts';
import { createEventHub } from './events.ts';
import { PROBLEM_BASE, PROBLEM_CONTENT_TYPE } from './problem.ts';
import type { ApiServices } from './services.ts';

const ORIGIN = 'http://localhost:3000';
const ROLES = ['viewer', 'operator', 'admin'] as const;
type Role = (typeof ROLES)[number];

interface Enqueued {
  runId: string;
  routing: unknown;
}
const runJobs: Enqueued[] = [];
const parityJobs: string[] = [];
let failRunEnqueue = false;
let beforeFailedEnqueue: ((runId: string) => Promise<void>) | undefined;
let failParityEnqueue = false;

const services: ApiServices = {
  jobs: {
    enqueue: () => Promise.resolve({} as never),
    enqueueAnalysis: () => Promise.resolve({} as never),
    enqueueRun: async (runId: string, routing: unknown) => {
      if (failRunEnqueue) {
        await beforeFailedEnqueue?.(runId);
        throw new Error('queue down: secret-detail');
      }
      runJobs.push({ runId, routing });
      return Promise.resolve({} as never);
    },
    enqueueParity: (migrationId: string) => {
      if (failParityEnqueue) return Promise.reject(new Error('queue down: secret-detail'));
      parityJobs.push(migrationId);
      return Promise.resolve({} as never);
    },
    queue: () => ({}) as never,
  } as never,
  quota: { snapshot: () => Promise.resolve([]) },
  registry: createBuiltinRegistry(),
};

let t: TestDatabase;
let app: ReturnType<typeof createApiApp>;
const keys = {} as Record<Role, string>;
const actorIds = {} as Record<Role, string>;
let routeId = '';
let otherRouteId = '';
let counter = 0;
const faults: unknown[] = [];

async function keyFor(role: Role): Promise<{ key: string; actorId: string }> {
  const actor = await t.db.privileged.actor.create({
    data: { kind: 'service', displayName: `svc ${role}`, role },
  });
  const issued = await issueApiKey(t.db.privileged, {
    actorId: actor.id,
    name: 'k',
    issuedBy: actor.id,
  });
  return { key: issued.key, actorId: actor.id };
}

beforeAll(async () => {
  t = await createTestDatabase('gm_t074_');
  const db = t.db.privileged;
  for (const [id, providerType] of [
    ['src', 'bitbucket-cloud'],
    ['dst', 'github'],
  ] as const) {
    await db.endpoint.create({
      data: {
        id,
        providerType,
        displayName: id,
        baseUrl: `http://${id}.test`,
        status: 'active',
        configHash: 'h',
      },
    });
  }
  const mkRoute = async (id: string) =>
    (
      await db.route.create({
        data: {
          id,
          sourceEndpointId: 'src',
          targetEndpointId: 'dst',
          targetNamespacePath: 'acme',
          policies: {},
          defaults: {},
          configHash: 'h',
          sourcePostAction: 'read-only',
          avgCallsPerAnalysis: 20,
        },
      })
    ).id;
  routeId = await mkRoute('route-1');
  otherRouteId = await mkRoute('route-2');
  const hub = createEventHub({
    listener: { start: () => undefined, subscribe: () => () => undefined, connected: false },
  });
  app = createApiApp({
    db: t.db,
    auth: {} as AuthService,
    publicUrl: ORIGIN,
    events: hub,
    services,
    logger: {
      error: (fields: unknown, message: string) => {
        if (message === 'queue or database call failed') faults.push(fields);
        else console.error(message, fields);
      },
    } as never,
  });
  for (const role of ROLES) {
    const made = await keyFor(role);
    keys[role] = made.key;
    actorIds[role] = made.actorId;
  }
}, 120_000);

afterAll(async () => {
  await t?.drop();
});

beforeEach(() => {
  runJobs.length = 0;
  parityJobs.length = 0;
  failRunEnqueue = false;
  beforeFailedEnqueue = undefined;
  failParityEnqueue = false;
  faults.length = 0;
});

const call = (path: string, init: { method?: string; role?: Role; body?: unknown } = {}) => {
  const headers: Record<string, string> = {};
  if (init.role) headers.authorization = `Bearer ${keys[init.role]}`;
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.request(`${ORIGIN}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(body === undefined ? {} : { body }),
  });
};

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.type).toBe(`${PROBLEM_BASE}${code}`);
  return body;
}

/** A Migration of its own (a repository each, so the Route's uniqueness holds). */
async function mkMigration(extra: Record<string, unknown> = {}, route = routeId) {
  counter += 1;
  const db = t.db.privileged;
  const ns = await db.namespace.upsert({
    where: { endpointId_providerId: { endpointId: 'src', providerId: 'ns' } },
    update: {},
    create: {
      endpointId: 'src',
      providerId: 'ns',
      kind: 'project',
      slug: 'plat',
      key: 'PLAT',
      name: 'PLAT',
    },
  });
  const repo = await db.repository.create({
    data: {
      endpointId: 'src',
      namespaceId: ns.id,
      providerId: `r-${counter}`,
      slug: `repo-${counter}`,
      name: `repo-${counter}`,
      fullPath: `plat/repo-${counter}`,
      isPrivate: true,
      lastInventoriedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  return db.migration.create({
    data: {
      scope: 'repository',
      routeId: route,
      sourceRepositoryId: repo.id,
      plannedTargetName: `plat-repo-${counter}`,
      status: 'analyzed',
      readiness: 'ready',
      ...extra,
    },
  });
}

async function mkTask(
  migrationId: string,
  extra: Partial<{
    facetKey: string;
    code: string;
    phase: string;
    status: 'open' | 'done' | 'dismissed';
    params: unknown;
  }> = {},
) {
  counter += 1;
  return t.db.privileged.manualTask.create({
    data: {
      migrationId,
      facetKey: extra.facetKey ?? 'webhooks',
      code: extra.code ?? 'webhooks.recreate-manually',
      phase: extra.phase ?? 'pre',
      origin: 'analysis',
      params: (extra.params ?? { n: counter }) as never,
      verifiable: false,
      status: extra.status ?? 'open',
      paramsHash: `hash-${counter}`,
    },
  });
}

const audits = (action: string, subjectId: string) =>
  t.db.privileged.auditEvent.findMany({ where: { action, subjectId } });

describe('[API-021] [AUTH-021] the run, task and Expected Difference endpoints enforce roles', () => {
  const cases: {
    name: string;
    send: (role?: Role) => Promise<Response>;
  }[] = [];
  const fresh = async () => {
    const m = await mkMigration();
    const task = await mkTask(m.id);
    const ed = await t.db.privileged.expectedDifference.create({
      data: {
        routeId,
        migrationId: m.id,
        facetKey: 'webhooks',
        path: '/hooks',
        reason: 'manual_accepted',
        note: 'n',
      },
    });
    const drifted = await mkMigration({ status: 'drifted', statusBeforeDrift: 'verified' });
    return { m, task, ed, drifted };
  };
  const roleCases: [
    string,
    string,
    (f: Awaited<ReturnType<typeof fresh>>) => [string, unknown?],
  ][] = [
    [
      'POST /migrations/{id}/runs',
      'POST',
      (f) => [`/migrations/${f.m.id}/runs`, { kind: 'migrate' }],
    ],
    [
      'POST /migrations/{id}/complete',
      'POST',
      (f) => [`/migrations/${f.m.id}/complete`, { reason: 'x' }],
    ],
    [
      'POST /migrations/{id}/tasks/{taskId}/done',
      'POST',
      (f) => [`/migrations/${f.m.id}/tasks/${f.task.id}/done`],
    ],
    [
      'POST /migrations/{id}/expected-differences',
      'POST',
      (f) => [
        `/migrations/${f.m.id}/expected-differences`,
        { facetKey: 'webhooks', path: '/hooks[key=a]/url', note: 'ok' },
      ],
    ],
    ['DELETE /expected-differences/{id}', 'DELETE', (f) => [`/expected-differences/${f.ed.id}`]],
    [
      'POST /migrations/{id}/drift/accept',
      'POST',
      (f) => [`/migrations/${f.drifted.id}/drift/accept`, { note: 'on purpose' }],
    ],
  ];
  void cases;
  for (const [name, method, build] of roleCases) {
    it(`[API-021] ${name} answers 401 without a credential, 403 for a viewer, 2xx for an operator and an admin`, async () => {
      for (const role of [undefined, 'viewer', 'operator', 'admin'] as const) {
        const f = await fresh();
        const [path, body] = build(f);
        const res = await call(path, { method, ...(role ? { role } : {}), body });
        if (role === undefined) await expectProblem(res, 401, 'unauthenticated');
        else if (role === 'viewer') await expectProblem(res, 403, 'forbidden');
        else expect(res.status, `${name} as ${role}`).toBeLessThan(300);
      }
    });
  }

  it('[API-021] DELETE /migrations/{id}/complete and POST /runs/{id}/cancel enforce the operator role', async () => {
    const m = await mkMigration({ status: 'manually_completed', statusBeforeManual: 'analyzed' });
    await expectProblem(
      await call(`/migrations/${m.id}/complete`, { method: 'DELETE' }),
      401,
      'unauthenticated',
    );
    await expectProblem(
      await call(`/migrations/${m.id}/complete`, { method: 'DELETE', role: 'viewer' }),
      403,
      'forbidden',
    );
    expect(
      (await call(`/migrations/${m.id}/complete`, { method: 'DELETE', role: 'operator' })).status,
    ).toBe(200);

    for (const role of [undefined, 'viewer', 'operator', 'admin'] as const) {
      const target = await mkMigration();
      const started = await call(`/migrations/${target.id}/runs`, {
        method: 'POST',
        role: 'operator',
        body: { kind: 'migrate' },
      });
      const { runId } = (await started.json()) as { runId: string };
      const res = await call(`/runs/${runId}/cancel`, {
        method: 'POST',
        ...(role ? { role } : {}),
      });
      if (role === undefined) await expectProblem(res, 401, 'unauthenticated');
      else if (role === 'viewer') await expectProblem(res, 403, 'forbidden');
      else expect(res.status).toBe(200);
    }
  });
});

describe('POST /migrations/{id}/runs', () => {
  it('[LIF-005] [LIF-040] a ready Migration starts a migrate Run: queued, enqueued once, status running, audited', async () => {
    const m = await mkMigration();
    const res = await call(`/migrations/${m.id}/runs`, {
      method: 'POST',
      role: 'operator',
      body: { kind: 'migrate' },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string; status: string; kind: string };
    expect(body).toMatchObject({ migrationId: m.id, kind: 'migrate', status: 'queued' });
    expect(runJobs).toHaveLength(1);
    expect(runJobs[0]?.runId).toBe(body.runId);
    const run = await t.db.privileged.run.findUniqueOrThrow({ where: { id: body.runId } });
    expect(run).toMatchObject({
      status: 'queued',
      kind: 'migrate',
      triggeredById: actorIds.operator,
    });
    expect(
      (await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } })).status,
    ).toBe('running');
    expect(await audits('run.create', body.runId)).toHaveLength(1);
  });

  it('[LIF-005] migrate needs ready: needs_attention, blocked and never-analyzed Migrations answer 422', async () => {
    for (const readiness of ['needs_attention', 'blocked', null] as const) {
      const m = await mkMigration({ readiness });
      const body = await expectProblem(
        await call(`/migrations/${m.id}/runs`, {
          method: 'POST',
          role: 'operator',
          body: { kind: 'migrate' },
        }),
        422,
        'readiness_required',
      );
      expect(body.status).toBe(422);
      expect(
        (await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } })).status,
      ).toBe('analyzed');
    }
    expect(runJobs).toHaveLength(0);
  });

  it('[LIF-005] run_anyway needs ready or needs_attention; resync anything but blocked; verify is not gated', async () => {
    const attention = await mkMigration({ readiness: 'needs_attention' });
    const blocked = await mkMigration({ readiness: 'blocked' });
    const start = (id: string, kind: string) =>
      call(`/migrations/${id}/runs`, { method: 'POST', role: 'operator', body: { kind } });
    expect((await start(attention.id, 'run_anyway')).status).toBe(202);
    await expectProblem(await start(blocked.id, 'run_anyway'), 422, 'readiness_required');
    await expectProblem(await start(blocked.id, 'resync'), 422, 'readiness_required');
    expect((await start(blocked.id, 'verify')).status).toBe(202);
  });

  it('[DOM-010] a second Run while one is queued answers 409 run_active and creates nothing', async () => {
    const m = await mkMigration();
    const first = await call(`/migrations/${m.id}/runs`, {
      method: 'POST',
      role: 'operator',
      body: { kind: 'migrate' },
    });
    expect(first.status).toBe(202);
    await expectProblem(
      await call(`/migrations/${m.id}/runs`, {
        method: 'POST',
        role: 'admin',
        body: { kind: 'run_anyway' },
      }),
      409,
      'run_active',
    );
    expect(await t.db.privileged.run.count({ where: { migrationId: m.id } })).toBe(1);
    expect(runJobs).toHaveLength(1);
  });

  it('[LIF-043] adoptNonEmpty needs the exact target name as confirm; unknown options are 422', async () => {
    const m = await mkMigration();
    const send = (body: unknown) =>
      call(`/migrations/${m.id}/runs`, { method: 'POST', role: 'operator', body });
    await expectProblem(
      await send({ kind: 'migrate', options: { adoptNonEmpty: true } }),
      422,
      'confirmation_required',
    );
    await expectProblem(
      await send({ kind: 'migrate', options: { adoptNonEmpty: true }, confirm: 'acme/wrong' }),
      422,
      'confirmation_required',
    );
    await expectProblem(
      await send({ kind: 'migrate', options: { nope: true } }),
      422,
      'validation_failed',
    );
    await expectProblem(await send({ kind: 'bogus' }), 422, 'validation_failed');
    const ok = await send({
      kind: 'migrate',
      options: { adoptNonEmpty: true },
      confirm: `acme/${m.plannedTargetName}`,
    });
    expect(ok.status).toBe(202);
    const { runId } = (await ok.json()) as { runId: string };
    const stored = await t.db.privileged.run.findUniqueOrThrow({ where: { id: runId } });
    expect(stored.options).toEqual({ adoptNonEmpty: true });
    const audit = await audits('run.create', runId);
    expect(JSON.stringify(audit[0]?.data)).not.toContain('acme/');
  });

  it('[LIF-002] an unknown Migration is 404 and a source_missing one is a 409 conflict', async () => {
    await expectProblem(
      await call('/migrations/nope/runs', {
        method: 'POST',
        role: 'operator',
        body: { kind: 'migrate' },
      }),
      404,
      'not_found',
    );
    const missing = await mkMigration({
      status: 'source_missing',
      statusBeforeMissing: 'analyzed',
    });
    await expectProblem(
      await call(`/migrations/${missing.id}/runs`, {
        method: 'POST',
        role: 'operator',
        body: { kind: 'migrate' },
      }),
      409,
      'run_not_permitted',
    );
  });

  it('[JOB-010] a queue that is down answers 503, cancels the Run and gives the Migration its status back', async () => {
    const m = await mkMigration();
    failRunEnqueue = true;
    const res = await call(`/migrations/${m.id}/runs`, {
      method: 'POST',
      role: 'operator',
      body: { kind: 'migrate' },
    });
    const body = await expectProblem(res, 503, 'not_ready');
    expect(JSON.stringify(body)).not.toContain('secret-detail');
    const runs = await t.db.privileged.run.findMany({ where: { migrationId: m.id } });
    expect(runs.map((r) => r.status)).toEqual(['cancelled']);
    expect(
      (await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } })).status,
    ).toBe('analyzed');
    expect(faults).toHaveLength(1);
    const runId = runs[0]?.id as string;
    const create = await audits('run.create', runId);
    expect(create).toHaveLength(1);
    const cancel = await audits('run.cancel', runId);
    expect(cancel).toHaveLength(1);
    expect(cancel[0]?.data).toMatchObject({ outcome: 'cancelled', reason: 'enqueue_failed' });
  });

  it('[JOB-010] if a worker already started the Run when the enqueue failed, the Run is accepted, not a 503', async () => {
    const m = await mkMigration();
    failRunEnqueue = true;
    beforeFailedEnqueue = async (runId) => {
      await t.db.privileged.run.update({
        where: { id: runId },
        data: { status: 'running', startedAt: new Date(), leaseOwner: 'worker-token' },
      });
    };
    const res = await call(`/migrations/${m.id}/runs`, {
      method: 'POST',
      role: 'operator',
      body: { kind: 'migrate' },
    });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    expect((await t.db.privileged.run.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      'running',
    );
  });

  it('[LIF-077] a rollback needs the target full name typed: none, a wrong one and the right one', async () => {
    // A rollback needs a target or Mutations to undo (LIF-077): this one has a target.
    const ns = await t.db.privileged.namespace.upsert({
      where: { endpointId_providerId: { endpointId: 'dst', providerId: 'org' } },
      update: {},
      create: {
        endpointId: 'dst',
        providerId: 'org',
        kind: 'organization',
        slug: 'acme',
        key: 'acme',
        name: 'acme',
      },
    });
    counter += 1;
    const target = await t.db.privileged.repository.create({
      data: {
        endpointId: 'dst',
        namespaceId: ns.id,
        providerId: `t-${counter}`,
        slug: `plat-t-${counter}`,
        name: `plat-t-${counter}`,
        fullPath: `acme/plat-t-${counter}`,
        isPrivate: true,
        lastInventoriedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const m = await mkMigration({ status: 'migrated', targetRepositoryId: target.id });
    const send = (body: unknown) =>
      call(`/migrations/${m.id}/runs`, { method: 'POST', role: 'operator', body });
    await expectProblem(await send({ kind: 'rollback' }), 422, 'confirmation_required');
    await expectProblem(
      await send({ kind: 'rollback', confirm: 'acme/other' }),
      422,
      'confirmation_required',
    );
    expect(await t.db.privileged.run.count({ where: { migrationId: m.id } })).toBe(0);
    const ok = await send({
      kind: 'rollback',
      confirm: target.fullPath.toUpperCase(),
    });
    expect(ok.status).toBe(202);
  });
});

describe('POST /runs/{id}/cancel', () => {
  it('[LIF-040] cancels a queued Run at once; the Migration returns to its saved status', async () => {
    const m = await mkMigration();
    const started = await call(`/migrations/${m.id}/runs`, {
      method: 'POST',
      role: 'operator',
      body: { kind: 'migrate' },
    });
    const { runId } = (await started.json()) as { runId: string };
    const res = await call(`/runs/${runId}/cancel`, { method: 'POST', role: 'operator' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId, outcome: 'cancelled' });
    const run = await t.db.privileged.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('cancelled');
    expect(
      (await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } })).status,
    ).toBe('analyzed');
    expect(await audits('run.cancel', runId)).toHaveLength(1);
  });

  it('[LIF-040] a running Run only gets a cooperative request; the executor ends it', async () => {
    const m = await mkMigration();
    const started = await call(`/migrations/${m.id}/runs`, {
      method: 'POST',
      role: 'operator',
      body: { kind: 'migrate' },
    });
    const { runId } = (await started.json()) as { runId: string };
    await t.db.privileged.run.update({
      where: { id: runId },
      data: { status: 'running', startedAt: new Date(), leaseOwner: 'worker-token' },
    });
    const res = await call(`/runs/${runId}/cancel`, { method: 'POST', role: 'operator' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId, outcome: 'requested' });
    const run = await t.db.privileged.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('running');
    expect(run.cancelRequestedAt).not.toBeNull();
  });

  it('[LIF-040] a finished Run is a 409 and an unknown Run a 404', async () => {
    const m = await mkMigration();
    const started = await call(`/migrations/${m.id}/runs`, {
      method: 'POST',
      role: 'operator',
      body: { kind: 'migrate' },
    });
    const { runId } = (await started.json()) as { runId: string };
    await t.db.privileged.run.update({
      where: { id: runId },
      data: { status: 'succeeded', finishedAt: new Date() },
    });
    await expectProblem(
      await call(`/runs/${runId}/cancel`, { method: 'POST', role: 'operator' }),
      409,
      'conflict',
    );
    await expectProblem(
      await call('/runs/nope/cancel', { method: 'POST', role: 'operator' }),
      404,
      'not_found',
    );
  });
});

describe('POST|DELETE /migrations/{id}/complete', () => {
  it('[LIF-075] marks a Migration manually completed with a reason, an Actor and an AuditEvent', async () => {
    const m = await mkMigration({ status: 'migrated' });
    const res = await call(`/migrations/${m.id}/complete`, {
      method: 'POST',
      role: 'operator',
      body: { reason: '  verified by hand  ' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; manualCompletion: Record<string, string> };
    expect(body.status).toBe('manually_completed');
    expect(body.manualCompletion).toMatchObject({
      actorId: actorIds.operator,
      reason: 'verified by hand',
    });
    const stored = await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } });
    expect(stored).toMatchObject({ status: 'manually_completed', statusBeforeManual: 'migrated' });
    expect(await audits('migration.mark_complete', m.id)).toHaveLength(1);
  });

  it('[LIF-075] needs a non-empty reason (422); a running, source_missing or already completed Migration is 409', async () => {
    const m = await mkMigration();
    for (const reason of ['', '   ']) {
      await expectProblem(
        await call(`/migrations/${m.id}/complete`, {
          method: 'POST',
          role: 'operator',
          body: { reason },
        }),
        422,
        'validation_failed',
      );
    }
    await expectProblem(
      await call(`/migrations/${m.id}/complete`, { method: 'POST', role: 'operator', body: {} }),
      422,
      'validation_failed',
    );
    const running = await mkMigration({ status: 'running', statusBeforeRun: 'analyzed' });
    await expectProblem(
      await call(`/migrations/${running.id}/complete`, {
        method: 'POST',
        role: 'operator',
        body: { reason: 'x' },
      }),
      409,
      'conflict',
    );
    const once = await call(`/migrations/${m.id}/complete`, {
      method: 'POST',
      role: 'operator',
      body: { reason: 'x' },
    });
    expect(once.status).toBe(200);
    await expectProblem(
      await call(`/migrations/${m.id}/complete`, {
        method: 'POST',
        role: 'operator',
        body: { reason: 'again' },
      }),
      409,
      'conflict',
    );
    await expectProblem(
      await call('/migrations/nope/complete', {
        method: 'POST',
        role: 'operator',
        body: { reason: 'x' },
      }),
      404,
      'not_found',
    );
  });

  it('[LIF-075] revoking restores the saved status, and never verified without parity and closed tasks', async () => {
    const m = await mkMigration({ status: 'migrated' });
    await call(`/migrations/${m.id}/complete`, {
      method: 'POST',
      role: 'operator',
      body: { reason: 'x' },
    });
    const res = await call(`/migrations/${m.id}/complete`, { method: 'DELETE', role: 'operator' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'migrated', manualCompletion: null });
    expect(
      (await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } })).manualCompletion,
    ).toBeNull();
    expect(await audits('migration.revoke_complete', m.id)).toHaveLength(1);

    // Saved `verified`, no parity: the last Run outcome comes back (ADR-0058).
    const v = await mkMigration({ status: 'manually_completed', statusBeforeManual: 'verified' });
    await t.db.privileged.run.create({
      data: {
        migrationId: v.id,
        kind: 'migrate',
        status: 'partial',
        triggeredById: actorIds.operator,
        options: {},
        finishedAt: new Date(),
      },
    });
    const back = await call(`/migrations/${v.id}/complete`, { method: 'DELETE', role: 'operator' });
    expect(await back.json()).toMatchObject({ status: 'partial' });
  });

  it('[LIF-075] revoking returns verified when parity is equal and no task is open', async () => {
    const m = await mkMigration({ status: 'manually_completed', statusBeforeManual: 'failed' });
    await t.db.privileged.parityResult.create({
      data: {
        migrationId: m.id,
        facetKey: 'webhooks',
        status: 'equal',
        diffs: [],
        excluded: [],
        checkedAt: new Date(),
      },
    });
    const res = await call(`/migrations/${m.id}/complete`, { method: 'DELETE', role: 'operator' });
    expect(await res.json()).toMatchObject({ status: 'verified' });
  });

  it('[LIF-075] revoking a Migration that is not manually completed is a 409', async () => {
    const m = await mkMigration();
    await expectProblem(
      await call(`/migrations/${m.id}/complete`, { method: 'DELETE', role: 'operator' }),
      409,
      'conflict',
    );
    await expectProblem(
      await call('/migrations/nope/complete', { method: 'DELETE', role: 'operator' }),
      404,
      'not_found',
    );
  });
});

describe('POST /migrations/{id}/tasks/{taskId}/{action}', () => {
  const send = (migrationId: string, taskId: string, action: string, role: Role, body?: unknown) =>
    call(`/migrations/${migrationId}/tasks/${taskId}/${action}`, { method: 'POST', role, body });

  it('[LIF-006] done closes a manual task, names the Actor, recomputes readiness and enqueues a Parity Check', async () => {
    const m = await mkMigration({ readiness: 'needs_attention' });
    const analysis = await t.db.privileged.analysis.create({
      data: {
        migrationId: m.id,
        sourceSnapshotIds: [],
        targetSnapshotIds: [],
        readiness: 'needs_attention',
        translation: {},
      },
    });
    await t.db.privileged.migration.update({
      where: { id: m.id },
      data: { latestAnalysisId: analysis.id },
    });
    const task = await mkTask(m.id);
    const res = await send(m.id, task.id, 'done', 'operator', { note: 'read it' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: task.id,
      status: 'done',
      completedById: actorIds.operator,
      note: 'read it',
    });
    expect(
      (await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } })).readiness,
    ).toBe('ready');
    expect(parityJobs).toEqual([m.id]);
    expect(await audits('task.done', task.id)).toHaveLength(1);
  });

  it('[LIF-020] [LIF-006] dismiss sets completedById, so an Analysis would not reopen it', async () => {
    const m = await mkMigration();
    const task = await mkTask(m.id);
    const res = await send(m.id, task.id, 'dismiss', 'admin', { note: 'proceed without it' });
    expect(res.status).toBe(200);
    const stored = await t.db.privileged.manualTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(stored).toMatchObject({
      status: 'dismissed',
      completedById: actorIds.admin,
      note: 'proceed without it',
    });
    expect(stored.completedAt).not.toBeNull();
    expect(parityJobs).toEqual([m.id]);
  });

  it('[LIF-006] reopen clears the completion and reopens the task; states that do not apply are 409', async () => {
    const m = await mkMigration();
    const task = await mkTask(m.id);
    await expectProblem(await send(m.id, task.id, 'reopen', 'operator'), 409, 'conflict');
    await send(m.id, task.id, 'done', 'operator');
    await expectProblem(await send(m.id, task.id, 'done', 'operator'), 409, 'conflict');
    await expectProblem(await send(m.id, task.id, 'dismiss', 'operator'), 409, 'conflict');
    const res = await send(m.id, task.id, 'reopen', 'operator');
    expect(await res.json()).toMatchObject({
      status: 'open',
      completedById: null,
      completedAt: null,
    });
  });

  it('[LIF-006] a resolution task cannot be marked done (422); dismissing it needs a reason', async () => {
    const m = await mkMigration();
    const task = await mkTask(m.id, {
      facetKey: 'access-control',
      code: 'access-control.unmapped-principal',
    });
    await expectProblem(await send(m.id, task.id, 'done', 'operator'), 422, 'validation_failed');
    await expectProblem(await send(m.id, task.id, 'dismiss', 'operator'), 422, 'validation_failed');
    const res = await send(m.id, task.id, 'dismiss', 'operator', { note: 'accepted risk' });
    expect(res.status).toBe(200);
    expect(
      await t.db.privileged.manualTask
        .findUniqueOrThrow({ where: { id: task.id } })
        .then((x) => x.status),
    ).toBe('dismissed');
  });

  it('[LIF-006] done on an accept task records a Migration-scoped lossy_accepted Expected Difference and stales the Analysis', async () => {
    const m = await mkMigration();
    const before = (await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } }))
      .staleGeneration;
    const task = await mkTask(m.id, {
      facetKey: 'webhooks',
      code: 'webhooks.accept-lossy',
      params: {
        policyKey: 'webhooks.event-mapping',
        paths: ['/hooks[key=a]/events', '/hooks[key=b]/events'],
      },
    });
    expect((await send(m.id, task.id, 'done', 'operator')).status).toBe(200);
    const eds = await t.db.privileged.expectedDifference.findMany({
      where: { migrationId: m.id },
      orderBy: { path: 'asc' },
    });
    expect(eds.map((e) => [e.reason, e.facetKey, e.path, e.note, e.createdById])).toEqual([
      [
        'lossy_accepted',
        'webhooks',
        '/hooks[key=a]/events',
        'webhooks.event-mapping',
        actorIds.operator,
      ],
      [
        'lossy_accepted',
        'webhooks',
        '/hooks[key=b]/events',
        'webhooks.event-mapping',
        actorIds.operator,
      ],
    ]);
    const after = (await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } }))
      .staleGeneration;
    expect(after).toBe(before + 1n);

    // The acceptance cannot be revoked on its own while its task is done.
    await expectProblem(
      await call(`/expected-differences/${eds[0]?.id}`, { method: 'DELETE', role: 'operator' }),
      409,
      'conflict',
    );
    // Reopening takes the acceptance back, stales the Analysis again and asks for parity.
    parityJobs.length = 0;
    expect((await send(m.id, task.id, 'reopen', 'operator')).status).toBe(200);
    expect(
      (await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } })).staleGeneration,
    ).toBe(before + 2n);
    expect(parityJobs).toEqual([m.id]);
    const active = await t.db.privileged.expectedDifference.count({
      where: { migrationId: m.id, revokedAt: null },
    });
    expect(active).toBe(0);
  });

  it('[LIF-006] reopening an accept task keeps a path another done accept task still covers', async () => {
    const m = await mkMigration();
    const params = (paths: string[]) => ({ policyKey: 'webhooks.event-mapping', paths });
    const a = await mkTask(m.id, {
      code: 'webhooks.accept-lossy',
      params: params(['/hooks/a', '/hooks/b']),
    });
    const b = await mkTask(m.id, {
      code: 'webhooks.accept-lossy',
      params: params(['/hooks/b', '/hooks/c']),
    });
    await send(m.id, a.id, 'done', 'operator');
    await send(m.id, b.id, 'done', 'operator');
    await send(m.id, b.id, 'reopen', 'operator');
    const active = await t.db.privileged.expectedDifference.findMany({
      where: { migrationId: m.id, revokedAt: null },
      orderBy: { path: 'asc' },
    });
    expect(active.map((e) => e.path)).toEqual(['/hooks/a', '/hooks/b']);
  });

  it('[API-020] a task of another Migration is a 404 through this Migration; unknown ids are 404', async () => {
    const a = await mkMigration();
    const b = await mkMigration();
    const task = await mkTask(a.id);
    await expectProblem(await send(b.id, task.id, 'done', 'operator'), 404, 'not_found');
    await expectProblem(await send(a.id, 'nope', 'done', 'operator'), 404, 'not_found');
    expect(
      (await t.db.privileged.manualTask.findUniqueOrThrow({ where: { id: task.id } })).status,
    ).toBe('open');
    expect(parityJobs).toEqual([]);
  });

  it('[LIF-062] a Parity Check that cannot be enqueued does not undo the task change', async () => {
    const m = await mkMigration();
    const task = await mkTask(m.id);
    failParityEnqueue = true;
    const res = await send(m.id, task.id, 'done', 'operator');
    expect(res.status).toBe(200);
    expect(faults).toHaveLength(1);
    expect(
      (await t.db.privileged.manualTask.findUniqueOrThrow({ where: { id: task.id } })).status,
    ).toBe('done');
  });

  it('[API-020] an unknown action or an oversized note is 422', async () => {
    const m = await mkMigration();
    const task = await mkTask(m.id);
    await expectProblem(await send(m.id, task.id, 'explode', 'operator'), 422, 'validation_failed');
    await expectProblem(
      await send(m.id, task.id, 'done', 'operator', { note: 'x'.repeat(1001) }),
      422,
      'validation_failed',
    );
  });
});

describe('Expected Difference endpoints', () => {
  it('[API-020] creates a manual_accepted difference for the Migration, stales its Analysis and enqueues a Parity Check', async () => {
    const m = await mkMigration();
    const before = (await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } }))
      .staleGeneration;
    const res = await call(`/migrations/${m.id}/expected-differences`, {
      method: 'POST',
      role: 'operator',
      body: { facetKey: 'webhooks', path: '/hooks[key=a]/url', note: 'renamed on purpose' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body).toMatchObject({
      routeId,
      migrationId: m.id,
      facetKey: 'webhooks',
      reason: 'manual_accepted',
      note: 'renamed on purpose',
      createdById: actorIds.operator,
      revokedAt: null,
    });
    const after = (await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } }))
      .staleGeneration;
    expect(after).toBe(before + 1n);
    expect(parityJobs).toEqual([m.id]);
    expect(await audits('expected_difference.create', body.id)).toHaveLength(1);
  });

  it('[API-020] refuses a duplicate (409), an unknown Facet, a bad path and a missing note (422)', async () => {
    const m = await mkMigration();
    const post = (body: unknown) =>
      call(`/migrations/${m.id}/expected-differences`, { method: 'POST', role: 'operator', body });
    const good = { facetKey: 'webhooks', path: '/hooks', note: 'n' };
    expect((await post(good)).status).toBe(201);
    await expectProblem(await post(good), 409, 'conflict');
    await expectProblem(await post({ ...good, facetKey: 'nope' }), 422, 'validation_failed');
    await expectProblem(await post({ ...good, path: 'no-slash' }), 422, 'validation_failed');
    await expectProblem(await post({ ...good, note: '  ' }), 422, 'validation_failed');
    await expectProblem(
      await call('/migrations/nope/expected-differences', {
        method: 'POST',
        role: 'operator',
        body: good,
      }),
      404,
      'not_found',
    );
  });

  it('[API-020] revoke sets revokedAt, stales the Analysis and enqueues a Parity Check; a second revoke is 409', async () => {
    const m = await mkMigration();
    const ed = await t.db.privileged.expectedDifference.create({
      data: {
        routeId,
        migrationId: m.id,
        facetKey: 'webhooks',
        path: '/hooks',
        reason: 'manual_accepted',
        note: 'n',
      },
    });
    const before = (await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } }))
      .staleGeneration;
    const res = await call(`/expected-differences/${ed.id}`, {
      method: 'DELETE',
      role: 'operator',
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { revokedAt: string | null }).toMatchObject({
      revokedAt: expect.any(String),
    });
    const after = (await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } }))
      .staleGeneration;
    expect(after).toBe(before + 1n);
    expect(parityJobs).toEqual([m.id]);
    expect(await audits('expected_difference.revoke', ed.id)).toHaveLength(1);
    await expectProblem(
      await call(`/expected-differences/${ed.id}`, { method: 'DELETE', role: 'operator' }),
      409,
      'conflict',
    );
    await expectProblem(
      await call('/expected-differences/nope', { method: 'DELETE', role: 'operator' }),
      404,
      'not_found',
    );
  });

  it('[AUTH-050] an exclusion belongs to its Identity Mapping and is not revoked here (409)', async () => {
    const ed = await t.db.privileged.expectedDifference.create({
      data: {
        routeId,
        facetKey: 'members',
        path: '/members',
        reason: 'identity_excluded',
        note: 'n',
      },
    });
    await expectProblem(
      await call(`/expected-differences/${ed.id}`, { method: 'DELETE', role: 'operator' }),
      409,
      'conflict',
    );
    expect(
      (await t.db.privileged.expectedDifference.findUniqueOrThrow({ where: { id: ed.id } }))
        .revokedAt,
    ).toBeNull();
  });

  it('[LIF-021] revoking a Route-wide record stales every Analysis on that Route only', async () => {
    const inRoute = await mkMigration();
    const elsewhere = await mkMigration({}, otherRouteId);
    const ed = await t.db.privileged.expectedDifference.create({
      data: {
        routeId,
        facetKey: 'webhooks',
        path: '/hooks',
        reason: 'lossy_accepted',
        note: 'webhooks.event-mapping',
      },
    });
    const gen = async (id: string) =>
      (await t.db.privileged.migration.findUniqueOrThrow({ where: { id } })).staleGeneration;
    const [a0, b0] = [await gen(inRoute.id), await gen(elsewhere.id)];
    expect(
      (await call(`/expected-differences/${ed.id}`, { method: 'DELETE', role: 'admin' })).status,
    ).toBe(200);
    expect(await gen(inRoute.id)).toBe(a0 + 1n);
    expect(await gen(elsewhere.id)).toBe(b0);
  });
});

describe('POST /migrations/{id}/drift/accept (LIF-065)', () => {
  const accept = (
    id: string,
    role: Role | undefined = 'operator',
    body: unknown = { note: 'ok' },
  ) => call(`/migrations/${id}/drift/accept`, { method: 'POST', ...(role ? { role } : {}), body });

  async function drifted() {
    const m = await mkMigration({ status: 'drifted', statusBeforeDrift: 'verified' });
    await t.db.privileged.parityResult.createMany({
      data: [
        {
          migrationId: m.id,
          facetKey: 'webhooks',
          status: 'different',
          diffs: [
            { path: '/hooks[key=a]/active', source: true, target: false },
            { path: '/hooks[key=b]', source: { key: 'b' }, target: null },
          ],
          excluded: [],
          checkedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          migrationId: m.id,
          facetKey: 'git-refs',
          status: 'different',
          diffs: [{ path: '/refs[name=refs/heads/release/*]', source: 'a', target: 'b' }],
          excluded: [],
          checkedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          migrationId: m.id,
          facetKey: 'variables',
          status: 'equal',
          diffs: [],
          excluded: [],
          checkedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    });
    return m;
  }

  it('[API-020] [LIF-065] accepts every differing path of every Facet as manual_accepted, audited, stales the Analysis and enqueues a Parity Check', async () => {
    const m = await drifted();
    const before = (await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } }))
      .staleGeneration;
    const res = await accept(m.id, 'operator', { note: 'we meant it' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      migrationId: m.id,
      accepted: 3,
      alreadyAccepted: 0,
      skipped: [],
      truncated: false,
    });
    const eds = await t.db.privileged.expectedDifference.findMany({
      where: { migrationId: m.id },
      orderBy: [{ facetKey: 'asc' }, { path: 'asc' }],
    });
    expect(eds.map((e) => [e.facetKey, e.path, e.reason, e.note, e.createdById])).toEqual([
      [
        'git-refs',
        '/refs[name=refs/heads/release/\\*]',
        'manual_accepted',
        'we meant it',
        actorIds.operator,
      ],
      ['webhooks', '/hooks[key=a]/active', 'manual_accepted', 'we meant it', actorIds.operator],
      ['webhooks', '/hooks[key=b]', 'manual_accepted', 'we meant it', actorIds.operator],
    ]);
    expect(
      (await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } })).staleGeneration,
    ).toBe(before + 1n);
    // The status moves only when the Parity Check the accept enqueued finds nothing left.
    expect(
      (await t.db.privileged.migration.findUniqueOrThrow({ where: { id: m.id } })).status,
    ).toBe('drifted');
    expect(parityJobs).toEqual([m.id]);
    expect(await audits('migration.drift_accept', m.id)).toHaveLength(1);
    for (const e of eds) expect(await audits('expected_difference.create', e.id)).toHaveLength(1);
  });

  it('[LIF-065] accept supersedes a Parity Check that read the old inputs: the generation moves in the same transaction, and so does a create or a revoke of an Expected Difference', async () => {
    const generation = async (id: string) =>
      (await t.db.privileged.migration.findUniqueOrThrow({ where: { id } })).parityGeneration;
    const m = await drifted();
    const g0 = await generation(m.id);
    await accept(m.id);
    expect(await generation(m.id)).toBe(g0 + 1n);
    const other = await mkMigration();
    const g1 = await generation(other.id);
    const created = await call(`/migrations/${other.id}/expected-differences`, {
      method: 'POST',
      role: 'operator',
      body: { facetKey: 'webhooks', path: '/hooks[key=z]', note: 'n' },
    });
    expect(await generation(other.id)).toBe(g1 + 1n);
    const ed = (await created.json()) as { id: string };
    await call(`/expected-differences/${ed.id}`, { method: 'DELETE', role: 'operator' });
    expect(await generation(other.id)).toBe(g1 + 2n);
  });

  it('[LIF-065] a glob in a stored path is escaped: the acceptance matches that path only', async () => {
    const m = await drifted();
    await accept(m.id);
    const ed = await t.db.privileged.expectedDifference.findFirstOrThrow({
      where: { migrationId: m.id, facetKey: 'git-refs' },
    });
    expect(() => parsePathPattern(ed.path)).not.toThrow();
    expect(ed.path).toContain('\\*');
  });

  it('[LIF-065] a second accept creates nothing new', async () => {
    const m = await drifted();
    expect((await accept(m.id)).status).toBe(200);
    const again = await accept(m.id);
    expect(await again.json()).toMatchObject({ accepted: 0, alreadyAccepted: 3 });
    expect(await t.db.privileged.expectedDifference.count({ where: { migrationId: m.id } })).toBe(
      3,
    );
  });

  it('[API-020] [LIF-065] only a drifted Migration can accept drift (409); an unknown one is 404; a missing note is 422', async () => {
    const verified = await mkMigration({ status: 'verified' });
    await expectProblem(await accept(verified.id), 409, 'conflict');
    await expectProblem(await accept('nope'), 404, 'not_found');
    const m = await drifted();
    await expectProblem(await accept(m.id, 'operator', { note: '  ' }), 422, 'validation_failed');
    await expectProblem(await accept(m.id, 'operator', {}), 422, 'validation_failed');
    expect(await t.db.privileged.expectedDifference.count({ where: { migrationId: m.id } })).toBe(
      0,
    );
  });

  it('[LIF-065] a Parity Check that cannot be enqueued does not undo the acceptance', async () => {
    const m = await drifted();
    failParityEnqueue = true;
    expect((await accept(m.id)).status).toBe(200);
    expect(faults).toHaveLength(1);
    expect(await t.db.privileged.expectedDifference.count({ where: { migrationId: m.id } })).toBe(
      3,
    );
  });
});
