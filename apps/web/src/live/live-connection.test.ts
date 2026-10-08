import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveConnection,
  type EventSourceLike,
  eventsUrl,
  type LiveConnection,
  type LiveMode,
} from './live-connection.ts';

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  listeners = new Map<string, (event: { data?: string }) => void>();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.({});
  }
  fail() {
    this.onerror?.({});
  }
  emit(type: string, payload?: unknown) {
    this.listeners.get(type)?.({
      data: payload === undefined ? undefined : JSON.stringify(payload),
    });
  }
}

const last = () => FakeEventSource.instances.at(-1) as FakeEventSource;

describe('live connection (JOB-060)', () => {
  let invalidated: (readonly string[])[];
  let modes: LiveMode[];
  let connection: LiveConnection;
  const make = (topics = ['run:r1', 'list:runs'], createEventSource?: never) => {
    connection = createLiveConnection({
      topics,
      random: () => 0.5, // no jitter
      onInvalidate: (t) => invalidated.push(t),
      onModeChange: (m) => modes.push(m),
      createEventSource:
        createEventSource ?? ((url: string) => new FakeEventSource(url) as EventSourceLike),
    });
    return connection;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    invalidated = [];
    modes = [];
  });
  afterEach(() => {
    connection?.stop();
    vi.useRealTimers();
  });

  it('[JOB-060] builds the events URL with encoded topics', () => {
    expect(eventsUrl(['run:a', 'quota'])).toBe('/api/v1/events?topics=run%3Aa,quota');
    make();
    connection.start();
    expect(last().url).toBe('/api/v1/events?topics=run%3Ar1,list%3Aruns');
  });

  it('[JOB-060] invalidates the subscribed topics an event names and nothing else', () => {
    make();
    connection.start();
    last().open();
    expect(connection.mode).toBe('sse');
    expect(invalidated).toEqual([]); // the first connection follows a fresh fetch
    last().emit('gm', { type: 'run.updated', ids: {}, at: '', topics: ['run:r1', 'run:evil'] });
    expect(invalidated).toEqual([['run:r1']]);
    last().emit('gm', { topics: ['quota'] });
    last().emit('gm', { topics: 'run:r1' });
    last().emit('gm');
    last().listeners.get('gm')?.({ data: 'not json' });
    expect(invalidated).toHaveLength(1);
  });

  it('[JOB-060] a resync event invalidates every subscribed topic', () => {
    make();
    connection.start();
    last().open();
    last().emit('resync', {});
    expect(invalidated).toEqual([['run:r1', 'list:runs']]);
  });

  it('[JOB-060] reconnects with doubling backoff and invalidates everything once back', () => {
    make();
    connection.start();
    last().open();
    last().fail();
    expect(connection.mode).toBe('connecting');
    expect(last().closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    last().fail();
    vi.advanceTimersByTime(1999);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);
    last().open();
    expect(connection.mode).toBe('sse');
    expect(invalidated).toEqual([['run:r1', 'list:runs']]);
    // A success resets the backoff.
    last().fail();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it('[JOB-060] caps the backoff at 30 seconds', () => {
    make();
    connection.start();
    for (let i = 0; i < 8; i++) {
      last().fail();
      vi.advanceTimersByTime(30_000);
    }
    const count = FakeEventSource.instances.length;
    last().fail();
    vi.advanceTimersByTime(29_999);
    expect(FakeEventSource.instances).toHaveLength(count);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(count + 1);
  });

  it('[JOB-060] polls every 10 seconds when nothing arrives for 45 seconds, then returns to SSE', () => {
    make();
    connection.start();
    last().open();
    vi.advanceTimersByTime(44_999);
    expect(connection.mode).toBe('sse');
    last().emit('heartbeat', {}); // a heartbeat keeps the connection alive
    vi.advanceTimersByTime(44_999);
    expect(connection.mode).toBe('sse');
    expect(invalidated).toEqual([]);
    const silent = last();
    vi.advanceTimersByTime(1);
    expect(connection.mode).toBe('polling');
    expect(silent.closed).toBe(true);
    expect(invalidated).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(invalidated).toEqual([['run:r1', 'list:runs']]);
    vi.advanceTimersByTime(20_000);
    expect(invalidated).toHaveLength(3);
    // The reconnect attempt succeeds: polling stops and one catch-up invalidation is made.
    last().open();
    expect(connection.mode).toBe('sse');
    expect(invalidated).toHaveLength(4);
    vi.advanceTimersByTime(9_000);
    expect(invalidated).toHaveLength(4);
    expect(modes).toEqual(['sse', 'polling', 'sse']);
  });

  it('[JOB-060] falls back to polling when the stream cannot be established', () => {
    make();
    connection.start();
    for (let i = 0; i < 6; i++) {
      last().fail();
      vi.advanceTimersByTime(8_000);
    }
    expect(connection.mode).toBe('polling');
    const before = invalidated.length;
    vi.advanceTimersByTime(10_000);
    expect(invalidated.length).toBe(before + 1);
    // SSE failing for good does not stop the reconnect attempts.
    expect(FakeEventSource.instances.length).toBeGreaterThan(4);
  });

  it('[JOB-060] polls from the start when EventSource is unavailable', () => {
    make(['quota'], (() => undefined) as never);
    connection.start();
    expect(connection.mode).toBe('polling');
    expect(modes).toEqual(['polling']);
    vi.advanceTimersByTime(10_000);
    expect(invalidated).toEqual([['quota']]);
    vi.advanceTimersByTime(10_000);
    expect(invalidated).toHaveLength(2);
    vi.advanceTimersByTime(60_000);
    expect(modes).toEqual(['polling']);
  });

  it('[JOB-060] polls when creating the EventSource throws', () => {
    make(['quota'], (() => {
      throw new Error('blocked');
    }) as never);
    connection.start();
    expect(connection.mode).toBe('polling');
  });

  it('[JOB-060] uses the global EventSource when present, and polls when it is absent', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const withGlobal = createLiveConnection({ topics: ['quota'], onInvalidate: () => undefined });
    withGlobal.start();
    expect(FakeEventSource.instances).toHaveLength(1);
    withGlobal.stop();
    vi.unstubAllGlobals();
    const without = createLiveConnection({ topics: ['quota'], onInvalidate: () => undefined });
    without.start();
    expect(without.mode).toBe('polling');
    without.stop();
  });

  it('[JOB-060] stop closes the stream and every timer, and ignores late events', () => {
    make();
    connection.start();
    connection.start(); // idempotent
    expect(FakeEventSource.instances).toHaveLength(1);
    const source = last();
    source.open();
    connection.stop();
    expect(source.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    source.emit('gm', { topics: ['run:r1'] });
    vi.advanceTimersByTime(120_000);
    expect(invalidated).toEqual([]);
  });

  it('[JOB-060] events from a replaced stream are ignored', () => {
    make();
    connection.start();
    const old = last();
    old.open();
    old.fail();
    vi.advanceTimersByTime(1000);
    old.emit('gm', { topics: ['run:r1'] });
    old.emit('resync', {});
    old.emit('heartbeat', {});
    old.open();
    old.fail();
    expect(invalidated).toEqual([]);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('[JOB-060] spreads the reconnect delay by 20% either way', () => {
    for (const [random, delay] of [
      [0, 800],
      [1, 1200],
    ] as const) {
      FakeEventSource.instances = [];
      const c = createLiveConnection({
        topics: ['quota'],
        random: () => random,
        onInvalidate: () => undefined,
        createEventSource: (url) => new FakeEventSource(url),
      });
      c.start();
      last().fail();
      vi.advanceTimersByTime(delay - 1);
      expect(FakeEventSource.instances).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(FakeEventSource.instances).toHaveLength(2);
      c.stop();
    }
  });
});
