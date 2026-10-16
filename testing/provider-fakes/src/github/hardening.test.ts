import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FakeGitHub } from './app.ts';
import { must, world } from './harness.ts';

const OID = 'c'.repeat(64);

describe('hardening', () => {
  it('[TST-011] restricted installation tokens always carry metadata: read', async () => {
    const w = world();
    const token = w.fake.token({ permissions: { contents: 'read' } });
    expect(w.fake.state.tokens.get(token)?.permissions).toEqual({
      contents: 'read',
      metadata: 'read',
    });
    expect((await w.call('GET', '/repos/acme/auto-ok', { token })).status).toBe(200);
  });

  it('[TST-011] a duplicate webhook url in the same scope is 422, in another scope fine', async () => {
    const w = world();
    const body = { config: { url: 'https://example.test/h' } };
    expect((await w.call('POST', '/repos/acme/auto-ok/hooks', { body })).status).toBe(201);
    const dup = await w.call('POST', '/repos/acme/auto-ok/hooks', { body });
    expect(dup.status).toBe(422);
    expect(JSON.stringify(dup.body.errors)).toContain('Hook already exists on this repository');
    expect((await w.call('POST', '/repos/acme/empty/hooks', { body })).status).toBe(201);
    expect((await w.call('POST', '/orgs/acme/hooks', { body })).status).toBe(201);
    const orgDup = await w.call('POST', '/orgs/acme/hooks', { body });
    expect(JSON.stringify(orgDup.body.errors)).toContain('this organization');
  });

  it('[TST-011] cancelling and re-inviting does not reset the 24 h invitation count', async () => {
    let now = Date.parse('2026-10-08T00:00:00Z');
    const w = world({ clock: () => now });
    const org = w.fake.state.requireOrg('acme');
    org.plan.name = 'free';
    org.createdAt = now - 3600_000;
    for (let i = 0; i < 49; i++) w.fake.state.invite(org, { email: `u${i}@test.local` });
    const last = await w.call('POST', '/orgs/acme/invitations', {
      body: { email: 'last@test.local' },
    });
    expect(last.status).toBe(201);
    await w.call('DELETE', `/orgs/acme/invitations/${last.body.id}`);
    for (const i of org.invitations.slice(0, 5))
      await w.call('DELETE', `/orgs/acme/invitations/${i.id}`);
    const over = await w.call('POST', '/orgs/acme/invitations', {
      body: { email: 'again@test.local' },
    });
    expect(over.status).toBe(422);
    expect(JSON.stringify(over.body.errors)).toContain('limit');
    now += 25 * 3600_000;
    expect(
      (
        await w.call('POST', '/orgs/acme/invitations', {
          body: { email: 'again@test.local' },
          token: w.fake.token(),
        })
      ).status,
    ).toBe(201);
  });

  it('[TST-011] duplicate invitations are 422 even with team_ids; an email of a member is 422', async () => {
    const w = world();
    const team = w.fake.state.addTeam('acme', { name: 'plat' });
    await w.call('POST', '/orgs/acme/invitations', { body: { email: 'x@test.local' } });
    const dup = await w.call('POST', '/orgs/acme/invitations', {
      body: { email: 'x@test.local', team_ids: [team.id] },
    });
    expect(dup.status).toBe(422);
    must(w.fake.state.findUser('bob')).email = 'bob@test.local';
    const member = await w.call('POST', '/orgs/acme/invitations', {
      body: { email: 'BOB@test.local' },
    });
    expect(member.status).toBe(422);
    expect(JSON.stringify(member.body.errors)).toContain('already a part');
    // adding a pending person to a second team still merges internally
    await w.call('PUT', '/orgs/acme/teams/plat/memberships/carol', { body: {} });
    const other = w.fake.state.addTeam('acme', { name: 'two' });
    await w.call('PUT', '/orgs/acme/teams/two/memberships/carol', { body: {} });
    expect(
      w.fake.state.requireOrg('acme').invitations.filter((i) => i.login === 'carol'),
    ).toHaveLength(1);
    expect(other.members.get('carol')?.state).toBe('pending');
  });

  it('[TST-011] LFS batch honours repository restrictions and the rate limiter, and sends x-ratelimit-* headers', async () => {
    const w = world({ config: { primary: { limits: { core: 2 } } } });
    const basic = (t: string) => `Basic ${Buffer.from(`x-access-token:${t}`).toString('base64')}`;
    const batch = (token: string) =>
      w.fake.app.request('/acme/auto-ok.git/info/lfs/objects/batch', {
        method: 'POST',
        headers: { authorization: basic(token) },
        body: JSON.stringify({ operation: 'download', objects: [{ oid: OID, size: 1 }] }),
      });
    const restricted = w.fake.token({ repositoryIds: [w.emptyRepo.id] });
    expect((await batch(restricted)).status).toBe(404);
    const ok = await batch(w.token);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-ratelimit-resource')).toBe('core');
    expect(ok.headers.get('x-ratelimit-remaining')).toBe('1');
    expect((await batch(w.token)).status).toBe(200);
    const limited = await batch(w.token);
    expect(limited.status).toBe(403);
    expect(limited.headers.get('x-ratelimit-remaining')).toBe('0');
  });

  it('[TST-011] a selected installation hides other repositories from the LFS batch API', async () => {
    const w = world();
    const inst = w.fake.state.addInstallation({
      account: 'acme',
      repositorySelection: 'selected',
      repositories: ['acme/empty'],
    });
    const token = w.fake.token({ installationId: inst.id });
    const res = await w.fake.app.request('/acme/auto-ok.git/info/lfs/objects/batch', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
      },
      body: JSON.stringify({ operation: 'download', objects: [] }),
    });
    expect(res.status).toBe(404);
  });

  it('[JOB-045] GraphQL query cost follows first/last: 100 nodes per point, mutations cost 1', async () => {
    const w = world();
    const q = (first: number) =>
      `{ repository(owner:"acme", name:"auto-ok") { branchProtectionRules(first: ${first}) { nodes { pushAllowances(first: 100) { totalCount } } } } rateLimit { cost nodeCount remaining } }`;
    const small = await w.call('POST', '/graphql', {
      body: { query: '{ rateLimit { cost nodeCount remaining } }' },
    });
    expect(small.body.data.rateLimit).toMatchObject({ cost: 1, nodeCount: 0 });
    const big = await w.call('POST', '/graphql', { body: { query: q(100) } });
    // 100 rules + 100 * 100 allowances = 10100 nodes -> 101 points
    expect(big.body.data.rateLimit).toMatchObject({ cost: 101, nodeCount: 10100 });
    expect(big.headers.get('x-ratelimit-used')).toBe('102');
    const viaVariable = await w.call('POST', '/graphql', {
      body: {
        query:
          'query($n: Int!) { repository(owner:"acme", name:"auto-ok") { branchProtectionRules(first: $n) { totalCount } } rateLimit { cost } }',
        variables: { n: 100 },
      },
    });
    expect(viaVariable.body.data.rateLimit.cost).toBe(1);
    const mutation = await w.call('POST', '/graphql', {
      body: {
        query: `mutation { createBranchProtectionRule(input:{repositoryId:"${w.repo.nodeId}", pattern:"x"}) { clientMutationId } }`,
      },
    });
    expect(mutation.headers.get('x-ratelimit-used')).toBe('104');
  });

  it('[TST-011] visibility internal needs an enterprise plan', async () => {
    const w = world();
    const create = await w.call('POST', '/orgs/acme/repos', {
      body: { name: 'int', visibility: 'internal' },
    });
    expect(create.status).toBe(422);
    expect(w.fake.state.findRepo('acme', 'int')).toBeUndefined();
    expect(
      (await w.call('PATCH', '/repos/acme/auto-ok', { body: { visibility: 'internal' } })).status,
    ).toBe(422);
    w.fake.state.requireOrg('acme').plan.name = 'enterprise';
    expect(
      (await w.call('POST', '/orgs/acme/repos', { body: { name: 'int', visibility: 'internal' } }))
        .status,
    ).toBe(201);
    expect((await w.call('GET', '/repos/acme/int')).body.visibility).toBe('internal');
  });

  it('[TST-011] a rejected PATCH changes nothing', async () => {
    const w = world();
    const res = await w.call('PATCH', '/repos/acme/auto-ok', {
      body: { name: 'renamed', description: 'x', default_branch: 'nope' },
    });
    expect(res.status).toBe(422);
    expect(w.repo.name).toBe('auto-ok');
    expect(w.repo.description).toBe('hello');
  });
});

describe('reset races', () => {
  it('[TST-011] a reset waits for in-flight requests, refuses new ones with 409 and leaves no stale writes', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const w = world({
      repositoryHooks: {
        created: async (r) => {
          calls.push(`created ${r.name}`);
          await gate;
        },
        deleted: (r) => void calls.push(`deleted ${r.name}`),
      },
    });
    calls.length = 0;
    const pending = w.call('POST', '/orgs/acme/repos', { body: { name: 'late' } });
    await new Promise((r) => setTimeout(r, 20));
    const reset = w.fake.reset();
    await new Promise((r) => setTimeout(r, 20));
    const refused = await w.call('POST', '/orgs/acme/repos', { body: { name: 'refused' } });
    expect(refused.status).toBe(409);
    // the control plane is refused too, except the reset itself
    expect((await w.fake.app.request('/__state')).status).toBe(409);
    expect((await w.fake.app.request('/__token', { method: 'POST' })).status).toBe(409);
    expect((await w.fake.app.request('/__config', { method: 'POST', body: '{}' })).status).toBe(
      409,
    );
    expect(w.fake.state.repos.has('acme/late')).toBe(true); // reset is still waiting
    release();
    expect((await pending).status).toBe(201);
    await reset;
    // The request finished in the old world, then the reset wiped it: record and bare repo together.
    expect(w.fake.state.repos.size).toBe(0);
    expect(calls).toEqual(['created late', 'deleted auto-ok', 'deleted empty', 'deleted late']);
    expect(
      (await w.call('POST', '/orgs/acme/repos', { body: { name: 'after' }, token: w.fake.token() }))
        .status,
    ).toBe(201);
  });

  it('[TST-011] the reset drain is bounded: a stalled request does not hang the reset', async () => {
    const w = world({
      resetDrainMs: 50,
      repositoryHooks: { created: () => new Promise<void>(() => {}) },
    });
    void w.call('POST', '/orgs/acme/repos', { body: { name: 'stuck' } });
    await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    await w.fake.reset();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(w.fake.state.repos.size).toBe(0);
    expect((await w.call('GET', '/__state', { token: null })).status).toBe(200);
  });
});

/** A request whose body is held back until `finish()`, so the request stays in flight. */
function stalledRequest(
  fake: FakeGitHub,
  method: string,
  path: string,
  token: string,
  body: string,
) {
  let finish: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      finish = () => {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      };
    },
  });
  const response = fake.app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: stream,
    duplex: 'half',
  } as RequestInit);
  return { response, finish: () => finish() };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('reset races beyond REST', () => {
  it('[TST-011] a straggler left behind by a timed-out drain does not make later resets wait for the bound', async () => {
    const w = world({ resetDrainMs: 300 });
    const stuck = stalledRequest(w.fake, 'POST', '/graphql', w.token, '{"query":"{ viewer }"}');
    await tick();
    await w.fake.reset(); // waits the full bound for the straggler
    const started = Date.now();
    await w.fake.reset();
    expect(Date.now() - started).toBeLessThan(250);
    stuck.finish();
    await stuck.response;
  });

  it('[TST-011] a GraphQL mutation that straddles a timed-out reset is a 409 and writes nothing into the new world', async () => {
    const w = world({
      resetDrainMs: 50,
      fixtures: {
        again: (s) => {
          s.addRepository('acme', { name: 'auto-ok', private: true, files: { 'a.txt': 'a' } });
        },
      },
    });
    const oldNodeId = w.repo.nodeId;
    const mutation = JSON.stringify({
      query:
        'mutation($input: CreateBranchProtectionRuleInput!) { createBranchProtectionRule(input: $input) { branchProtectionRule { id } } }',
      variables: { input: { repositoryId: oldNodeId, pattern: 'main' } },
    });
    const straggler = stalledRequest(w.fake, 'POST', '/graphql', w.token, mutation);
    await tick();
    await w.fake.reset('again');
    const fresh = must(w.fake.state.findRepo('acme', 'auto-ok'));
    expect(fresh.nodeId).toBe(oldNodeId); // deterministic ids: the stale write would land here
    straggler.finish();
    expect((await straggler.response).status).toBe(409);
    expect(fresh.rules).toEqual([]);
  });

  it('[TST-011] an LFS upload that straddles a timed-out reset is a 409', async () => {
    const w = world({
      resetDrainMs: 50,
      fixtures: { again: (s) => void s.addRepository('acme', { name: 'auto-ok', private: true }) },
    });
    const content = 'lfs object';
    const oid = createHash('sha256').update(content).digest('hex');
    const straggler = stalledRequest(
      w.fake,
      'PUT',
      `/lfs-objects/acme/auto-ok/${oid}`,
      w.token,
      content,
    );
    await tick();
    await w.fake.reset('again');
    straggler.finish();
    expect((await straggler.response).status).toBe(409);
    expect(must(w.fake.state.findRepo('acme', 'auto-ok')).lfs.has(oid)).toBe(false);
  });

  it('[TST-011] a failed fixture builder leaves the API and /__state at 503 until a reset succeeds', async () => {
    const w = world({
      fixtures: {
        broken: async (s) => {
          s.addRepository('acme', { name: 'half', private: true });
          throw new Error('builder failed');
        },
      },
    });
    await expect(w.fake.reset('broken')).rejects.toThrow('builder failed');
    expect((await w.call('GET', '/repos/acme/half', { token: w.fake.token() })).status).toBe(503);
    expect((await w.call('GET', '/__state', { token: null })).status).toBe(503);
    const viaControl = await w.fake.app.request('/__reset', {
      method: 'POST',
      body: JSON.stringify({ fixture: 'broken' }),
    });
    expect(viaControl.status).toBe(500);
    await w.fake.reset();
    expect((await w.call('GET', '/__state', { token: null })).status).toBe(200);
    expect((await w.call('GET', '/repos/acme/half', { token: w.fake.token() })).status).toBe(404);
  });
});
