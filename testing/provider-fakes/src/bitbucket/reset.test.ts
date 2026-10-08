import { describe, expect, it } from 'vitest';
import { createFakeBitbucket } from './app.ts';

const AUTH = `Basic ${Buffer.from('operator@test.local:fake-bitbucket-api-token').toString('base64')}`;

function gate() {
  let open: () => void = () => {};
  let fail: (e: Error) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

const get = (fake: ReturnType<typeof createFakeBitbucket>, path: string) =>
  fake.app.request(path, { headers: { Authorization: AUTH } });

describe('async fixture builders (ADR-0130)', () => {
  it('[TST-012] a sync fixture still resets synchronously', () => {
    const fake = createFakeBitbucket({
      fixtures: { w: (s) => void s.addWorkspace({ slug: 'acme' }) },
    });
    expect(fake.reset('w')).toBeUndefined();
    expect(fake.state.workspace('acme')).toBeDefined();
  });

  it('[TST-012] answers exactly 503 on REST and /__state while an async reset is pending, the control plane keeps working', async () => {
    const g = gate();
    const fake = createFakeBitbucket({
      fixtures: {
        w: async (s) => {
          s.addWorkspace({ slug: 'acme' });
          await g.promise;
        },
      },
    });
    const pending = fake.reset('w');
    expect(pending).toBeInstanceOf(Promise);
    expect((await get(fake, '/2.0/user')).status).toBe(503);
    expect((await get(fake, '/2.0/workspaces/acme')).status).toBe(503);
    expect((await get(fake, '/__state')).status).toBe(503);
    const config = await fake.app.request('/__config', { method: 'POST', body: '{}' });
    expect(config.status).toBe(200);
    g.open();
    await pending;
    expect((await get(fake, '/2.0/user')).status).toBe(200);
    expect((await get(fake, '/__state')).status).toBe(200);
  });

  it('[TST-012] queued resets run in call order and the last one wins', async () => {
    const g = gate();
    const order: string[] = [];
    const build = (name: string, wait?: Promise<void>) => async () => {
      order.push(`start ${name}`);
      await wait;
      order.push(`end ${name}`);
    };
    const fake = createFakeBitbucket({
      fixtures: {
        a: build('a', g.promise),
        b: build('b'),
        c: (s) => {
          order.push('c');
          s.addWorkspace({ slug: 'last' });
        },
      },
    });
    const p1 = fake.reset('a');
    const p2 = fake.reset('b');
    const p3 = fake.reset('c');
    expect(order).toEqual(['start a']);
    g.open();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'c']);
    expect(fake.state.data.fixture).toBe('c');
    expect(fake.state.workspace('last')).toBeDefined();
  });

  it('[TST-012] a rejecting builder keeps REST on 503 until the next successful reset, and queued resets still run', async () => {
    const g = gate();
    const fake = createFakeBitbucket({
      fixtures: {
        bad: async () => {
          await g.promise;
        },
        good: (s) => void s.addWorkspace({ slug: 'ok' }),
      },
    });
    const bad = fake.reset('bad');
    const queued = fake.reset('good');
    g.fail(new Error('seed failed'));
    await expect(bad).rejects.toThrow('seed failed');
    await queued;
    expect(fake.state.workspace('ok')).toBeDefined();
    expect((await get(fake, '/2.0/user')).status).toBe(200);

    const g2 = gate();
    const fake2 = createFakeBitbucket({
      fixtures: {
        bad: async () => {
          await g2.promise;
        },
        good: () => {},
      },
    });
    const failed = fake2.reset('bad');
    g2.fail(new Error('boom'));
    await expect(failed).rejects.toThrow('boom');
    expect((await get(fake2, '/2.0/user')).status).toBe(503);
    expect((await get(fake2, '/__state')).status).toBe(503);
    fake2.reset('good');
    expect((await get(fake2, '/2.0/user')).status).toBe(200);
  });
});
