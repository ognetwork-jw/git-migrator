import { type DomainEvent, decodeEvent, EVENT_CHANNEL, encodeEvent } from '@git-migrator/core';
import pg from 'pg';
import type { Db } from './client.ts';

/** Anything that runs a parameterized query: a `pg.Pool`, a `pg.PoolClient` or a `pg.Client`. */
export interface QueryExecutor {
  query(text: string, values: unknown[]): Promise<unknown>;
}

/**
 * Publishes a domain event with `NOTIFY gm_events` (JOB-060). Workers and API handlers call this
 * after committing a change. On a client inside a transaction the notification is delivered when
 * the transaction commits, and dropped if it rolls back. Throws `EventEncodingError` for an
 * invalid or oversized event.
 */
export async function publishEvent(executor: QueryExecutor, event: DomainEvent): Promise<void> {
  await executor.query('select pg_notify($1, $2)', [EVENT_CHANNEL, encodeEvent(event)]);
}

/** Like `publishEvent`, inside a ZenStack transaction: delivered only if the transaction commits. */
export async function publishEventIn(tx: Pick<Db, '$queryRaw'>, event: DomainEvent): Promise<void> {
  const payload = encodeEvent(event);
  await tx.$queryRaw`select pg_notify(${EVENT_CHANNEL}, ${payload})`;
}

/** What the listener tells its subscribers. */
export type FeedMessage =
  /** A domain event. */
  | { readonly kind: 'event'; readonly event: DomainEvent }
  /** The connection was lost and re-established: events may have been missed, refetch everything. */
  | { readonly kind: 'resync' };

/** The slice of `pg.Client` the listener uses; tests substitute a fake. */
export interface ListenClient {
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
  on(
    event: 'notification',
    listener: (message: { channel: string; payload?: string }) => void,
  ): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'end', listener: () => void): this;
}

export interface EventListenerOptions {
  /** Creates a fresh dedicated connection. See `pgListenClient`. */
  readonly createClient: () => ListenClient;
  /** First reconnect delay; it doubles up to `maxBackoffMs`. Default 500 ms. */
  readonly initialBackoffMs?: number;
  /** Default 30,000 ms. */
  readonly maxBackoffMs?: number;
  /** Longest a connect plus `LISTEN` may take before it counts as failed. Default 10,000 ms. */
  readonly connectTimeoutMs?: number;
  /** Gap between liveness probes (`select 1`) on the connection. Default 30,000 ms. */
  readonly probeIntervalMs?: number;
  /** Longest a probe may take before the connection counts as lost. Default 10,000 ms. */
  readonly probeTimeoutMs?: number;
  /** Reports connection problems. Carries no error text, which could hold connection details. */
  readonly onProblem?: (
    what: 'connect_failed' | 'connection_lost' | 'probe_failed' | 'bad_payload',
  ) => void;
}

export interface EventListener {
  /** Opens the dedicated connection and issues `LISTEN gm_events`. Never rejects; it retries. */
  start(): void;
  subscribe(listener: (message: FeedMessage) => void): () => void;
  readonly connected: boolean;
  /** Stops listening and closes the connection. */
  close(): Promise<void>;
}

/**
 * One dedicated `LISTEN gm_events` connection per process (JOB-060), fanned out to any number of
 * subscribers. A lost connection is re-established with exponential backoff, and subscribers
 * receive a `resync` message once it is back, because notifications sent meanwhile are gone.
 */
export function createEventListener(options: EventListenerOptions): EventListener {
  const subscribers = new Set<(message: FeedMessage) => void>();
  const initial = options.initialBackoffMs ?? 500;
  const max = options.maxBackoffMs ?? 30_000;
  let client: ListenClient | undefined;
  let connected = false;
  let started = false;
  let closed = false;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  const connectTimeout = options.connectTimeoutMs ?? 10_000;
  const probeInterval = options.probeIntervalMs ?? 30_000;
  const probeTimeout = options.probeTimeoutMs ?? 10_000;
  let backoff = initial;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const emit = (message: FeedMessage) => {
    for (const subscriber of [...subscribers]) {
      try {
        subscriber(message);
      } catch {
        // One subscriber's failure must not stop the others.
      }
    }
  };

  function schedule() {
    if (closed || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void connect();
    }, backoff);
    backoff = Math.min(backoff * 2, max);
  }

  const lost = (
    from: ListenClient,
    what: 'connection_lost' | 'probe_failed' = 'connection_lost',
  ) => {
    if (client !== from) return;
    client = undefined;
    connected = false;
    if (probeTimer !== undefined) clearTimeout(probeTimer);
    probeTimer = undefined;
    from.end().catch(() => undefined);
    if (closed) return;
    options.onProblem?.(what);
    schedule();
  };

  /** A half-open connection raises no error; only a query that gets no answer reveals it. */
  const scheduleProbe = (from: ListenClient) => {
    probeTimer = setTimeout(() => {
      probeTimer = undefined;
      withTimeout(from.query('select 1'), probeTimeout).then(
        () => {
          if (client === from) scheduleProbe(from);
        },
        () => lost(from, 'probe_failed'),
      );
    }, probeInterval);
  };

  async function connect(): Promise<void> {
    if (closed || client) return;
    const next = options.createClient();
    client = next;
    next.on('error', () => lost(next));
    next.on('end', () => lost(next));
    next.on('notification', (message) => {
      if (message.channel !== EVENT_CHANNEL || message.payload === undefined) return;
      const event = decodeEvent(message.payload);
      if (event) emit({ kind: 'event', event });
      else options.onProblem?.('bad_payload');
    });
    try {
      await withTimeout(
        next.connect().then(() => next.query(`LISTEN ${EVENT_CHANNEL}`)),
        connectTimeout,
      );
    } catch {
      if (client === next) {
        client = undefined;
        next.end().catch(() => undefined);
        options.onProblem?.('connect_failed');
        schedule();
      }
      return;
    }
    if (closed || client !== next) {
      next.end().catch(() => undefined);
      return;
    }
    connected = true;
    backoff = initial;
    scheduleProbe(next);
    // Notifications sent while there was no connection are gone, and a first connection can also
    // follow failed attempts: subscribers refetch after every successful connect.
    emit({ kind: 'resync' });
  }

  return {
    start() {
      if (started || closed) return;
      started = true;
      void connect();
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    get connected() {
      return connected;
    },
    async close() {
      closed = true;
      connected = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (probeTimer !== undefined) clearTimeout(probeTimer);
      probeTimer = undefined;
      subscribers.clear();
      const current = client;
      client = undefined;
      await current?.end().catch(() => undefined);
    },
  };
}

/**
 * Creates dedicated connections with the pool's settings (host, credentials, TLS), so the
 * listener follows the same configuration as the rest of the process (DATA-010). The connection
 * is outside the pool and does not count against `poolMax`.
 */
export function pgListenClient(pool: pg.Pool): () => ListenClient {
  return () =>
    new pg.Client({
      ...pool.options,
      // A dead peer (a failover, a dropped route) sends no FIN: TCP keepalive finds it, and the
      // connect timeout bounds a handshake that never completes.
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    }) as unknown as ListenClient;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
