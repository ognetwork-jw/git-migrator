import { describe, expect, it } from 'vitest';
import { parseRole, runHeartbeat } from './dev-worker.ts';

describe('worker placeholder heartbeat', () => {
  it('[DEV-040] logs one JSON heartbeat per interval until aborted', async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    await runHeartbeat({
      role: 'all',
      intervalMs: 5,
      signal: controller.signal,
      log: (line) => lines.push(line),
    });
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ msg: 'worker placeholder heartbeat', role: 'all' });
    }
  });

  it('[DEV-040] returns immediately when the signal is already aborted', async () => {
    const lines: string[] = [];
    const controller = new AbortController();
    controller.abort();
    await runHeartbeat({
      role: 'all',
      intervalMs: 5,
      signal: controller.signal,
      log: (l) => lines.push(l),
    });
    expect(lines).toEqual([]);
  });

  it('[DEV-040] reads --role and defaults to all', () => {
    expect(parseRole(['--role', 'standard'])).toBe('standard');
    expect(parseRole([])).toBe('all');
    expect(parseRole(['--role'])).toBe('all');
  });
});
