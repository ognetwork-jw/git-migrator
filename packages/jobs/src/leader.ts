import type { Logger } from '@git-migrator/observability';
import pg from 'pg';

/** Name hashed into the advisory lock key, namespaced so other lock users cannot collide. */
export const LEADER_LOCK_NAME = 'gm-scheduler-leader';

export interface LeaderElectionOptions {
  readonly connectionString: string;
  readonly log: Logger;
  /** Called once each time this process becomes the scheduler leader. */
  readonly onElected: () => Promise<void> | void;
  /** Called when leadership is lost (connection dropped) or released. */
  readonly onLost: () => Promise<void> | void;
  /** How often a follower retries, and how often the leader checks its connection. Default 5 s. */
  readonly intervalMs?: number;
  /** Lock name override, for tests that run several elections side by side. */
  readonly lockName?: string;
  /**
   * The server drops the leader's session when it has been idle this long, so a zombie lock
   * (node or network loss without a FIN) is released by the server. Default: 6 intervals, at
   * least 30 s. The leader pings every interval, so a healthy session is never idle that long.
   */
  readonly idleSessionTimeoutMs?: number;
}

/**
 * Scheduler leader election through a session-level Postgres advisory lock (ARC-020, ARC-023):
 * `pg_try_advisory_lock` on a dedicated connection, so at most one process holds it. The lock is
 * released by the server when the connection ends, so a crashed leader is replaced within one
 * retry interval. If the leader's node or network vanishes without closing the socket, the lock
 * would otherwise stay until TCP gives up (hours): the lock session therefore sets
 * `idle_session_timeout` (the server ends a session that stopped pinging) and short TCP keepalives,
 * so a follower takes over in about a minute. The leader pings every interval with a query timeout
 * of two intervals and gives up leadership when the ping fails or hangs.
 */
export class LeaderElection {
  readonly #options: LeaderElectionOptions;
  readonly #intervalMs: number;
  #client: pg.Client | undefined;
  #timer: NodeJS.Timeout | undefined;
  #leader = false;
  #stopped = false;
  #busy = false;

  constructor(options: LeaderElectionOptions) {
    this.#options = options;
    this.#intervalMs = options.intervalMs ?? 5_000;
  }

  get isLeader(): boolean {
    return this.#leader;
  }

  /** Starts electing. Resolves after the first attempt, so a lone process is leader on return. */
  async start(): Promise<void> {
    await this.#tick();
    if (this.#stopped) return;
    this.#timer = setInterval(() => void this.#tick(), this.#intervalMs);
    this.#timer.unref();
  }

  async #tick(): Promise<void> {
    if (this.#busy || this.#stopped) return;
    this.#busy = true;
    try {
      if (this.#leader) await this.#check();
      else await this.#attempt();
    } finally {
      this.#busy = false;
    }
  }

  async #attempt(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.#options.connectionString,
      application_name: 'git-migrator-leader',
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      // A ping that hangs (network loss) fails after two intervals instead of never.
      query_timeout: this.#intervalMs * 2,
      connectionTimeoutMillis: Math.max(this.#intervalMs * 2, 5_000),
    });
    // Without a listener a connection error would crash the process.
    client.on('error', () => undefined);
    try {
      await client.connect();
      const idleMs = this.#options.idleSessionTimeoutMs ?? Math.max(30_000, this.#intervalMs * 6);
      await client.query(`SET idle_session_timeout = ${Math.trunc(idleMs)}`);
      await client.query('SET tcp_keepalives_idle = 10');
      await client.query('SET tcp_keepalives_interval = 5');
      await client.query('SET tcp_keepalives_count = 3');
      const result = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [this.#options.lockName ?? LEADER_LOCK_NAME],
      );
      if (!result.rows[0]?.locked || this.#stopped) {
        await client.end().catch(() => undefined);
        return;
      }
    } catch (error) {
      this.#options.log.warn({ err: error }, 'leader election attempt failed');
      await client.end().catch(() => undefined);
      return;
    }
    this.#client = client;
    this.#leader = true;
    client.on('end', () => void this.#lose('connection ended'));
    this.#options.log.info('elected scheduler leader');
    try {
      await this.#options.onElected();
    } catch (error) {
      this.#options.log.error({ err: error }, 'leader start-up failed; releasing leadership');
      await this.#lose('start-up failed');
    }
  }

  async #check(): Promise<void> {
    try {
      await this.#client?.query('SELECT 1');
    } catch {
      await this.#lose('connection check failed');
    }
  }

  async #lose(reason: string): Promise<void> {
    if (!this.#leader) return;
    this.#leader = false;
    const client = this.#client;
    this.#client = undefined;
    this.#options.log.warn({ reason }, 'scheduler leadership lost');
    if (client) await closeQuietly(client);
    try {
      await this.#options.onLost();
    } catch (error) {
      this.#options.log.error({ err: error }, 'leader shutdown hook failed');
    }
  }

  /** Stops electing and, if leader, releases the lock so another process can take over. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    while (this.#busy) await new Promise((resolve) => setTimeout(resolve, 10));
    await this.#lose('stopped');
  }
}

/** Ends a client without waiting for a dead socket: after one second the socket is destroyed. */
async function closeQuietly(client: pg.Client): Promise<void> {
  const timer = setTimeout(() => {
    (
      client as unknown as { connection?: { stream?: { destroy(): void } } }
    ).connection?.stream?.destroy();
  }, 1_000);
  try {
    await client.end();
  } catch {
    // already gone
  } finally {
    clearTimeout(timer);
  }
}
