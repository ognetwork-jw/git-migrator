import type { Logger } from '@git-migrator/observability';
import pg from 'pg';

export interface WaitForDatabaseOptions {
  readonly connectionString: string;
  readonly log: Logger;
  /** Give up after this long. Default 3 minutes. */
  readonly timeoutMs?: number;
  /** First retry delay, doubled up to `maxDelayMs`. Default 1 s. */
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Wait for ever (development loops); the log line then appears every 30 s, not every attempt. */
  readonly indefinite?: boolean;
  /** Aborts the wait: the call rejects with the abort reason. */
  readonly signal?: AbortSignal;
}

/** Why the last attempt failed, without the connection string or the error stack. */
function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.name : 'unknown error';
}

/**
 * Waits until the database accepts connections and `migrate` has created the `app` and `bullmq`
 * schemas, with bounded exponential backoff (1 s up to 10 s). A worker started before Postgres or
 * before `pnpm db:migrate` (`pnpm dev`, Compose, a rolling start) waits and logs instead of dying
 * with an uncaught error that `node --watch` would never restart. After the timeout it throws one
 * error naming the last reason.
 */
export async function waitForDatabase(options: WaitForDatabaseOptions): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 180_000);
  const maxDelay = options.maxDelayMs ?? 10_000;
  let delay = options.initialDelayMs ?? 1_000;
  let lastLogged = 0;
  for (let attempt = 1; ; attempt += 1) {
    options.signal?.throwIfAborted();
    let reason: string;
    const client = new pg.Client({
      connectionString: options.connectionString,
      connectionTimeoutMillis: 5_000,
    });
    client.on('error', () => undefined);
    try {
      await client.connect();
      const result = await client.query<{ ready: boolean }>(
        `SELECT to_regclass('app.run') IS NOT NULL AND to_regclass('bullmq.job') IS NOT NULL AS ready`,
      );
      if (result.rows[0]?.ready) return;
      reason = 'schema not migrated (run `pnpm db:migrate`)';
    } catch (error) {
      reason = `database unreachable (${reasonOf(error)})`;
    } finally {
      await client.end().catch(() => undefined);
    }
    if (!options.indefinite && Date.now() + delay > deadline) {
      throw new Error(`The database is not ready: ${reason}`);
    }
    if (!options.indefinite || Date.now() - lastLogged >= 30_000) {
      lastLogged = Date.now();
      options.log.warn({ attempt, retryInMs: delay }, `waiting for the database: ${reason}`);
    }
    await sleep(delay, options.signal);
    delay = Math.min(delay * 2, maxDelay);
  }
}

/** A sleep that ends early, rejecting, when the signal aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
