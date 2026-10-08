import { describe, expect, it } from 'vitest';
import { makeConnection, makeWorld, target } from './harness.test.ts';
import { migrationPrefix, SourceLockPartialError } from './source-lock.ts';

const URL_TARGET = 'https://github.com/acme/plat-auto-ok';
const PREFIX = `[MIGRATED → ${URL_TARGET}] `;

function repoState(world: ReturnType<typeof makeWorld>, slug = 'auto-ok') {
  const repo = world.fake.state.workspace('acme')?.repositories.find((r) => r.slug === slug);
  if (repo === undefined) throw new Error('repo');
  return repo;
}

describe('source read-only (LIF-070)', () => {
  it('[LIF-070] adds a push restriction on * with no users or groups and prefixes the description', async () => {
    const world = makeWorld();
    const { conn } = await makeConnection(world);
    const mutations = await conn.sourceLock?.apply(target().repository, {
      targetWebUrl: URL_TARGET,
    });
    const repo = repoState(world);
    expect(repo.description).toBe(`${PREFIX}hello`);
    const added = repo.branchRestrictions.find((r) => r.kind === 'push' && r.pattern === '*');
    expect(added).toMatchObject({ users: [], groups: [], branchMatchKind: 'glob' });
    expect(mutations?.map((m) => [m.facetKey, m.action, m.resourceRef.type])).toEqual([
      ['branch-rules', 'create', 'branch-restriction'],
      ['repository-settings', 'update', 'repository-description'],
    ]);
    expect(mutations?.[0]?.resourceRef.id).toBe(added?.id);
    expect(mutations?.[1]).toMatchObject({
      paths: ['/description'],
      before: { description: 'hello' },
      after: { description: `${PREFIX}hello` },
    });
  });

  it('[LIF-070] a second apply writes nothing; rolling it back leaves Run 1 lock in place', async () => {
    const world = makeWorld();
    const { conn, rec } = await makeConnection(world);
    await conn.sourceLock?.apply(target().repository, { targetWebUrl: URL_TARGET });
    const writes = rec.requests.filter((r) => r.method !== 'GET').length;
    const again =
      (await conn.sourceLock?.apply(target().repository, { targetWebUrl: URL_TARGET })) ?? [];
    expect(rec.requests.filter((r) => r.method !== 'GET')).toHaveLength(writes);
    expect(again.map((m) => m.resourceRef.adopted)).toEqual([true, true]);
    expect(again[1]).toMatchObject({
      before: { description: `${PREFIX}hello` },
      after: { description: `${PREFIX}hello` },
    });
    const undone = await conn.sourceLock?.undo(target().repository, again);
    expect(undone?.map((m) => m.action)).toEqual(['update', 'create']);
    expect(repoState(world).description).toBe(`${PREFIX}hello`);
    expect(
      repoState(world).branchRestrictions.some((r) => r.pattern === '*' && r.kind === 'push'),
    ).toBe(true);
  });

  it('[LIF-070] a pre-existing identical restriction is untouched after apply then undo', async () => {
    const world = makeWorld();
    const mine = world.fake.state.addBranchRestriction('acme', 'auto-ok', {
      kind: 'push',
      pattern: '*',
    });
    const { conn } = await makeConnection(world);
    const mutations =
      (await conn.sourceLock?.apply(target().repository, { targetWebUrl: URL_TARGET })) ?? [];
    expect(
      mutations.find((m) => m.resourceRef.type === 'branch-restriction')?.resourceRef,
    ).toMatchObject({
      id: mine.id,
      adopted: true,
    });
    await conn.sourceLock?.undo(target().repository, mutations);
    expect(repoState(world).branchRestrictions.some((r) => r.id === mine.id)).toBe(true);
    expect(repoState(world).description).toBe('hello');
  });

  it('[LIF-070] a pre-existing prefixed description is untouched after apply then undo', async () => {
    const world = makeWorld();
    repoState(world).description = `${PREFIX}hello`;
    const { conn, rec } = await makeConnection(world);
    const mutations =
      (await conn.sourceLock?.apply(target().repository, { targetWebUrl: URL_TARGET })) ?? [];
    expect(rec.requests.some((r) => r.method === 'PUT')).toBe(false);
    await conn.sourceLock?.undo(target().repository, mutations);
    expect(repoState(world).description).toBe(`${PREFIX}hello`);
  });

  it('[LIF-070] a description edited while apply runs is not overwritten with stale text', async () => {
    const world = makeWorld();
    const { conn } = await makeConnection(world);
    const original = world.fake.app.request.bind(world.fake.app);
    let edited = false;
    world.fake.app.request = ((input: string, init?: RequestInit) => {
      if (init?.method === 'POST' && !edited) {
        edited = true;
        repoState(world).description = 'edited meanwhile';
      }
      return original(input, init);
    }) as never;
    await conn.sourceLock?.apply(target().repository, { targetWebUrl: URL_TARGET });
    expect(repoState(world).description).toBe(`${PREFIX}edited meanwhile`);
  });

  it('[LIF-045] a read-back after a lost response uses its own signal, so a cancelled Run still records the write', async () => {
    const world = makeWorld();
    const run = new AbortController();
    const { conn } = await makeConnection(world, { signal: run.signal });
    const original = world.fake.app.request.bind(world.fake.app);
    world.fake.app.request = (async (input: string, init?: RequestInit) => {
      const res = await original(input, init);
      if (init?.method === 'POST') {
        run.abort(); // the Run is cancelled while the response is lost
        return new Response('{}', { status: 503 });
      }
      return res;
    }) as never;
    const error = await conn.sourceLock
      ?.apply(target().repository, { targetWebUrl: URL_TARGET })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceLockPartialError);
    expect((error as SourceLockPartialError).mutations).toHaveLength(1);
  });

  it('[LIF-045] a failing read-back marks the write possiblyApplied', async () => {
    const world = makeWorld();
    const { conn } = await makeConnection(world);
    const original = world.fake.app.request.bind(world.fake.app);
    let posted = false;
    world.fake.app.request = (async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted = true;
        return new Response('{}', { status: 503 });
      }
      if (posted && String(input).includes('branch-restrictions')) {
        return new Response('{}', { status: 403 });
      }
      return original(input, init);
    }) as never;
    const error = await conn.sourceLock
      ?.apply(target().repository, { targetWebUrl: URL_TARGET })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceLockPartialError);
    expect((error as SourceLockPartialError).possiblyApplied).toEqual(['branch-restriction']);
  });

  it('[LIF-045] a lost POST response that the provider applied is recorded, and undo leaves the source clean', async () => {
    const world = makeWorld();
    const { conn } = await makeConnection(world);
    const original = world.fake.app.request.bind(world.fake.app);
    world.fake.app.request = (async (input: string, init?: RequestInit) => {
      const res = await original(input, init);
      if (init?.method === 'POST') return new Response('{}', { status: 503 });
      return res;
    }) as never;
    const error = await conn.sourceLock
      ?.apply(target().repository, { targetWebUrl: URL_TARGET })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceLockPartialError);
    const mutations = (error as SourceLockPartialError).mutations;
    expect(mutations.map((m) => m.resourceRef.type)).toEqual(['branch-restriction']);
    await conn.sourceLock?.undo(target().repository, [...mutations]);
    expect(
      repoState(world).branchRestrictions.some((r) => r.pattern === '*' && r.kind === 'push'),
    ).toBe(false);
  });

  it('[LIF-045] a lost PUT response that the provider applied is recorded, and undo leaves the source clean', async () => {
    const world = makeWorld();
    const { conn } = await makeConnection(world);
    const original = world.fake.app.request.bind(world.fake.app);
    world.fake.app.request = (async (input: string, init?: RequestInit) => {
      const res = await original(input, init);
      if (init?.method === 'PUT') return new Response('{}', { status: 504 });
      return res;
    }) as never;
    const error = await conn.sourceLock
      ?.apply(target().repository, { targetWebUrl: URL_TARGET })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceLockPartialError);
    const mutations = (error as SourceLockPartialError).mutations;
    expect(mutations.map((m) => m.resourceRef.type)).toEqual([
      'branch-restriction',
      'repository-description',
    ]);
    expect(repoState(world).description).toBe(`${PREFIX}hello`);
    world.fake.app.request = original;
    await conn.sourceLock?.undo(target().repository, [...mutations]);
    expect(repoState(world).description).toBe('hello');
    expect(
      repoState(world).branchRestrictions.some((r) => r.pattern === '*' && r.kind === 'push'),
    ).toBe(false);
  });

  it('[LIF-070] undo refuses a mutation recorded for another repository', async () => {
    const world = makeWorld();
    const { conn } = await makeConnection(world);
    const mutations =
      (await conn.sourceLock?.apply(target().repository, { targetWebUrl: URL_TARGET })) ?? [];
    await expect(
      conn.sourceLock?.undo({ ...target().repository, slug: 'empty' }, mutations),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(repoState(world).description).toBe(`${PREFIX}hello`);
  });

  it('[LIF-070] never writes before a successful GET of the same slug: a missing repository is not created', async () => {
    const world = makeWorld();
    const { conn, rec } = await makeConnection(world);
    const ghost = { ...target().repository, slug: 'ghost' };
    await expect(conn.sourceLock?.apply(ghost, { targetWebUrl: URL_TARGET })).rejects.toMatchObject(
      { code: 'not_found' },
    );
    expect(rec.requests.some((r) => r.method !== 'GET')).toBe(false);
    expect(world.fake.state.workspace('acme')?.repositories.some((r) => r.slug === 'ghost')).toBe(
      false,
    );
  });

  it('[LIF-070] every PUT is preceded by a GET of the same slug and followed by one, with only description in the body', async () => {
    const world = makeWorld();
    const { conn, rec } = await makeConnection(world);
    const bodies: unknown[] = [];
    const original = world.fake.app.request.bind(world.fake.app);
    world.fake.app.request = ((input: string, init?: RequestInit) => {
      if (init?.method === 'PUT') bodies.push(JSON.parse(String(init.body)));
      return original(input, init);
    }) as never;
    await conn.sourceLock?.apply(target().repository, { targetWebUrl: URL_TARGET });
    const log = rec.requests.map((r) => `${r.method} ${r.path.split('?')[0]}`);
    const put = log.indexOf('PUT /2.0/repositories/acme/auto-ok');
    expect(put).toBeGreaterThan(0);
    expect(log.slice(0, put)).toContain('GET /2.0/repositories/acme/auto-ok');
    expect(log[put + 1]).toBe('GET /2.0/repositories/acme/auto-ok');
    expect(bodies).toEqual([{ description: `${PREFIX}hello` }]);
  });

  for (const mode of ['merge', 'reset-omitted'] as const) {
    it(`[LIF-070] identity fields survive the description update (putSemantics ${mode}); a partial-body reset is restored and fails the step`, async () => {
      const world = makeWorld({ putSemantics: mode });
      const repo = repoState(world);
      repo.isPrivate = false;
      repo.forkPolicy = 'allow_forks';
      repo.projectKey = 'DATA';
      const { conn } = await makeConnection(world);
      const run = conn.sourceLock?.apply(target('auto-ok', 'DATA').repository, {
        targetWebUrl: URL_TARGET,
      });
      if (mode === 'merge') {
        await run;
      } else {
        const error = await run?.catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SourceLockPartialError);
        expect(error).toMatchObject({ code: 'conflict' });
        // The restriction and the already-written description are reported for the ledger.
        expect((error as SourceLockPartialError).mutations.map((m) => m.resourceRef.type)).toEqual([
          'branch-restriction',
          'repository-description',
        ]);
      }
      expect(repo.isPrivate).toBe(false);
      expect(repo.forkPolicy).toBe('allow_forks');
      expect(repo.projectKey).toBe('DATA');
      expect(repo.mainbranch).toBe('main');
      expect(repo.name).toBe('auto-ok');
    });
  }

  it('[LIF-070] a failing description step keeps the restriction mutation for the ledger', async () => {
    const world = makeWorld();
    const { conn } = await makeConnection(world);
    const original = world.fake.app.request.bind(world.fake.app);
    world.fake.app.request = ((input: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? Promise.resolve(new Response('{}', { status: 500 }))
        : original(input, init)) as never;
    const error = await conn.sourceLock
      ?.apply(target().repository, { targetWebUrl: URL_TARGET })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceLockPartialError);
    expect((error as SourceLockPartialError).mutations).toHaveLength(1);
  });

  it('[LIF-070] writes never retry (a 503 on POST is attempted once)', async () => {
    const world = makeWorld();
    const { conn, rec } = await makeConnection(world);
    const original = world.fake.app.request.bind(world.fake.app);
    world.fake.app.request = ((input: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? Promise.resolve(new Response('{}', { status: 503 }))
        : original(input, init)) as never;
    await expect(
      conn.sourceLock?.apply(target().repository, { targetWebUrl: URL_TARGET }),
    ).rejects.toMatchObject({ code: 'transient' });
    expect(rec.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('[LIF-070] undo deletes the restriction and restores the description (undo_source_read_only)', async () => {
    const world = makeWorld();
    const { conn } = await makeConnection(world);
    const mutations =
      (await conn.sourceLock?.apply(target().repository, { targetWebUrl: URL_TARGET })) ?? [];
    const undone = await conn.sourceLock?.undo(target().repository, mutations);
    const repo = repoState(world);
    expect(repo.description).toBe('hello');
    expect(repo.branchRestrictions.some((r) => r.pattern === '*' && r.kind === 'push')).toBe(false);
    expect(undone?.map((m) => m.action)).toEqual(['update', 'delete']);
    // Undo twice: still fine (the restriction is already gone).
    await expect(conn.sourceLock?.undo(target().repository, mutations)).resolves.toBeDefined();
    expect(repo.description).toBe('hello');
  });

  it('[LIF-070] undo only strips the prefix when the description was edited since', async () => {
    const world = makeWorld();
    const { conn } = await makeConnection(world);
    const mutations =
      (await conn.sourceLock?.apply(target().repository, { targetWebUrl: URL_TARGET })) ?? [];
    repoState(world).description = `${PREFIX}edited later`;
    await conn.sourceLock?.undo(target().repository, mutations);
    expect(repoState(world).description).toBe('edited later');
    repoState(world).description = 'no prefix any more';
    await conn.sourceLock?.undo(target().repository, mutations);
    expect(repoState(world).description).toBe('no prefix any more');
  });

  it('[LIF-070] re-applying with a new target URL replaces the old prefix', async () => {
    const world = makeWorld();
    const { conn } = await makeConnection(world);
    await conn.sourceLock?.apply(target().repository, {
      targetWebUrl: 'https://github.com/acme/old',
    });
    await conn.sourceLock?.apply(target().repository, { targetWebUrl: URL_TARGET });
    expect(repoState(world).description).toBe(`${PREFIX}hello`);
  });

  it('[LIF-070] rejects unusable target URLs and unknown mutations', async () => {
    expect(() => migrationPrefix('not a url')).toThrow(/not a URL/);
    expect(() => migrationPrefix('https://u:p@github.com/x')).toThrow(/without credentials/);
    expect(() => migrationPrefix('javascript:alert(1)')).toThrow();
    const { conn } = await makeConnection(makeWorld());
    await expect(
      conn.sourceLock?.undo(target().repository, [
        {
          facetKey: null,
          action: 'create',
          resourceRef: { type: 'other' },
          paths: [],
          before: null,
          after: null,
        },
      ]),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      conn.sourceLock?.undo(target().repository, [
        {
          facetKey: 'branch-rules',
          action: 'create',
          resourceRef: { type: 'branch-restriction' },
          paths: [],
          before: null,
          after: null,
        },
      ]),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('[LIF-070] the source write needs admin scope: a read-only token fails closed', async () => {
    const world = makeWorld({
      credentials: [
        {
          email: 'operator@test.local',
          token: 'fake-bitbucket-api-token',
          accountId: 'acct-operator',
          scopes: ['read:repository:bitbucket'],
        },
      ],
    });
    const { conn } = await makeConnection(world);
    await expect(
      conn.sourceLock?.apply(target().repository, { targetWebUrl: URL_TARGET }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(repoState(world).description).toBe('hello');
  });
});
