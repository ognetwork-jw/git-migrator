import { describe, expect, it } from 'vitest';
import { driverCtx, facet, makeConnection, makeWorld, target } from './harness.test.ts';
import { mapBranchRules, restriction } from './mappers.ts';
import { frameworkRestrictionIds, migrationPrefix, SourceLockPartialError } from './source-lock.ts';

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

describe('source read-only: reads leave the framework restrictions out by identity (LIF-045)', () => {
  type Rules = {
    rules: { pattern: string; restrictPushes: unknown[] | null; blockDeletion: boolean }[];
  };

  async function rulesOf(
    world: ReturnType<typeof makeWorld>,
    own: readonly Record<string, unknown>[],
  ): Promise<Rules['rules']> {
    const { conn } = await makeConnection(world);
    const read = await facet(conn, 'branch-rules').read(driverCtx(conn), {
      ...target(),
      frameworkResources: own,
    });
    return (read.data as Rules).rules;
  }

  const user = (world: ReturnType<typeof makeWorld>) =>
    world.fake.state.addBranchRestriction('acme', 'auto-ok', {
      kind: 'push',
      // Canonically the same pattern as the lock's `*`, but a restriction of its own.
      pattern: '**',
      users: ['acct-alice'],
    });

  it('[LIF-045] a user-scoped push restriction on * survives the lock: the rule is what it was without it', async () => {
    const world = makeWorld();
    const { conn } = await makeConnection(world);
    const before = await rulesOf(world, []);
    user(world);
    const withUser = await rulesOf(world, []);
    const mutations =
      (await conn.sourceLock?.apply(target().repository, { targetWebUrl: URL_TARGET })) ?? [];
    const own = mutations.map((m) => m.resourceRef);
    expect(await rulesOf(world, own)).toEqual(withUser);
    const locked = await rulesOf(world, []);
    // Without the identity filter the lock would have emptied the allow list.
    expect(locked.find((r) => r.pattern === '**')?.restrictPushes).toEqual([]);
    expect(withUser.find((r) => r.pattern === '**')?.restrictPushes).not.toEqual([]);
    expect(before.find((r) => r.pattern === '**')?.restrictPushes).toBeNull();
  });

  it('[LIF-045] a restriction an operator adds after the lock is visible', async () => {
    const world = makeWorld();
    const { conn } = await makeConnection(world);
    const mutations =
      (await conn.sourceLock?.apply(target().repository, { targetWebUrl: URL_TARGET })) ?? [];
    world.fake.state.addBranchRestriction('acme', 'auto-ok', { kind: 'delete', pattern: '*' });
    const rule = (
      await rulesOf(
        world,
        mutations.map((m) => m.resourceRef),
      )
    ).find((r) => r.pattern === '**');
    expect(rule?.blockDeletion).toBe(true);
    expect(rule?.restrictPushes).toBeNull();
  });

  it('[LIF-045] removing a co-located restriction after the lock does not leave an empty ** rule', async () => {
    const world = makeWorld();
    const { conn } = await makeConnection(world);
    const mutations =
      (await conn.sourceLock?.apply(target().repository, { targetWebUrl: URL_TARGET })) ?? [];
    const repo = repoState(world);
    repo.branchRestrictions = repo.branchRestrictions.filter(
      (r) => !(r.pattern === '*' && r.kind === 'force'),
    );
    const rules = await rulesOf(
      world,
      mutations.map((m) => m.resourceRef),
    );
    expect(rules.map((r) => r.pattern)).toEqual(['main']);
  });

  it('[LIF-045] a pre-existing user-less push restriction on ** that the framework did not record is not dropped', async () => {
    const world = makeWorld();
    world.fake.state.addBranchRestriction('acme', 'auto-ok', { kind: 'push', pattern: '**' });
    const { conn } = await makeConnection(world);
    const mutations =
      (await conn.sourceLock?.apply(target().repository, { targetWebUrl: URL_TARGET })) ?? [];
    const rule = (
      await rulesOf(
        world,
        mutations.map((m) => m.resourceRef),
      )
    ).find((r) => r.pattern === '**');
    expect(rule?.restrictPushes).toEqual([]);
  });

  it('[LIF-070] inspect finds an unrecorded lock as undoable records, and nothing before one exists', async () => {
    const world = makeWorld();
    const { conn } = await makeConnection(world);
    expect(await conn.sourceLock?.inspect?.(target().repository)).toEqual([]);
    const originals = (await conn.sourceLock?.originals?.(target().repository)) ?? [];
    expect(originals).toEqual([
      expect.objectContaining({ action: 'update', before: null, after: { description: 'hello' } }),
    ]);
    await conn.sourceLock?.apply(target().repository, { targetWebUrl: URL_TARGET, originals });
    const found = (await conn.sourceLock?.inspect?.(target().repository, { originals })) ?? [];
    expect(found.map((m) => [m.facetKey, m.action, m.resourceRef.possiblyFramework])).toEqual([
      ['branch-rules', 'create', true],
      ['repository-settings', 'update', true],
    ]);
    expect(found[1]).toMatchObject({ before: { description: 'hello' } });
    await conn.sourceLock?.undo(target().repository, found);
    expect(repoState(world).description).toBe('hello');
    expect(await conn.sourceLock?.inspect?.(target().repository)).toEqual([]);
  });

  it('[LIF-070] without originals, inspect never derives the original description: before is null', async () => {
    const world = makeWorld();
    const { conn } = await makeConnection(world);
    await conn.sourceLock?.apply(target().repository, { targetWebUrl: URL_TARGET });
    const found = (await conn.sourceLock?.inspect?.(target().repository)) ?? [];
    expect(found.find((m) => m.facetKey === 'repository-settings')?.before).toBeNull();
    // A description changed beyond the lock's own write is not explained by the original either.
    const originals = [
      {
        facetKey: 'repository-settings',
        action: 'update' as const,
        resourceRef: { type: 'repository-description', repository: 'auto-ok' },
        paths: ['/description'],
        before: null,
        after: { description: 'something else' },
      },
    ];
    const again = (await conn.sourceLock?.inspect?.(target().repository, { originals })) ?? [];
    expect(again.find((m) => m.facetKey === 'repository-settings')?.before).toBeNull();
  });

  it('[LIF-070] a crash after the description write over a prefixed original: undo restores that original exactly (reviewer probe 2)', async () => {
    const world = makeWorld();
    const original = '[MIGRATED → https://old.example/x] foo';
    repoState(world).description = original;
    const { conn } = await makeConnection(world);
    const ref = target().repository;
    const originals = (await conn.sourceLock?.originals?.(ref)) ?? [];
    // The records of this apply are lost (the worker died after the PUT).
    await conn.sourceLock?.apply(ref, { targetWebUrl: URL_TARGET, originals });
    expect(repoState(world).description).toBe(`${PREFIX}foo`);
    const found = (await conn.sourceLock?.inspect?.(ref, { originals })) ?? [];
    const description = found.find((m) => m.facetKey === 'repository-settings');
    expect(description?.before).toEqual({ description: original });
    await conn.sourceLock?.undo(ref, found);
    expect(repoState(world).description).toBe(original);
  });

  it('[LIF-070] apply does not write a description that changed since the originals were taken', async () => {
    const world = makeWorld();
    const { conn, rec } = await makeConnection(world);
    const ref = target().repository;
    const originals = (await conn.sourceLock?.originals?.(ref)) ?? [];
    repoState(world).description = '[MIGRATED → https://other.example/z] hello';
    const error = await conn.sourceLock
      ?.apply(ref, { targetWebUrl: URL_TARGET, originals })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceLockPartialError);
    expect((error as SourceLockPartialError).code).toBe('conflict');
    // The restriction was written and is reported; the description was not touched.
    expect((error as SourceLockPartialError).mutations.map((m) => m.facetKey)).toEqual([
      'branch-rules',
    ]);
    expect(rec.requests.filter((r) => r.method === 'PUT')).toEqual([]);
    expect(repoState(world).description).toBe('[MIGRATED → https://other.example/z] hello');
  });

  it('[LIF-070] a repeated undo of the description writes nothing and keeps a prefix that was part of the original', async () => {
    const world = makeWorld();
    const original = '[MIGRATED → https://old.example/x] original';
    repoState(world).description = original;
    const { conn, rec } = await makeConnection(world);
    const record = {
      facetKey: 'repository-settings',
      action: 'update' as const,
      resourceRef: { type: 'repository-description', repository: 'auto-ok' },
      paths: ['/description'],
      before: { description: original },
      after: { description: `${PREFIX}${original}` },
    };
    const writes = rec.requests.filter((r) => r.method !== 'GET').length;
    await conn.sourceLock?.undo(target().repository, [record]);
    expect(repoState(world).description).toBe(original);
    expect(rec.requests.filter((r) => r.method !== 'GET')).toHaveLength(writes);
  });
});

describe('source read-only: the reviewer probe, as a permanent test (LIF-045)', () => {
  const user = {
    type: 'user',
    uuid: '{11111111-1111-1111-1111-111111111111}',
    account_id: 'a1',
    nickname: 'alice',
    display_name: 'Alice',
  };
  const push = (id: number, users: unknown[]) =>
    restriction.parse({
      id,
      kind: 'push',
      pattern: '*',
      branch_match_kind: 'glob',
      users,
      groups: [],
    });

  it('[LIF-045] combining a user-scoped push restriction with the lock gives [] unless the lock is left out by id', () => {
    const own = frameworkRestrictionIds(
      {
        ...target(),
        frameworkResources: [{ type: 'branch-restriction', repository: 'auto-ok', id: 2 }],
      },
      'auto-ok',
    );
    const all = [push(1, [user]), push(2, [])];
    const pushes = (items: typeof all) =>
      mapBranchRules(items, {}).rules.map((r) => [r.pattern, r.restrictPushes?.length ?? null]);
    expect(pushes(all)).toEqual([['**', 0]]);
    expect(pushes(all.filter((r) => !own.has(r.id)))).toEqual(pushes([push(1, [user])]));
    expect(pushes(all.filter((r) => !own.has(r.id)))).toEqual([['**', 1]]);
  });
});
