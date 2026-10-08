import type { DomainEvent } from '@git-migrator/core';
import type { FeedMessage } from '@git-migrator/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventHub, type EventHub } from './events.ts';

const at = '2026-01-01T00:00:00.000Z';
const ev = (type: DomainEvent['type'], ids: DomainEvent['ids']): DomainEvent => ({ type, ids, at });

class FakeListener {
  handlers = new Set<(m: FeedMessage) => void>();
  started = 0;
  closed = 0;
  connected = true;
  start() {
    this.started++;
  }
  subscribe(fn: (m: FeedMessage) => void) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }
  async close() {
    this.closed++;
  }
  emit(message: FeedMessage) {
    for (const h of [...this.handlers]) h(message);
  }
}

/** Collects the text of everything a stream has produced so far. */
function collect(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let done = false;
  const pump = (async () => {
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (r.done) {
        done = true;
        return;
      }
      chunks.push(decoder.decode(r.value));
    }
  })();
  return {
    get text() {
      return chunks.join('');
    },
    get done() {
      return done;
    },
    pump,
    cancel: () => reader.cancel(),
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

describe('event hub (JOB-060)', () => {
  let listener: FakeListener;
  let hub: EventHub;
  const slow: number[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    listener = new FakeListener();
    hub = createEventHub({ listener, random: () => 0.5, onSlowClient: () => slow.push(1) });
  });
  afterEach(async () => {
    await hub.close();
    vi.useRealTimers();
    slow.length = 0;
  });

  const open = (topics: string[], signal?: AbortSignal, owner = 'actor-1') => {
    const stream = hub.stream({ topics, owner, signal });
    if (!stream) throw new Error('no stream');
    return collect(stream);
  };

  it('[JOB-060] starts the one listener on the first stream and fans out only matching topics', async () => {
    expect(listener.started).toBe(0);
    const a = open(['run:r1', 'list:migrations']);
    const b = open(['run:r2']);
    expect(listener.started).toBe(2); // start() is idempotent in the real listener
    expect(listener.handlers.size).toBe(1);
    await settle();
    listener.emit({
      kind: 'event',
      event: ev('run.updated', { run: 'r1', migration: 'm1' }),
    });
    await settle();
    expect(a.text).toContain('event: gm');
    const frame = a.text.split('\n\n').find((f) => f.startsWith('event: gm')) ?? '';
    const data = JSON.parse(frame.split('data: ')[1] ?? '{}');
    expect(data).toEqual({
      type: 'run.updated',
      ids: { run: 'r1', migration: 'm1' },
      at,
      topics: ['run:r1', 'list:migrations'],
    });
    expect(b.text).not.toContain('event: gm');
    expect(hub.clientCount).toBe(2);
  });

  it('[JOB-060] never delivers an event on a topic the client did not name', async () => {
    const a = open(['migration:m1']);
    await settle();
    listener.emit({ kind: 'event', event: ev('migration.updated', { migration: 'other' }) });
    listener.emit({ kind: 'event', event: ev('quota.updated', {}) });
    listener.emit({ kind: 'event', event: ev('run.log', {}) });
    await settle();
    expect(a.text).not.toContain('event: gm');
  });

  it('[JOB-060] sends a heartbeat comment and event every 15 seconds', async () => {
    const a = open(['quota']);
    await settle();
    expect(a.text).not.toContain('heartbeat');
    await vi.advanceTimersByTimeAsync(14_999);
    expect(a.text).not.toContain('heartbeat');
    await vi.advanceTimersByTimeAsync(1);
    expect(a.text).toContain(': heartbeat\n\nevent: heartbeat\ndata: {}\n\n');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(a.text.match(/event: heartbeat/g)).toHaveLength(2);
  });

  it('[JOB-060] tells clients to resync when the listener reconnects', async () => {
    const a = open(['quota']);
    await settle();
    listener.emit({ kind: 'resync' });
    await settle();
    expect(a.text).toContain('event: resync');
  });

  it('[JOB-060] cleans up when the client cancels or its connection aborts', async () => {
    const abort = new AbortController();
    const a = open(['quota']);
    const b = open(['quota'], abort.signal);
    const c = open(['quota'], AbortSignal.abort());
    await settle();
    expect(hub.clientCount).toBe(2);
    await a.cancel();
    expect(hub.clientCount).toBe(1);
    abort.abort();
    await settle();
    expect(hub.clientCount).toBe(0);
    await Promise.all([a.pump, b.pump, c.pump]);
    expect(b.done).toBe(true);
    // No timer is left behind: a heartbeat interval would still be pending.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('[JOB-060] a burst past the queue limit becomes one resync and the client keeps its stream', async () => {
    const stream = hub.stream({
      topics: ['quota'],
      owner: 'actor-1',
    }) as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    // The client reads nothing while 200 events arrive: the queue never grows past its limit.
    for (let i = 0; i < 200; i++) {
      listener.emit({ kind: 'event', event: ev('quota.updated', {}) });
    }
    expect(slow).toEqual([]);
    expect(hub.clientCount).toBe(1);
    // What the client missed is replaced by one resync, which comes first.
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toBe('event: resync\ndata: {}\n\n');
    reader.cancel();
  });

  it('[JOB-060] drops a client that reads nothing for several heartbeats, freeing its queue', async () => {
    const stream = hub.stream({
      topics: ['quota'],
      owner: 'actor-1',
    }) as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    for (let i = 0; i < 200; i++) {
      listener.emit({ kind: 'event', event: ev('quota.updated', {}) });
    }
    await vi.advanceTimersByTimeAsync(15_000 * 3);
    expect(slow).toEqual([]);
    expect(hub.clientCount).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(slow).toEqual([1]);
    expect(hub.clientCount).toBe(0);
    await expect(reader.read()).rejects.toThrow('slow client dropped');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('[JOB-060] a reader that keeps up is never dropped and a stalled one does not affect it', async () => {
    hub.stream({ topics: ['quota'], owner: 'actor-2' });
    const fast = open(['quota']);
    for (let i = 0; i < 100; i++) {
      listener.emit({ kind: 'event', event: ev('quota.updated', {}) });
      await settle();
    }
    await vi.advanceTimersByTimeAsync(15_000 * 6);
    expect(slow).toEqual([1]);
    expect(fast.text.match(/event: gm/g)).toHaveLength(100);
    expect(hub.clientCount).toBe(1);
  });

  it('[JOB-060] stops sending heartbeats while the listener is down and resumes after it is back', async () => {
    const a = open(['quota']);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(a.text.match(/event: heartbeat/g)).toHaveLength(1);
    listener.connected = false;
    await vi.advanceTimersByTimeAsync(15_000 * 4);
    expect(a.text.match(/event: heartbeat/g)).toHaveLength(1);
    listener.connected = true;
    listener.emit({ kind: 'resync' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(a.text).toContain('event: resync');
    expect(a.text.match(/event: heartbeat/g)).toHaveLength(2);
  });

  it('[JOB-060] ends a stream after its lifetime, spread by 20% either way', async () => {
    const early = createEventHub({ listener: new FakeListener(), random: () => 0 });
    const late = createEventHub({ listener: new FakeListener(), random: () => 1 });
    const a = collect(
      early.stream({ topics: ['quota'], owner: 'x' }) as ReadableStream<Uint8Array>,
    );
    const b = collect(late.stream({ topics: ['quota'], owner: 'x' }) as ReadableStream<Uint8Array>);
    const ten = 10 * 60_000;
    await vi.advanceTimersByTimeAsync(ten * 0.8 - 1);
    expect(a.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await a.pump;
    expect(a.done).toBe(true);
    expect(b.done).toBe(false);
    await vi.advanceTimersByTimeAsync(ten * 1.2 - ten * 0.8 - 1);
    expect(b.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await b.pump;
    expect(b.done).toBe(true);
    await early.close();
    await late.close();
  });

  it('[JOB-060] ends a stream after its maximum lifetime so the client reconnects', async () => {
    const a = open(['quota']);
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(a.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await a.pump;
    expect(a.done).toBe(true);
    expect(hub.clientCount).toBe(0);
  });

  it('[JOB-060] the process-wide and per-Actor stream limits are independent', async () => {
    const small = createEventHub({
      listener: new FakeListener(),
      maxStreams: 5,
      maxStreamsPerOwner: 2,
    });
    const stream = (owner: string) => small.stream({ topics: ['quota'], owner });
    expect(stream('a')).toBeDefined();
    expect(stream('a')).toBeDefined();
    // Actor a is at its limit, though the process has room.
    expect(stream('a')).toBeUndefined();
    expect(stream('b')).toBeDefined();
    expect(stream('b')).toBeDefined();
    expect(stream('b')).toBeUndefined();
    // Actor c is under its limit, but the process is full (4 of 5, then 5 of 5).
    expect(stream('c')).toBeDefined();
    expect(small.clientCount).toBe(5);
    expect(stream('d')).toBeUndefined();
    await small.close();
    expect(stream('e')).toBeUndefined();
  });

  it('[JOB-060] a closed stream frees its Actor slot, and closeOwner ends only that Actor', async () => {
    const small = createEventHub({
      listener: new FakeListener(),
      maxStreamsPerOwner: 1,
    });
    const first = collect(
      small.stream({ topics: ['quota'], owner: 'a' }) as ReadableStream<Uint8Array>,
    );
    const other = collect(
      small.stream({ topics: ['quota'], owner: 'b' }) as ReadableStream<Uint8Array>,
    );
    expect(small.stream({ topics: ['quota'], owner: 'a' })).toBeUndefined();
    await first.cancel();
    expect(small.stream({ topics: ['quota'], owner: 'a' })).toBeDefined();
    expect(small.closeOwner('a')).toBe(1);
    expect(small.closeOwner('a')).toBe(0);
    expect(small.clientCount).toBe(1);
    expect(other.done).toBe(false);
    expect(small.stream({ topics: ['quota'], owner: 'a' })).toBeDefined();
    await small.close();
  });

  it('[JOB-060] coalesces run.log events to at most 4 per second per Run', async () => {
    const a = open(['run:r1']);
    const other = open(['run:r2']);
    await settle();
    const log = (run: string) => listener.emit({ kind: 'event', event: ev('run.log', { run }) });
    const count = (c: { text: string }) => c.text.match(/event: gm/g)?.length ?? 0;
    for (let i = 0; i < 50; i++) log('r1');
    log('r2');
    await settle();
    expect(count(a)).toBe(1);
    expect(count(other)).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(count(a)).toBe(2); // the trailing event of the burst
    // Steady 100 events per second for 3 seconds: never more than 4 per second.
    for (let ms = 0; ms < 3000; ms += 10) {
      log('r1');
      await vi.advanceTimersByTimeAsync(10);
    }
    const total = count(a) - 2;
    expect(total).toBeLessThanOrEqual(12 + 1);
    expect(total).toBeGreaterThanOrEqual(11);
    // After a quiet period the next event goes out at once, and the window state is freed.
    await vi.advanceTimersByTimeAsync(1000);
    const before = count(a);
    log('r1');
    await settle();
    expect(count(a)).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(1000);
    // Only the two clients' heartbeat and lifetime timers remain: the log windows are freed.
    expect(vi.getTimerCount()).toBe(4);
  });

  it('[JOB-060] close ends every stream and closes the listener', async () => {
    const a = open(['quota']);
    const b = open(['run:x']);
    await settle();
    await hub.close();
    await Promise.all([a.pump, b.pump]);
    expect(a.done && b.done).toBe(true);
    expect(listener.closed).toBe(1);
    expect(listener.handlers.size).toBe(0);
    expect(hub.clientCount).toBe(0);
  });
});
