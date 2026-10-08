import { type DomainEvent, topicsForEvent } from '@git-migrator/core';
import type { EventListener, FeedMessage } from '@git-migrator/db';

export interface EventHubOptions {
  /** The process's one `LISTEN gm_events` connection. The hub starts it on the first stream. */
  readonly listener: Pick<EventListener, 'start' | 'subscribe' | 'connected'> & {
    close?: () => Promise<void>;
  };
  /** Heartbeat interval (JOB-060: 15 s). */
  readonly heartbeatMs?: number;
  /**
   * Frames a client may have queued. Past that the queue is replaced by one `resync` frame and the
   * client keeps its stream. Default 64.
   */
  readonly maxQueuedFrames?: number;
  /** Heartbeat ticks with unread frames and no read at all before a client is dropped. Default 4. */
  readonly maxIdleTicks?: number;
  /**
   * A stream ends after about this long (spread by +-20%), so the client reconnects and is
   * authenticated again. Default 10 min.
   */
  readonly maxStreamMs?: number;
  /** Most simultaneous streams in this process. Default 2,000. */
  readonly maxStreams?: number;
  /** Most simultaneous streams of one Actor. Default 16. */
  readonly maxStreamsPerOwner?: number;
  /** Randomness for the lifetime spread (0 to 1). Default `Math.random`. */
  readonly random?: () => number;
  /** Shortest gap between two `run.log` events for one Run (JOB-060: 4 per second). */
  readonly logIntervalMs?: number;
  /** Told when a client is dropped for being too slow. */
  readonly onSlowClient?: () => void;
}

export interface EventStreamRequest {
  readonly topics: readonly string[];
  /** Whose stream this is (the Actor id): the per-Actor limit and `closeOwner` use it. */
  readonly owner: string;
  /** Aborted when the HTTP client goes away. */
  readonly signal?: AbortSignal;
}

export interface EventHub {
  /**
   * An SSE body for `topics`, or `undefined` when the process or the owner is at its stream limit. The stream is
   * cleaned up when the client cancels, the signal aborts, the lifetime ends or the client is dropped.
   */
  stream(request: EventStreamRequest): ReadableStream<Uint8Array> | undefined;
  readonly clientCount: number;
  /** Ends every stream of `owner` (a disabled Actor, a revoked key). Returns how many. */
  closeOwner(owner: string): number;
  close(): Promise<void>;
}

const encoder = new TextEncoder();

/** SSE frames. The heartbeat is a comment plus a named event, because browsers hide comments from scripts. */
export const FRAMES = {
  open: encoder.encode('retry: 5000\n: connected\n\n'),
  heartbeat: encoder.encode(': heartbeat\n\nevent: heartbeat\ndata: {}\n\n'),
  resync: encoder.encode('event: resync\ndata: {}\n\n'),
} as const;

function eventFrame(event: DomainEvent, topics: readonly string[]): Uint8Array {
  return encoder.encode(`event: gm\ndata: ${JSON.stringify({ ...event, topics })}\n\n`);
}

interface Client {
  readonly owner: string;
  readonly topics: ReadonlySet<string>;
  readonly send: (frame: Uint8Array) => void;
  /** Ends the stream cleanly; the client's `EventSource` reconnects. */
  readonly end: () => void;
}

interface LogWindow {
  last: number;
  pending?: DomainEvent;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Fan-out of the listener's events to SSE clients (JOB-060). Per client the hub keeps at most
 * `maxQueuedFrames` unread frames and drops a client that falls behind: the client reconnects and
 * refetches, which costs less than growing memory for it. `run.log` events are coalesced to one per
 * `logIntervalMs` per Run before fan-out.
 */
export function createEventHub(options: EventHubOptions): EventHub {
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const maxQueued = options.maxQueuedFrames ?? 64;
  const maxStreamMs = options.maxStreamMs ?? 10 * 60_000;
  const perOwner = new Map<string, number>();
  const maxStreams = options.maxStreams ?? 2000;
  const maxPerOwner = options.maxStreamsPerOwner ?? 16;
  const maxIdleTicks = options.maxIdleTicks ?? 4;
  const random = options.random ?? Math.random;
  const logInterval = options.logIntervalMs ?? 250;
  const clients = new Set<Client>();
  const logWindows = new Map<string, LogWindow>();
  let unsubscribe: (() => void) | undefined;
  let closed = false;

  const deliver = (event: DomainEvent) => {
    const topics = topicsForEvent(event);
    if (topics.length === 0) return;
    for (const client of [...clients]) {
      const matched = topics.filter((t) => client.topics.has(t));
      if (matched.length > 0) client.send(eventFrame(event, matched));
    }
  };

  const armLogWindow = (key: string, window: LogWindow) => {
    window.timer = setTimeout(() => {
      const pending = window.pending;
      if (pending === undefined) {
        logWindows.delete(key);
        return;
      }
      window.pending = undefined;
      window.last = Date.now();
      deliver(pending);
      armLogWindow(key, window);
    }, logInterval);
  };

  const onEvent = (event: DomainEvent) => {
    const run = event.ids.run;
    if (event.type !== 'run.log' || run === undefined) {
      deliver(event);
      return;
    }
    const existing = logWindows.get(run);
    if (existing) {
      existing.pending = event;
      return;
    }
    const window: LogWindow = { last: Date.now(), timer: undefined as never };
    logWindows.set(run, window);
    armLogWindow(run, window);
    deliver(event);
  };

  const onMessage = (message: FeedMessage) => {
    if (message.kind === 'event') onEvent(message.event);
    else for (const client of [...clients]) client.send(FRAMES.resync);
  };

  return {
    get clientCount() {
      return clients.size;
    },
    closeOwner(owner) {
      let count = 0;
      for (const client of [...clients]) {
        if (client.owner === owner) {
          client.end();
          count++;
        }
      }
      return count;
    },
    stream({ topics, owner, signal }) {
      if (closed || clients.size >= maxStreams || (perOwner.get(owner) ?? 0) >= maxPerOwner) {
        return undefined;
      }
      unsubscribe ??= options.listener.subscribe(onMessage);
      options.listener.start();
      perOwner.set(owner, (perOwner.get(owner) ?? 0) + 1);
      // Frames wait here until the consumer asks for them (pull). On overflow the queue is replaced
      // by a single resync, which tells the client to refetch everything it missed.
      const queue: Uint8Array[] = [FRAMES.open];
      let waiting: (() => void) | undefined;
      let readSinceTick = false;
      let idleTicks = 0;
      let finished = false;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let lifetime: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (finished) return;
        finished = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        if (lifetime !== undefined) clearTimeout(lifetime);
        signal?.removeEventListener('abort', onAbort);
        clients.delete(client);
        const left = (perOwner.get(owner) ?? 1) - 1;
        if (left <= 0) perOwner.delete(owner);
        else perOwner.set(owner, left);
      };
      const client: Client = {
        owner,
        topics: new Set(topics),
        send: (frame) => {
          if (finished) return;
          if (waiting) {
            const wake = waiting;
            waiting = undefined;
            controller.enqueue(frame);
            wake();
            return;
          }
          if (queue.length >= maxQueued) {
            queue.length = 0;
            queue.push(FRAMES.resync);
            return;
          }
          queue.push(frame);
        },
        end: () => {
          if (finished) return;
          cleanup();
          queue.length = 0;
          waiting?.();
          waiting = undefined;
          try {
            controller.close();
          } catch {
            // Already closed or errored.
          }
        },
      };
      function onAbort() {
        client.end();
      }
      const tick = () => {
        // A consumer that reads nothing for several ticks while frames wait is not coming back.
        if (queue.length > 0 && !readSinceTick) idleTicks++;
        else idleTicks = 0;
        readSinceTick = false;
        if (idleTicks >= maxIdleTicks) {
          cleanup();
          queue.length = 0;
          options.onSlowClient?.();
          controller.error(new Error('slow client dropped'));
          return;
        }
        // No heartbeat while the listener is down: the stream may be missing events, and the
        // client's watchdog then falls back to polling. A resync follows the reconnect.
        if (options.listener.connected) client.send(FRAMES.heartbeat);
      };
      const body = new ReadableStream<Uint8Array>(
        {
          start(c) {
            controller = c;
            heartbeat = setInterval(tick, heartbeatMs);
            lifetime = setTimeout(() => client.end(), maxStreamMs * (0.8 + random() * 0.4));
            signal?.addEventListener('abort', onAbort, { once: true });
            clients.add(client);
            if (signal?.aborted) onAbort();
          },
          pull(c) {
            readSinceTick = true;
            const frame = queue.shift();
            if (frame) {
              c.enqueue(frame);
              return undefined;
            }
            return new Promise<void>((resolve) => {
              waiting = resolve;
            });
          },
          cancel() {
            cleanup();
            queue.length = 0;
          },
        },
        new CountQueuingStrategy({ highWaterMark: 0 }),
      );
      return body;
    },
    async close() {
      closed = true;
      unsubscribe?.();
      unsubscribe = undefined;
      for (const window of logWindows.values()) clearTimeout(window.timer);
      logWindows.clear();
      // Ending the streams makes each client reconnect to a process that is still up.
      for (const client of [...clients]) client.end();
      await options.listener.close?.();
    },
  };
}
