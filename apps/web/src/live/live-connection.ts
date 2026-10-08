/**
 * The browser side of JOB-060, without React: one `EventSource` on `/api/v1/events`, reconnection
 * with backoff, and a polling fallback.
 *
 * - An event names the topics it concerns; the connection reports those the client asked for.
 * - If nothing arrives for `staleAfterMs` (45 s; the server sends a heartbeat every 15 s), or
 *   `EventSource` does not exist, the connection polls: it reports every topic each `pollEveryMs`
 *   (10 s). It keeps trying to reconnect, and returns to SSE after a successful reconnect (Q24).
 * - After any gap (a reconnect, a `resync` event) every topic is reported once, because events may
 *   have been missed.
 */

export type LiveMode = 'connecting' | 'sse' | 'polling';

/** The slice of `EventSource` used here, so that tests can substitute a fake. */
export interface EventSourceLike {
  onopen: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  addEventListener(type: string, listener: (event: { data?: string }) => void): void;
  close(): void;
}

export const DEFAULT_EVENTS_PATH = '/api/v1/events';
export const STALE_AFTER_MS = 45_000;
export const POLL_EVERY_MS = 10_000;
export const INITIAL_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 30_000;

export interface LiveConnectionOptions {
  readonly topics: readonly string[];
  /** Called with the subscribed topics that changed (or all of them after a gap or on a poll). */
  readonly onInvalidate: (topics: readonly string[]) => void;
  readonly onModeChange?: (mode: LiveMode) => void;
  readonly path?: string;
  /** Defaults to the global `EventSource`; `undefined` from it means "unavailable". */
  readonly createEventSource?: (url: string) => EventSourceLike | undefined;
  readonly staleAfterMs?: number;
  readonly pollEveryMs?: number;
  /** Randomness for the reconnect jitter (0 to 1). Default `Math.random`. */
  readonly random?: () => number;
}

export interface LiveConnection {
  start(): void;
  stop(): void;
  readonly mode: LiveMode;
}

/** The URL for a topic list. */
export function eventsUrl(topics: readonly string[], path: string = DEFAULT_EVENTS_PATH): string {
  return `${path}?topics=${topics.map(encodeURIComponent).join(',')}`;
}

function defaultCreateEventSource(url: string): EventSourceLike | undefined {
  const ctor = (globalThis as { EventSource?: new (url: string) => EventSourceLike }).EventSource;
  return ctor ? new ctor(url) : undefined;
}

export function createLiveConnection(options: LiveConnectionOptions): LiveConnection {
  const wanted = new Set(options.topics);
  const all = [...wanted];
  const create = options.createEventSource ?? defaultCreateEventSource;
  const staleAfter = options.staleAfterMs ?? STALE_AFTER_MS;
  const pollEvery = options.pollEveryMs ?? POLL_EVERY_MS;
  const random = options.random ?? Math.random;
  const url = eventsUrl(options.topics, options.path);

  let mode: LiveMode = 'connecting';
  let source: EventSourceLike | undefined;
  let stopped = true;
  let backoff = INITIAL_BACKOFF_MS;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let everOpened = false;

  const setMode = (next: LiveMode) => {
    if (mode === next) return;
    mode = next;
    options.onModeChange?.(next);
  };

  const armWatchdog = () => {
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      // Nothing, not even a heartbeat: the connection is dead. Poll, and keep trying to reconnect.
      closeSource();
      startPolling();
      scheduleReconnect();
    }, staleAfter);
  };

  function startPolling() {
    if (stopped) return;
    setMode('polling');
    if (poll === undefined) poll = setInterval(() => options.onInvalidate(all), pollEvery);
  }

  const stopPolling = () => {
    if (poll !== undefined) clearInterval(poll);
    poll = undefined;
  };

  const closeSource = () => {
    const current = source;
    source = undefined;
    if (current) {
      current.onopen = null;
      current.onerror = null;
      current.close();
    }
  };

  function scheduleReconnect() {
    if (stopped || reconnect !== undefined) return;
    reconnect = setTimeout(
      () => {
        reconnect = undefined;
        connect();
      },
      backoff * (0.8 + random() * 0.4),
    ); // +-20%, so clients dropped together do not return together
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }

  function connect() {
    if (stopped) return;
    let next: EventSourceLike | undefined;
    try {
      next = create(url);
    } catch {
      next = undefined;
    }
    if (!next) {
      // No EventSource in this browser: poll for good.
      startPolling();
      return;
    }
    source = next;
    next.onopen = () => {
      if (source !== next) return;
      backoff = INITIAL_BACKOFF_MS;
      const wasDown = everOpened || mode === 'polling';
      everOpened = true;
      stopPolling();
      armWatchdog();
      setMode('sse');
      // A reconnect follows a gap in which events may have been missed.
      if (wasDown) options.onInvalidate(all);
    };
    next.onerror = () => {
      if (source !== next) return;
      closeSource();
      if (mode === 'sse') setMode('connecting');
      scheduleReconnect();
    };
    next.addEventListener('gm', (event) => {
      if (source !== next) return;
      armWatchdog();
      const matched = parseMatched(event.data, wanted);
      if (matched.length > 0) options.onInvalidate(matched);
    });
    next.addEventListener('resync', () => {
      if (source !== next) return;
      armWatchdog();
      options.onInvalidate(all);
    });
    next.addEventListener('heartbeat', () => {
      if (source !== next) return;
      armWatchdog();
    });
  }

  return {
    get mode() {
      return mode;
    },
    start() {
      if (!stopped) return;
      stopped = false;
      armWatchdog();
      connect();
    },
    stop() {
      stopped = true;
      if (watchdog !== undefined) clearTimeout(watchdog);
      if (reconnect !== undefined) clearTimeout(reconnect);
      watchdog = undefined;
      reconnect = undefined;
      stopPolling();
      closeSource();
    },
  };
}

function parseMatched(data: string | undefined, wanted: ReadonlySet<string>): string[] {
  if (data === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(data);
    const topics = (parsed as { topics?: unknown } | null)?.topics;
    if (!Array.isArray(topics)) return [];
    return topics.filter((t): t is string => typeof t === 'string' && wanted.has(t));
  } catch {
    return [];
  }
}
