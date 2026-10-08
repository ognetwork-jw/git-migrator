import { type DomainEvent, EventEncodingError } from '@git-migrator/core';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createEventListener,
  type EventListener,
  type FeedMessage,
  type ListenClient,
  pgListenClient,
  publishEvent,
  publishEventIn,
} from './events.ts';
import { createTestDatabase, type TestDatabase } from './test-support.ts';

const event = (over: Partial<DomainEvent> = {}): DomainEvent => ({
  type: 'run.updated',
  ids: { run: 'r1' },
  at: '2026-01-01T00:00:00.000Z',
  ...over,
});

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('publisher and LISTEN fan-out against PostgreSQL (JOB-060)', () => {
  let t: TestDatabase;
  let listener: EventListener;
  beforeAll(async () => {
    t = await createTestDatabase('gm_t022_');
  }, 120_000);
  afterEach(async () => {
    await listener?.close();
  });
  afterAll(async () => {
    await t.drop();
  });

  it('[JOB-060] one listener connection fans a published event out to every subscriber', async () => {
    listener = createEventListener({ createClient: pgListenClient(t.db.pool) });
    const a: FeedMessage[] = [];
    const b: FeedMessage[] = [];
    listener.subscribe((m) => m.kind === 'event' && a.push(m));
    const unsubscribeB = listener.subscribe((m) => m.kind === 'event' && b.push(m));
    listener.start();
    await until(() => listener.connected);
    await publishEvent(t.db.pool, event());
    await until(() => a.length === 1 && b.length === 1);
    expect(a[0]).toEqual({ kind: 'event', event: event() });
    unsubscribeB();
    await publishEvent(t.db.pool, event({ ids: { run: 'r2' } }));
    await until(() => a.length === 2);
    expect(b).toHaveLength(1);
  });

  it('[JOB-060] a notification published in a transaction arrives only on commit', async () => {
    listener = createEventListener({ createClient: pgListenClient(t.db.pool) });
    const seen: FeedMessage[] = [];
    listener.subscribe((m) => m.kind === 'event' && seen.push(m));
    listener.start();
    await until(() => listener.connected);
    await t.db.privileged
      .$transaction(async (tx) => {
        await publishEventIn(tx, event({ ids: { run: 'rolled' } }));
        throw new Error('roll back');
      })
      .catch(() => undefined);
    await t.db.privileged.$transaction(async (tx) => {
      await publishEventIn(tx, event({ ids: { run: 'committed' } }));
    });
    await until(() => seen.length >= 1);
    expect(seen).toEqual([{ kind: 'event', event: event({ ids: { run: 'committed' } }) }]);
  });

  it('[JOB-060] publishing refuses an invalid or oversized event', async () => {
    await expect(publishEvent(t.db.pool, event({ type: 'nope' as never }))).rejects.toThrow(
      EventEncodingError,
    );
    await expect(publishEventIn(t.db.privileged, event({ at: 'x'.repeat(8000) }))).rejects.toThrow(
      EventEncodingError,
    );
  });

  it('[JOB-060] a notification that is not a valid event is dropped', async () => {
    const problems: string[] = [];
    listener = createEventListener({
      createClient: pgListenClient(t.db.pool),
      onProblem: (what) => problems.push(what),
    });
    const seen: FeedMessage[] = [];
    listener.subscribe((m) => m.kind === 'event' && seen.push(m));
    listener.start();
    await until(() => listener.connected);
    await t.db.pool.query(`select pg_notify('gm_events', 'not json')`);
    await t.db.pool.query(`select pg_notify('other', '{}')`);
    await publishEvent(t.db.pool, event());
    await until(() => seen.length === 1);
    expect(problems).toEqual(['bad_payload']);
  });

  it('[JOB-060] reconnects after the server drops the connection and tells subscribers to resync', async () => {
    listener = createEventListener({
      createClient: pgListenClient(t.db.pool),
      initialBackoffMs: 20,
    });
    const seen: FeedMessage[] = [];
    listener.subscribe((m) => seen.push(m));
    listener.start();
    await until(() => listener.connected);
    await until(() => seen.length === 1); // the resync after the first connect
    await t.db.pool.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
       where query like 'LISTEN gm_events%' and datname = current_database()
         and pid <> pg_backend_pid()`,
    );
    await until(() => seen.filter((m) => m.kind === 'resync').length === 2);
    await until(() => listener.connected);
    await publishEvent(t.db.pool, event());
    await until(() => seen.some((m) => m.kind === 'event'));
  });

  it('[JOB-060] pgListenClient connects outside the pool', async () => {
    const client = pgListenClient(t.db.pool)();
    expect(client).toBeInstanceOf(pg.Client);
    await client.connect();
    await client.end();
  });
});

class FakeClient implements ListenClient {
  static all: FakeClient[] = [];
  handlers: Record<string, (arg?: never) => void> = {};
  ended = false;
  queries: string[] = [];
  constructor(
    private readonly failConnect: boolean,
    private readonly gate?: Promise<void>,
    private readonly probe: () => Promise<void> = async () => undefined,
  ) {
    FakeClient.all.push(this);
  }
  async connect() {
    if (this.gate) await this.gate;
    if (this.failConnect) throw new Error('refused');
  }
  async query(text: string) {
    this.queries.push(text);
    if (text === 'select 1') await this.probe();
  }
  async end() {
    this.ended = true;
  }
  on(name: string, handler: (arg: never) => void) {
    this.handlers[name] = handler as (arg?: never) => void;
    return this;
  }
}

describe('listener connection handling (JOB-060)', () => {
  afterEach(() => {
    vi.useRealTimers();
    FakeClient.all = [];
  });

  it('[JOB-060] retries a failed connection with doubling backoff, capped', async () => {
    vi.useFakeTimers();
    const problems: string[] = [];
    let attempts = 0;
    const listener = createEventListener({
      createClient: () => new FakeClient(++attempts < 4),
      initialBackoffMs: 100,
      maxBackoffMs: 200,
      onProblem: (what) => problems.push(what),
    });
    listener.start();
    listener.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(attempts).toBe(4);
    expect(listener.connected).toBe(true);
    expect(problems).toEqual(['connect_failed', 'connect_failed', 'connect_failed']);
    expect(FakeClient.all.map((c) => c.queries)).toEqual([[], [], [], ['LISTEN gm_events']]);
    await listener.close();
    expect(FakeClient.all.at(-1)?.ended).toBe(true);
  });

  it('[JOB-060] close stops reconnecting and a throwing subscriber does not stop the others', async () => {
    vi.useFakeTimers();
    const listener = createEventListener({
      createClient: () => new FakeClient(false),
      initialBackoffMs: 50,
    });
    const seen: FeedMessage[] = [];
    listener.subscribe(() => {
      throw new Error('boom');
    });
    listener.subscribe((m) => seen.push(m));
    listener.start();
    await vi.advanceTimersByTimeAsync(0);
    const first = FakeClient.all[0] as FakeClient;
    first.handlers.notification?.({
      channel: 'gm_events',
      payload: JSON.stringify(event()),
    } as never);
    expect(seen).toEqual([{ kind: 'resync' }, { kind: 'event', event: event() }]);
    first.handlers.error?.(new Error('lost') as never);
    expect(listener.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(FakeClient.all).toHaveLength(2);
    expect(seen.at(-1)).toEqual({ kind: 'resync' });
    await listener.close();
    FakeClient.all[1]?.handlers.end?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeClient.all).toHaveLength(2);
    listener.start();
    expect(FakeClient.all).toHaveLength(2);
  });

  it('[JOB-060] closing while a connection attempt is in flight ends that connection', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listener = createEventListener({ createClient: () => new FakeClient(false, gate) });
    listener.start();
    await listener.close();
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(FakeClient.all[0]?.ended).toBe(true);
    expect(listener.connected).toBe(false);
  });

  it('[JOB-060] subscribers get a resync after the first successful connect, even after failed attempts', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const listener = createEventListener({
      createClient: () => new FakeClient(++attempts < 2),
      initialBackoffMs: 100,
    });
    const seen: FeedMessage[] = [];
    listener.subscribe((m) => seen.push(m));
    listener.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(listener.connected).toBe(true);
    expect(seen).toEqual([{ kind: 'resync' }]);
    await listener.close();
  });

  it('[JOB-060] a connect that never completes counts as failed and is retried', async () => {
    vi.useFakeTimers();
    const problems: string[] = [];
    let attempts = 0;
    const never = new Promise<void>(() => undefined);
    const listener = createEventListener({
      createClient: () => new FakeClient(false, ++attempts === 1 ? never : undefined),
      connectTimeoutMs: 1000,
      initialBackoffMs: 100,
      onProblem: (what) => problems.push(what),
    });
    listener.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(problems).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(problems).toEqual(['connect_failed']);
    expect(FakeClient.all[0]?.ended).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(listener.connected).toBe(true);
    expect(attempts).toBe(2);
    await listener.close();
  });

  it('[JOB-060] probes the connection every interval and reconnects when a probe hangs', async () => {
    vi.useFakeTimers();
    const problems: string[] = [];
    const seen: FeedMessage[] = [];
    let probes = 0;
    const never = new Promise<void>(() => undefined);
    const listener = createEventListener({
      // The second probe hangs; every other one answers.
      createClient: () =>
        new FakeClient(false, undefined, () => (++probes === 2 ? never : Promise.resolve())),
      probeIntervalMs: 30_000,
      probeTimeoutMs: 5_000,
      initialBackoffMs: 100,
      onProblem: (what) => problems.push(what),
    });
    listener.subscribe((m) => seen.push(m));
    listener.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(listener.connected).toBe(true);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(FakeClient.all[0]?.queries).toEqual(['LISTEN gm_events']);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeClient.all[0]?.queries).toEqual(['LISTEN gm_events', 'select 1']);
    expect(listener.connected).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000 + 4_999);
    expect(listener.connected).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(listener.connected).toBe(false);
    expect(problems).toEqual(['probe_failed']);
    expect(FakeClient.all[0]?.ended).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(listener.connected).toBe(true);
    expect(seen).toEqual([{ kind: 'resync' }, { kind: 'resync' }]);
    await listener.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('[JOB-060] a probe that rejects reconnects too', async () => {
    vi.useFakeTimers();
    const problems: string[] = [];
    let first = true;
    const listener = createEventListener({
      createClient: () => {
        const fail = first;
        first = false;
        return new FakeClient(false, undefined, async () => {
          if (fail) throw new Error('connection terminated');
        });
      },
      probeIntervalMs: 1000,
      initialBackoffMs: 50,
      onProblem: (what) => problems.push(what),
    });
    listener.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(problems).toEqual(['probe_failed']);
    await vi.advanceTimersByTimeAsync(50);
    expect(listener.connected).toBe(true);
    await listener.close();
  });
});
