import type { FacetDriver } from '@git-migrator/adapter-sdk';
import { describe, expect, it } from 'vitest';
import { setup } from './harness.test.ts';

describe('raw capture and secret hygiene', () => {
  it('[ADP-061] facet reads capture raw responses and return their ids', async () => {
    const h = await setup();
    h.fake.state.addRepository('acme', { name: 'r', private: true, files: { 'a.txt': 'a' } });
    const d = h.conn.facets['repository-settings'] as FacetDriver<unknown>;
    const read = await d.read(h.ctx, h.target('r'));
    expect(read.rawResponseIds.length).toBeGreaterThanOrEqual(2);
    expect(read.rawResponseIds[0]).toMatch(/^raw-/);
  });

  it('[ADP-061] no capture, request, or error ever holds the installation token or the private key', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', {
      name: 'r',
      private: true,
      files: { 'a.txt': 'a' },
    });
    h.fake.state.addHook(repo, { url: 'https://ci.example.test/h', secret: 'hook-secret-value' });
    for (const key of ['webhooks', 'access-control', 'branch-rules', 'deploy-keys'] as const) {
      await (h.conn.facets[key] as FacetDriver<unknown>).read(h.ctx, h.target('r'));
    }
    const cred = await h.conn.git.credential(h.repo('r'));
    const everything = JSON.stringify(h.captured);
    expect(h.captured.length).toBeGreaterThan(0);
    expect(everything).not.toContain(cred.password);
    expect(everything).not.toContain('PRIVATE KEY');
    expect(everything).not.toContain('hook-secret-value');
    for (const c of h.captured) expect(c.headers.authorization).toBeUndefined();
    let message = '';
    try {
      await h.conn.inventory.listRepositories({ providerId: '', slug: 'acme' }, '1').then(() => {
        throw new Error('ok');
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain(cred.password);
  });

  it('[TST-006] the client refuses hosts outside the test allowlist', async () => {
    const h = await setup();
    await expect(
      h.ctx.http.request({ path: 'https://api.github.com/orgs/acme' }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('[ADP-060] a configuration with the App not configured is refused at connect', async () => {
    await expect(setup({ connect: { appId: 0 } })).rejects.toMatchObject({ code: 'invalid' });
  });
});
