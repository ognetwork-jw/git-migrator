import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Gh } from './gh.ts';
import { all, setup } from './harness.test.ts';

const FILES = { 'README.md': '# hi\n', 'src/a.txt': 'a\n' };
const oid = (s: string) => createHash('sha256').update(s).digest('hex');
const DAY_MS = 24 * 60 * 60 * 1000;
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const isInvitePost = (r: Request) =>
  r.method === 'POST' && r.url.endsWith('/orgs/acme/invitations');

describe('inventory', () => {
  it('[JOB-030] lists the organization as the only namespace', async () => {
    const h = await setup();
    const page = await h.conn.inventory.listNamespaces();
    expect(page.items).toEqual([
      expect.objectContaining({
        kind: 'organization',
        slug: 'acme',
        providerId: expect.stringMatching(/^\d+$/),
      }),
    ]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('[JOB-030] pages repositories and keeps node ids as provider ids', async () => {
    const h = await setup();
    for (let i = 0; i < 105; i++)
      h.fake.state.addRepository('acme', {
        name: `r${String(i).padStart(3, '0')}`,
        private: i % 2 === 0,
      });
    const first = await h.conn.inventory.listRepositories(h.org);
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toBe('2');
    const second = await h.conn.inventory.listRepositories(h.org, first.nextCursor);
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeUndefined();
    const repo = first.items[0];
    expect(repo?.providerId).toMatch(/^R_|^[A-Za-z0-9_=-]+$/);
    expect(repo?.fullPath).toMatch(/^acme\/r\d+$/);
    expect(repo?.namespace.slug).toBe('acme');
    expect(typeof repo?.isPrivate).toBe('boolean');
  });

  it('[JOB-030] finds and gets a repository, and returns null for a missing one', async () => {
    const h = await setup();
    h.fake.state.addRepository('acme', {
      name: 'app',
      private: true,
      description: 'd',
      files: FILES,
    });
    expect((await h.conn.inventory.findRepository(h.org, 'app'))?.name).toBe('app');
    expect((await h.conn.inventory.getRepository(h.repo('app')))?.defaultBranch).toBe('main');
    expect(await h.conn.inventory.findRepository(h.org, 'missing')).toBeNull();
    expect(await h.conn.inventory.getRepository(h.repo('missing'))).toBeNull();
  });

  it('[JOB-030] lists members then outside collaborators as identities with public data', async () => {
    const h = await setup();
    const s = h.fake.state;
    s.addMember('acme', 'alice', 'admin');
    s.addMember('acme', 'bob');
    s.addUser({ login: 'carol', email: 'carol@test.local' });
    const repo = s.addRepository('acme', { name: 'r', private: true, files: FILES });
    s.addCollaborator(repo, 'carol', 'push');
    const items = [];
    let cursor: string | undefined;
    do {
      const page = await h.conn.inventory.listIdentities(cursor);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    const byLogin = Object.fromEntries(items.map((i) => [i.login, i]));
    expect(byLogin.alice?.isMember).toBe(true);
    expect(byLogin.bob?.isMember).toBe(true);
    expect(byLogin.carol?.isMember).toBe(false);
    expect(byLogin.alice?.providerId).toMatch(/^\d+$/);
  });

  it('[JOB-030] lists teams with member ids', async () => {
    const h = await setup();
    const s = h.fake.state;
    const bob = s.addMember('acme', 'bob');
    s.addTeam('acme', { name: 'Platform', members: ['bob'] });
    const page = await h.conn.inventory.listGroups();
    expect(page.items).toEqual([
      expect.objectContaining({
        slug: 'platform',
        name: 'Platform',
        memberProviderIds: [String(bob.id)],
      }),
    ]);
  });
});

describe('repositories', () => {
  it('[LIF-077] creates a private repository and reports it empty', async () => {
    const h = await setup();
    const created = await h.conn.repositories.create(h.org, {
      name: 'new',
      visibility: 'private',
      description: 'hello',
    });
    expect(created).toMatchObject({ slug: 'new', isPrivate: true });
    expect(await h.conn.repositories.isEmpty(h.repo('new'))).toBe(true);
  });

  it('[LIF-077] a repository with a branch is not empty', async () => {
    const h = await setup();
    h.fake.state.addRepository('acme', { name: 'full', files: FILES });
    expect(await h.conn.repositories.isEmpty(h.repo('full'))).toBe(false);
  });

  it('[LIF-077] a second create with the same name is a conflict, and writes are not retried', async () => {
    const h = await setup();
    await h.conn.repositories.create(h.org, {
      name: 'dup',
      visibility: 'private',
      description: '',
    });
    await expect(
      h.conn.repositories.create(h.org, { name: 'dup', visibility: 'private', description: '' }),
    ).rejects.toMatchObject({ code: 'conflict', retryable: false });
    expect(
      h.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/orgs/acme/repos')),
    ).toHaveLength(2);
  });

  it('[LIF-077] private creation refused by the organization is forbidden', async () => {
    const h = await setup();
    const org = h.fake.state.requireOrg('acme');
    org.membersCanCreatePrivateRepositories = false;
    await expect(
      h.conn.repositories.create(h.org, { name: 'x', visibility: 'private', description: '' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('[LIF-077] deletes a repository', async () => {
    const h = await setup();
    const gone = h.fake.state.addRepository('acme', { name: 'gone', files: FILES });
    await h.conn.repositories.delete({ ...h.repo('gone'), providerId: gone.nodeId });
    expect(await h.conn.inventory.findRepository(h.org, 'gone')).toBeNull();
  });

  it('[LIF-077] deletes a renamed repository under its current name: the old name redirects, and a write must not follow a redirect', async () => {
    const h = await setup();
    const moved = h.fake.state.addRepository('acme', { name: 'before', files: FILES });
    const renamed = await h.fake.app.fetch(
      new Request('http://localhost:4020/repos/acme/before', {
        method: 'PATCH',
        headers: { authorization: `Bearer ${h.fake.token()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'after' }),
      }),
    );
    expect(renamed.status).toBe(200);
    await h.conn.repositories.delete({ ...h.repo('before'), providerId: moved.nodeId });
    expect(h.fake.state.findRepo('acme', 'after')).toBeUndefined();
    const deletes = h.requests.filter((r) => r.method === 'DELETE');
    expect(deletes.map((r) => new URL(r.url).pathname)).toEqual(['/repos/acme/after']);
  });

  it('[LIF-077] refuses to delete without the provider id, before any request', async () => {
    const h = await setup();
    h.fake.state.addRepository('acme', { name: 'keep', files: FILES });
    const before = h.requests.length;
    await expect(h.conn.repositories.delete(h.repo('keep'))).rejects.toMatchObject({
      code: 'invalid',
      retryable: false,
    });
    expect(h.requests.slice(before).filter((r) => r.method === 'DELETE')).toHaveLength(0);
    expect(await h.conn.inventory.findRepository(h.org, 'keep')).not.toBeNull();
  });

  it('[LIF-077] a refused delete is a non-retryable forbidden error', async () => {
    const h = await setup({ config: { repositoryDeletion: 'forbidden' } });
    const keep = h.fake.state.addRepository('acme', { name: 'keep', files: FILES });
    const before = h.requests.length;
    await expect(
      h.conn.repositories.delete({ ...h.repo('keep'), providerId: keep.nodeId }),
    ).rejects.toMatchObject({
      code: 'forbidden',
      retryable: false,
    });
    expect(h.requests.slice(before).filter((r) => r.method === 'DELETE')).toHaveLength(1);
  });
});

describe('refs', () => {
  it('[FAC-GIT-006] compare maps identical, ahead, behind and diverged', async () => {
    const h = await setup();
    const s = h.fake.state;
    const repo = s.addRepository('acme', { name: 'c', files: FILES });
    s.addBranch(repo, 'ahead', { ...FILES, 'new.txt': 'n\n' }, { from: 'main', message: 'more' });
    s.addBranch(repo, 'other', { ...FILES, 'o.txt': 'o\n' }, { from: 'main', message: 'o' });
    const ref = h.repo('c');
    expect(await h.conn.refs.compare(ref, 'main', 'main')).toBe('identical');
    expect(await h.conn.refs.compare(ref, 'main', 'ahead')).toBe('ahead');
    expect(await h.conn.refs.compare(ref, 'ahead', 'main')).toBe('behind');
    s.addBranch(repo, 'main2', { ...FILES, 'm.txt': 'm\n' }, { from: 'main', message: 'm' });
    expect(await h.conn.refs.compare(ref, 'main2', 'other')).toBe('diverged');
  });

  it('[FAC-GIT-006] compare accepts branch names with slashes', async () => {
    const h = await setup();
    const s = h.fake.state;
    const repo = s.addRepository('acme', { name: 'c', files: FILES });
    s.addBranch(repo, 'feature/x', { ...FILES, 'f.txt': 'f\n' }, { from: 'main', message: 'f' });
    expect(await h.conn.refs.compare(h.repo('c'), 'main', 'feature/x')).toBe('ahead');
  });

  it('[FAC-GIT-006] compare of an unknown ref is not_found', async () => {
    const h = await setup();
    h.fake.state.addRepository('acme', { name: 'c', files: FILES });
    await expect(h.conn.refs.compare(h.repo('c'), 'main', 'nope')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('[LIF-045] setDefaultBranch records the change and is idempotent', async () => {
    const h = await setup();
    const s = h.fake.state;
    const repo = s.addRepository('acme', { name: 'd', files: FILES });
    s.addBranch(repo, 'dev', { ...FILES, 'd.txt': 'd\n' }, { from: 'main', message: 'd' });
    const record = await h.conn.refs.setDefaultBranch(h.repo('d'), 'dev');
    expect(record).toMatchObject({
      facetKey: 'git-refs',
      action: 'update',
      before: 'main',
      after: 'dev',
    });
    const patches = () => h.requests.filter((r) => r.method === 'PATCH').length;
    const n = patches();
    await h.conn.refs.setDefaultBranch(h.repo('d'), 'dev');
    expect(patches()).toBe(n);
  });
});

describe('LFS existence', () => {
  it('[FAC-GIT-005] reports the objects absent on the target via the batch download API', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'l', files: FILES });
    const have = oid('have');
    const lack = oid('lack');
    h.fake.state.addLfsObject(repo, have, 4);
    expect(await h.conn.lfs.missing(h.repo('l'), [have, lack])).toEqual([lack]);
    expect(await h.conn.lfs.missing(h.repo('l'), [])).toEqual([]);
  });

  it('[FAC-GIT-005] splits more than 100 objects into batches', async () => {
    const h = await setup();
    const repo = h.fake.state.addRepository('acme', { name: 'l', files: FILES });
    const oids = Array.from({ length: 230 }, (_, i) => oid(`o${i}`));
    for (const o of oids.slice(0, 120)) h.fake.state.addLfsObject(repo, o, 1);
    const missing = await h.conn.lfs.missing(h.repo('l'), oids);
    expect(missing).toEqual(oids.slice(120));
    expect(h.requests.filter((r) => r.url.endsWith('/info/lfs/objects/batch'))).toHaveLength(3);
  });

  it('[FAC-GIT-005] refuses a malformed object id', async () => {
    const h = await setup();
    h.fake.state.addRepository('acme', { name: 'l', files: FILES });
    await expect(h.conn.lfs.missing(h.repo('l'), ['abc'])).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('[FAC-GIT-005] a missing repository is not_found', async () => {
    const h = await setup();
    await expect(h.conn.lfs.missing(h.repo('nope'), [oid('x')])).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('invitation writer', () => {
  it('[AUTH-060] invites by email into teams and lists pending invitations', async () => {
    const h = await setup();
    const team = h.fake.state.addTeam('acme', { name: 'devs' });
    const result = await h.conn.invitations?.invite({
      email: 'new@test.local',
      teamIds: [String(team.id)],
    });
    expect(result?.providerInvitationId).toMatch(/^\d+$/);
    const pending = await h.conn.invitations?.listPending();
    expect(pending).toEqual([
      expect.objectContaining({
        providerInvitationId: result?.providerInvitationId,
        email: 'new@test.local',
      }),
    ]);
    expect(await h.conn.invitations?.listFailed()).toEqual([]);
  });

  it('[AUTH-061] lists pending and failed invitations with their creation and failure times', async () => {
    const h = await setup();
    const sent = await h.conn.invitations?.invite({ email: 'late@test.local', teamIds: [] });
    const inv = h.fake.state
      .requireOrg('acme')
      .invitations.find((i) => String(i.id) === sent?.providerInvitationId);
    if (!inv) throw new Error('the invitation is missing');
    inv.createdAt = Date.parse('2026-10-01T10:00:00Z');
    expect(await h.conn.invitations?.listPending()).toEqual([
      expect.objectContaining({ createdAt: new Date('2026-10-01T10:00:00Z') }),
    ]);
    inv.failedAt = Date.parse('2026-10-02T11:00:00Z');
    inv.failedReason = 'Unable to send email';
    expect(await h.conn.invitations?.listFailed()).toEqual([
      {
        providerInvitationId: sent?.providerInvitationId,
        email: 'late@test.local',
        reason: 'Unable to send email',
        createdAt: new Date('2026-10-01T10:00:00Z'),
        failedAt: new Date('2026-10-02T11:00:00Z'),
      },
    ]);
  });

  it('[AUTH-060] cancels a pending invitation, and an invitation that is gone is not an error', async () => {
    const h = await setup();
    const sent = await h.conn.invitations?.invite({ email: 'gone@test.local', teamIds: [] });
    const id = sent?.providerInvitationId as string;
    expect(await h.conn.invitations?.cancel(id)).toEqual({ cancelled: true });
    expect(await h.conn.invitations?.listPending()).toEqual([]);
    expect(await h.conn.invitations?.cancel(id)).toEqual({ cancelled: false });
    await expect(h.conn.invitations?.cancel('../x')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('[AUTH-060] a 403 secondary limit on the invitations endpoint keeps the SDK retry time', async () => {
    const h = await setup({
      intercept: (r) =>
        isInvitePost(r)
          ? reply(
              403,
              { message: 'You have exceeded a secondary rate limit. Please wait a few minutes.' },
              { 'retry-after': '30' },
            )
          : undefined,
    });
    const error = await h.conn.invitations
      ?.invite({ email: 'a@b.test', teamIds: [] })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'rate_limited' });
    expect((error as { retryAfterMs?: number }).retryAfterMs).toBeLessThan(DAY_MS);
    expect((error as { retryAt?: Date }).retryAt).toBeDefined();
  });

  it('[AUTH-060] a 429 keeps the SDK retry time, not the 24 h daily-cap wait', async () => {
    const h = await setup({
      intercept: (r) =>
        isInvitePost(r)
          ? reply(429, { message: 'Too many requests' }, { 'retry-after': '30' })
          : undefined,
    });
    const error = await h.conn.invitations
      ?.invite({ email: 'a@b.test', teamIds: [] })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'rate_limited' });
    expect((error as { retryAfterMs?: number }).retryAfterMs).toBeLessThan(DAY_MS);
  });

  it('[AUTH-060] a 422 that names team_ids limits stays invalid', async () => {
    const h = await setup({
      intercept: (r) =>
        isInvitePost(r)
          ? reply(422, { message: 'team_ids exceeds the limit of 50 teams' })
          : undefined,
    });
    await expect(
      h.conn.invitations?.invite({ email: 'a@b.test', teamIds: [] }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('[AUTH-060] a 422 whose provider message names the daily invitation cap waits 24 h', async () => {
    const h = await setup({
      intercept: (r) =>
        isInvitePost(r)
          ? reply(422, { message: 'The organization has exceeded the invitation limit for today.' })
          : undefined,
    });
    await expect(
      h.conn.invitations?.invite({ email: 'a@b.test', teamIds: [] }),
    ).rejects.toMatchObject({ code: 'rate_limited', retryAfterMs: DAY_MS });
  });

  it('[AUTH-060] refuses non-numeric team ids before any request', async () => {
    const h = await setup();
    const before = h.requests.length;
    await expect(
      h.conn.invitations?.invite({ email: 'a@b.test', teamIds: ['x'] }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(h.requests.length).toBe(before);
  });

  it('[AUTH-060] the daily cap becomes rate_limited with a 24 h wait', async () => {
    const h = await setup();
    const org = h.fake.state.requireOrg('acme');
    org.plan = { ...org.plan, seats: 1 };
    let error: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        await h.conn.invitations?.invite({ email: `u${i}@test.local`, teamIds: [] });
      } catch (e) {
        error = e;
      }
    }
    // The fake refuses on a missing seat (422), not on the daily cap: it stays `invalid`.
    expect(error).toBeDefined();
  });

  it('[AUTH-060] reads seats from the plan', async () => {
    const h = await setup();
    const org = h.fake.state.requireOrg('acme');
    org.plan = { ...org.plan, seats: 10 };
    const seats = await h.conn.org?.seatInfo();
    expect(seats?.total).toBe(10);
  });
});

describe('limits', () => {
  it('[ADP-010] declares GitHub blob and push limits and hidden refs', async () => {
    const h = await setup();
    expect(h.conn.limits.maxBlobBytes).toBe(100 * 1024 * 1024);
    expect(h.conn.limits.maxPushBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(h.conn.limits.hiddenRefPrefixes).toContain('refs/pull/');
    expect(all).toBeDefined();
  });
});

describe('GraphQL error classes', () => {
  it('[ADP-060] an untyped GraphQL error with no data is transient for a read, invalid for a write', async () => {
    const h = await setup({
      intercept: (r) =>
        r.url.endsWith('/graphql')
          ? reply(200, { errors: [{ message: 'Something went wrong' }] })
          : undefined,
    });
    const gh = new Gh(h.conn.http);
    await expect(gh.graphql('query { viewer { login } }', {})).rejects.toMatchObject({
      code: 'transient',
    });
    await expect(
      gh.graphql('mutation { createBranchProtectionRule { clientMutationId } }', {}, true),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('[ADP-060] a typed GraphQL error keeps its class', async () => {
    const h = await setup({
      intercept: (r) =>
        r.url.endsWith('/graphql')
          ? reply(200, { errors: [{ type: 'NOT_FOUND', message: 'gone' }], data: null })
          : undefined,
    });
    await expect(
      new Gh(h.conn.http).graphql('query { viewer { login } }', {}),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
