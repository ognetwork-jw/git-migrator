import { type ChildProcess, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { createLogger } from '@git-migrator/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LeaderElection } from './leader.ts';

const log = createLogger({ level: 'silent' });
let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t028l_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

const until = async (check: () => boolean, ms = 20_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

function election(lockName: string, events: string[], name: string, intervalMs = 100) {
  return new LeaderElection({
    connectionString: t.connectionString,
    lockName,
    log,
    intervalMs,
    onElected: () => void events.push(`${name}:elected`),
    onLost: () => void events.push(`${name}:lost`),
  });
}

describe('scheduler leader election', () => {
  it('[ARC-023] elects exactly one of two contenders', async () => {
    const events: string[] = [];
    const a = election('t-one', events, 'a');
    const b = election('t-one', events, 'b');
    await a.start();
    await b.start();
    expect([a.isLeader, b.isLeader].filter(Boolean)).toHaveLength(1);
    expect(events.filter((e) => e.endsWith(':elected'))).toHaveLength(1);
    await Promise.all([a.stop(), b.stop()]);
    expect(a.isLeader || b.isLeader).toBe(false);
  }, 60_000);

  it('[ARC-023] hands leadership to the follower when the leader stops', async () => {
    const events: string[] = [];
    const a = election('t-handover', events, 'a');
    const b = election('t-handover', events, 'b');
    await a.start();
    await b.start();
    expect(a.isLeader).toBe(true);
    await a.stop();
    await until(() => b.isLeader);
    expect(events).toEqual(['a:elected', 'a:lost', 'b:elected']);
    await b.stop();
  }, 60_000);

  it('[ARC-023] takes over when the leader connection is killed', async () => {
    const events: string[] = [];
    const a = election('t-kill', events, 'a');
    const b = election('t-kill', events, 'b');
    await a.start();
    await b.start();
    await t.db.pool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'git-migrator-leader' AND pid <> pg_backend_pid() AND datname = current_database() AND state = 'idle'",
    );
    await until(() => b.isLeader || a.isLeader);
    await until(() => events.filter((e) => e.endsWith(':elected')).length === 2);
    expect([a.isLeader, b.isLeader].filter(Boolean)).toHaveLength(1);
    await Promise.all([a.stop(), b.stop()]);
  }, 60_000);

  it('[ARC-023] the server drops a leader session that stopped pinging, freeing the lock', async () => {
    const events: string[] = [];
    // A 60 s ping interval with a 1 s idle timeout stands in for a leader whose node vanished.
    const zombie = new LeaderElection({
      connectionString: t.connectionString,
      lockName: 't-zombie',
      log,
      intervalMs: 60_000,
      idleSessionTimeoutMs: 1_000,
      onElected: () => void events.push('zombie:elected'),
      onLost: () => void events.push('zombie:lost'),
    });
    await zombie.start();
    expect(zombie.isLeader).toBe(true);
    const follower = election('t-zombie', events, 'follower');
    await follower.start();
    expect(follower.isLeader).toBe(false);
    await until(() => !zombie.isLeader, 10_000);
    await until(() => follower.isLeader, 10_000);
    await Promise.all([zombie.stop(), follower.stop()]);
  }, 60_000);

  it('[ARC-023] keeps following when the election hook fails to start the leader', async () => {
    const events: string[] = [];
    const bad = new LeaderElection({
      connectionString: t.connectionString,
      lockName: 't-hook',
      log,
      intervalMs: 100,
      onElected: () => {
        throw new Error('scheduler failed');
      },
      onLost: () => void events.push('lost'),
    });
    await bad.start();
    expect(bad.isLeader).toBe(false);
    expect(events).toEqual(['lost']);
    await bad.stop();
  }, 60_000);

  it('[ARC-023] two processes elect one leader, and the other takes over when it dies', async () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), 'leader.child.ts');
    const children: ChildProcess[] = [];
    const output = new Map<ChildProcess, string>();
    const start = (): ChildProcess => {
      const child = spawn('node', [script, 't-processes'], {
        env: { ...process.env, GM_TEST_CONNECTION: t.connectionString },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      output.set(child, '');
      child.stdout?.on('data', (chunk: Buffer) =>
        output.set(child, (output.get(child) ?? '') + chunk.toString()),
      );
      children.push(child);
      return child;
    };
    const text = (child: ChildProcess): string => output.get(child) ?? '';
    try {
      const first = start();
      await until(() => text(first).includes('STARTED'));
      const second = start();
      await until(() => text(second).includes('STARTED'));
      const leaders = children.filter((c) => text(c).includes('ELECTED'));
      expect(leaders).toHaveLength(1);
      const leader = leaders[0] as ChildProcess;
      const follower = children.find((c) => c !== leader) as ChildProcess;
      leader.kill('SIGKILL');
      await until(() => text(follower).includes('ELECTED'));
    } finally {
      for (const child of children) child.kill('SIGKILL');
    }
  }, 60_000);
});
