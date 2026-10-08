/**
 * PLACEHOLDER (T-002). A heartbeat loop so `pnpm dev` keeps the worker process running until the
 * real worker runtime lands (T-028). Replace this file with the real worker entrypoint; keep the
 * `dev` script and the `--role` flag so `pnpm dev` and Compose keep working.
 */
import { setTimeout as sleep } from 'node:timers/promises';

export interface HeartbeatOptions {
  role: string;
  intervalMs: number;
  signal: AbortSignal;
  log: (line: string) => void;
}

/** Logs one JSON line per interval until the signal aborts. */
export async function runHeartbeat({
  role,
  intervalMs,
  signal,
  log,
}: HeartbeatOptions): Promise<void> {
  while (!signal.aborted) {
    log(
      JSON.stringify({ msg: 'worker placeholder heartbeat', role, ts: new Date().toISOString() }),
    );
    try {
      await sleep(intervalMs, undefined, { signal });
    } catch {
      return; // aborted while sleeping
    }
  }
}

/** Reads `--role <value>` from argv; defaults to `all`, as the devenv and Compose commands pass it. */
export function parseRole(argv: readonly string[]): string {
  const index = argv.indexOf('--role');
  const value = index === -1 ? undefined : argv[index + 1];
  return value ?? 'all';
}

if (import.meta.main) {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await runHeartbeat({
    role: parseRole(process.argv.slice(2)),
    intervalMs: 10_000,
    signal: controller.signal,
    log: (line) => console.log(line),
  });
}
