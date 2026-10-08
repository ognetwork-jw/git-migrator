import { type AuthService, issueApiKey } from '@git-migrator/auth';
import {
  createEventListener,
  type EventListener,
  pgListenClient,
  publishEvent,
} from '@git-migrator/db';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiApp } from './app.ts';
import { createEventHub, type EventHub } from './events.ts';
import { PROBLEM_BASE, PROBLEM_CONTENT_TYPE } from './problem.ts';

const ORIGIN = 'http://localhost:3000';
const at = '2026-01-01T00:00:00.000Z';

let t: TestDatabase;
let listener: EventListener;
let hub: EventHub;
let app: ReturnType<typeof createApiApp>;
let viewerKey: string;
let disabledKey: string;

interface TestKey {
  readonly key: string;
  readonly actorId: string;
  readonly keyId: string;
}

async function keyFor(role: 'viewer' | 'admin', disabled = false): Promise<TestKey> {
  const actor = await t.db.privileged.actor.create({
    data: { kind: 'service', displayName: `svc ${role}`, role },
  });
  const issued = await issueApiKey(t.db.privileged, {
    actorId: actor.id,
    name: 'k',
    issuedBy: actor.id,
  });
  if (disabled) await t.db.privileged.actor.update({ where: { id: actor.id }, data: { disabled } });
  return { key: issued.key, actorId: actor.id, keyId: issued.id };
}

beforeAll(async () => {
  t = await createTestDatabase('gm_t022a_');
  listener = createEventListener({ createClient: pgListenClient(t.db.pool) });
  hub = createEventHub({ listener, heartbeatMs: 200 });
  // Bearer requests never touch Better Auth, so the auth service is not needed here.
  app = createApiApp({ db: t.db, auth: {} as AuthService, publicUrl: ORIGIN, events: hub });
  viewerKey = (await keyFor('viewer')).key;
  disabledKey = (await keyFor('admin', true)).key;
}, 120_000);

afterAll(async () => {
  await hub?.close();
  await t?.drop();
});

const get = (path: string, key?: string, signal?: AbortSignal) =>
  app.request(`${ORIGIN}${path}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal,
  });

/** Reads from a stream until `text` contains `needle`. */
async function readUntil(res: Response, needle: string, ms = 5000): Promise<string> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  while (!text.includes(needle)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}; got ${text}`);
    const r = await reader.read();
    if (r.done) break;
    text += decoder.decode(r.value);
  }
  reader.releaseLock();
  return text;
}

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain(PROBLEM_CONTENT_TYPE);
  const body = (await res.json()) as { type: string };
  expect(body.type).toBe(`${PROBLEM_BASE}${code}`);
}

describe('GET /api/v1/events (JOB-060)', () => {
  it('[JOB-060] requires authentication', async () => {
    await expectProblem(await get('/api/v1/events?topics=quota'), 401, 'unauthenticated');
    await expectProblem(
      await get('/api/v1/events?topics=quota', 'gm_bogus'),
      401,
      'unauthenticated',
    );
  });

  it('[JOB-060] rejects a disabled Actor', async () => {
    await expectProblem(
      await get('/api/v1/events?topics=quota', disabledKey),
      401,
      'unauthenticated',
    );
  });

  it('[JOB-060] rejects a missing, unknown or oversized topic list with problem+json', async () => {
    for (const query of [
      '',
      '?topics=',
      '?topics=nope',
      '?topics=run:a%20b',
      '?topics=quota,bad:1',
    ]) {
      await expectProblem(await get(`/api/v1/events${query}`, viewerKey), 422, 'validation_failed');
    }
    const many = Array.from({ length: 51 }, (_, i) => `run:r${i}`).join(',');
    await expectProblem(
      await get(`/api/v1/events?topics=${many}`, viewerKey),
      422,
      'validation_failed',
    );
  });

  it('[JOB-060] streams only the events of the requested topics, with a heartbeat', async () => {
    const abort = new AbortController();
    const res = await get('/api/v1/events?topics=run:r1,list:tasks', viewerKey, abort.signal);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    await until(() => listener.connected);
    // Not visible to this client: another Run, and the quota topic.
    await publishEvent(t.db.pool, { type: 'run.updated', ids: { run: 'other' }, at });
    await publishEvent(t.db.pool, { type: 'quota.updated', ids: {}, at });
    await publishEvent(t.db.pool, {
      type: 'run.updated',
      ids: { run: 'r1', migration: 'm1' },
      at,
    });
    const text = await readUntil(res, '"run":"r1"');
    expect(text).toContain('retry: 5000');
    expect(text).toContain('event: gm');
    expect(text).not.toContain('other');
    expect(text).not.toContain('quota');
    const frame = text.split('\n\n').find((f) => f.includes('"run":"r1"')) ?? '';
    expect(JSON.parse(frame.split('data: ')[1] ?? '{}').topics).toEqual(['run:r1']);
    abort.abort();
  });

  it('[JOB-060] sends heartbeats and frees the stream when the client disconnects', async () => {
    const abort = new AbortController();
    const before = hub.clientCount;
    const res = await get('/api/v1/events?topics=quota', viewerKey, abort.signal);
    expect(hub.clientCount).toBe(before + 1);
    expect(await readUntil(res, 'event: heartbeat')).toContain(': heartbeat');
    abort.abort();
    await until(() => hub.clientCount === before);
  });

  it('[JOB-060] answers 429 when the process is at its stream limit', async () => {
    const small = createEventHub({
      listener: createEventListener({ createClient: pgListenClient(t.db.pool) }),
      maxStreams: 0,
    });
    const limited = createApiApp({
      db: t.db,
      auth: {} as AuthService,
      publicUrl: ORIGIN,
      events: small,
    });
    const res = await limited.request(`${ORIGIN}/api/v1/events?topics=quota`, {
      headers: { authorization: `Bearer ${viewerKey}` },
    });
    await expectProblem(res, 429, 'too_many_streams');
    expect(res.headers.get('retry-after')).toBe('5');
    await small.close();
  });

  it('[API-021] [JOB-060] a viewer may open a stream', async () => {
    const abort = new AbortController();
    const res = await get('/api/v1/events?topics=list:migrations', viewerKey, abort.signal);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    abort.abort();
  });

  it('[JOB-060] one Actor cannot hold more than its share of streams, and others are unaffected', async () => {
    const limited = createEventHub({
      listener: createEventListener({ createClient: pgListenClient(t.db.pool) }),
      maxStreamsPerOwner: 2,
      maxStreams: 3,
    });
    const limitedApp = createApiApp({
      db: t.db,
      auth: {} as AuthService,
      publicUrl: ORIGIN,
      events: limited,
    });
    const other = (await keyFor('viewer')).key;
    const open = (key: string) =>
      limitedApp.request(`${ORIGIN}/api/v1/events?topics=quota`, {
        headers: { authorization: `Bearer ${key}` },
      });
    expect((await open(viewerKey)).status).toBe(200);
    expect((await open(viewerKey)).status).toBe(200);
    const third = await open(viewerKey);
    await expectProblem(third, 429, 'too_many_streams');
    // Another Actor still has room, until the process-wide cap (3) is reached.
    expect((await open(other)).status).toBe(200);
    await expectProblem(await open(other), 429, 'too_many_streams');
    expect(limited.clientCount).toBe(3);
    await limited.close();
  });

  it('[JOB-060] disabling an Actor and revoking a key end that Actor streams', async () => {
    const admin = await keyFor('admin');
    const readToEnd = async (res: Response) => {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const r = await reader.read().catch(() => ({ done: true }));
        if (r.done) return;
      }
    };
    const call = (method: string, path: string, body?: unknown) =>
      app.request(`${ORIGIN}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${admin.key}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const disabled = await keyFor('viewer');
    const stream1 = await get('/api/v1/events?topics=quota', disabled.key);
    expect(stream1.status).toBe(200);
    expect(
      (await call('PATCH', `/api/v1/actors/${disabled.actorId}`, { disabled: true })).status,
    ).toBe(200);
    await readToEnd(stream1);

    const revoked = await keyFor('viewer');
    const stream2 = await get('/api/v1/events?topics=quota', revoked.key);
    expect(stream2.status).toBe(200);
    expect((await call('DELETE', `/api/v1/api-keys/${revoked.keyId}`)).status).toBe(204);
    await readToEnd(stream2);
    await expectProblem(
      await get('/api/v1/events?topics=quota', revoked.key),
      401,
      'unauthenticated',
    );
  });

  it('[JOB-060] is described in the OpenAPI document', async () => {
    const doc = (await (await get('/api/v1/openapi.json', viewerKey)).json()) as {
      paths: Record<string, { get?: { responses: Record<string, unknown> } }>;
    };
    expect(Object.keys(doc.paths['/events']?.get?.responses ?? {})).toContain('200');
  });
});

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
}
