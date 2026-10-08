import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { jsonOf, world } from './harness.ts';

vi.setConfig({ testTimeout: 60_000 });

const R = '/repos/acme/auto-ok';

describe('git data', () => {
  it('[TST-011] reads refs and matching refs; hidden refs are not listed', async () => {
    const w = world();
    const main = await w.spec(
      '/repos/{owner}/{repo}/git/ref/{ref}',
      'get',
      `${R}/git/ref/heads/main`,
      {},
      200,
    );
    expect(main.body.ref).toBe('refs/heads/main');
    expect(main.body.object.sha).toBe(w.repo.git.refs.get('refs/heads/main'));
    await w.spec('/repos/{owner}/{repo}/git/ref/{ref}', 'get', `${R}/git/ref/heads/nope`, {}, 404);
    const matching = await w.spec(
      '/repos/{owner}/{repo}/git/matching-refs/{ref}',
      'get',
      `${R}/git/matching-refs/heads`,
      {},
      200,
    );
    expect(matching.body.map((r: { ref: string }) => r.ref)).toEqual([
      'refs/heads/feature/x',
      'refs/heads/main',
    ]);
    w.fake.state.addPull(w.repo, { title: 't', head: 'feature/x' });
    expect(w.repo.git.refs.has('refs/pull/1/head')).toBe(true);
    expect((await w.call('GET', `${R}/git/matching-refs/pull`)).body).toEqual([]);
  });

  it('[LIF-047] POST /git/refs fails on an empty repository with 409; Git Data reads do too', async () => {
    const w = world();
    const E = '/repos/acme/empty';
    const res = await w.spec(
      '/repos/{owner}/{repo}/git/refs',
      'post',
      `${E}/git/refs`,
      { body: { ref: 'refs/heads/main', sha: w.repo.git.refs.get('refs/heads/main') } },
      409,
    );
    expect(res.body.message).toBe('Git Repository is empty.');
    await w.spec('/repos/{owner}/{repo}/git/ref/{ref}', 'get', `${E}/git/ref/heads/main`, {}, 409);
    await w.spec(
      '/repos/{owner}/{repo}/git/matching-refs/{ref}',
      'get',
      `${E}/git/matching-refs/heads`,
      {},
      409,
    );
    await w.spec(
      '/repos/{owner}/{repo}/git/blobs',
      'post',
      `${E}/git/blobs`,
      { body: { content: 'x' } },
      409,
    );
    await w.spec(
      '/repos/{owner}/{repo}/git/trees',
      'post',
      `${E}/git/trees`,
      { body: { tree: [] } },
      409,
    );
    await w.spec(
      '/repos/{owner}/{repo}/git/commits',
      'post',
      `${E}/git/commits`,
      { body: { message: 'm', tree: 'x' } },
      409,
    );
    expect((await w.call('GET', `${E}/contents/README.md`)).status).toBe(404);
  });

  it('[LIF-047] blob → tree → commit → ref builds a Change Request branch', async () => {
    const w = world();
    const baseSha = w.repo.git.refs.get('refs/heads/main') as string;
    const blob = await w.spec(
      '/repos/{owner}/{repo}/git/blobs',
      'post',
      `${R}/git/blobs`,
      { body: { content: Buffer.from('hello\n').toString('base64'), encoding: 'base64' } },
      201,
    );
    const baseCommit = await w.spec(
      '/repos/{owner}/{repo}/git/commits/{commit_sha}',
      'get',
      `${R}/git/commits/${baseSha}`,
      {},
      200,
    );
    const tree = await w.spec(
      '/repos/{owner}/{repo}/git/trees',
      'post',
      `${R}/git/trees`,
      {
        body: {
          base_tree: baseCommit.body.tree.sha,
          tree: [
            { path: 'docs/hello.txt', mode: '100644', type: 'blob', sha: blob.body.sha },
            { path: 'src/a.txt', mode: '100644', type: 'blob', sha: null },
            { path: 'inline.txt', content: 'inline\n' },
          ],
        },
      },
      201,
    );
    expect(tree.body.tree.map((e: { path: string }) => e.path)).toEqual(
      expect.arrayContaining(['docs', 'inline.txt', 'README.md']),
    );
    const commit = await w.spec(
      '/repos/{owner}/{repo}/git/commits',
      'post',
      `${R}/git/commits`,
      { body: { message: 'Change request', tree: tree.body.sha, parents: [baseSha] } },
      201,
    );
    expect(commit.body.parents[0].sha).toBe(baseSha);
    await w.spec(
      '/repos/{owner}/{repo}/git/refs',
      'post',
      `${R}/git/refs`,
      { body: { ref: 'refs/heads/cr/1', sha: commit.body.sha } },
      201,
    );
    const rec = await w.spec(
      '/repos/{owner}/{repo}/git/trees/{tree_sha}',
      'get',
      `${R}/git/trees/${tree.body.sha}?recursive=1`,
      {},
      200,
    );
    const paths = rec.body.tree.map((e: { path: string }) => e.path);
    expect(paths).toContain('docs/hello.txt');
    expect(paths).not.toContain('src/a.txt');
    const file = await w.call('GET', `${R}/contents/docs/hello.txt?ref=cr/1`);
    expect(Buffer.from(file.body.content, 'base64').toString()).toBe('hello\n');
  });

  it('[TST-011] commit sha is a real git hash of the given content', async () => {
    const w = world();
    const blob = await w.call('POST', `${R}/git/blobs`, { body: { content: 'hello\n' } });
    // `printf 'hello\n' | git hash-object --stdin`
    expect(blob.body.sha).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    const empty = await w.call('POST', `${R}/git/trees`, { body: { tree: [] } });
    expect(empty.body.sha).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  });

  it('[TST-011] ref validation: duplicate, unknown sha, bad name, hidden refs', async () => {
    const w = world();
    const sha = w.repo.git.refs.get('refs/heads/main');
    const post = (body: unknown) => w.call('POST', `${R}/git/refs`, { body });
    expect((await post({ ref: 'refs/heads/main', sha })).body.message).toBe(
      'Reference already exists',
    );
    expect((await post({ ref: 'refs/heads/n', sha: '0'.repeat(40) })).body.message).toBe(
      'Object does not exist',
    );
    expect((await post({ ref: 'heads/n', sha })).status).toBe(422);
    expect((await post({ ref: 'refs/pull/9/head', sha })).body.message).toBe(
      'Reference update failed',
    );
    await w.spec(
      '/repos/{owner}/{repo}/git/refs',
      'post',
      `${R}/git/refs`,
      { body: { ref: 'refs/heads/main', sha } },
      422,
    );
    expect((await w.call('PATCH', `${R}/git/refs/pull/1/head`, { body: { sha } })).status).toBe(
      422,
    );
    expect((await w.call('DELETE', `${R}/git/refs/pull/1/head`)).status).toBe(422);
  });

  it('[TST-011] PATCH ref fast-forwards, rejects non-fast-forward without force, DELETE removes', async () => {
    const w = world();
    const main = w.repo.git.refs.get('refs/heads/main') as string;
    const feature = w.repo.git.refs.get('refs/heads/feature/x') as string;
    const ff = await w.spec(
      '/repos/{owner}/{repo}/git/refs/{ref}',
      'patch',
      `${R}/git/refs/heads/main`,
      { body: { sha: feature } },
      200,
    );
    expect(ff.body.object.sha).toBe(feature);
    const nonFf = await w.spec(
      '/repos/{owner}/{repo}/git/refs/{ref}',
      'patch',
      `${R}/git/refs/heads/main`,
      { body: { sha: main } },
      422,
    );
    expect(nonFf.body.message).toBe('Update is not a fast forward');
    await w.spec(
      '/repos/{owner}/{repo}/git/refs/{ref}',
      'patch',
      `${R}/git/refs/heads/main`,
      { body: { sha: main, force: true } },
      200,
    );
    await w.spec(
      '/repos/{owner}/{repo}/git/refs/{ref}',
      'delete',
      `${R}/git/refs/heads/feature/x`,
      {},
      204,
    );
    expect((await w.call('DELETE', `${R}/git/refs/heads/feature/x`)).status).toBe(422);
  });

  it('[FAC-BRR-002] force pushes and deletions honour protection rules, admins bypass unless enforced', async () => {
    const w = world();
    const main = w.repo.git.refs.get('refs/heads/main') as string;
    const feature = w.repo.git.refs.get('refs/heads/feature/x') as string;
    await w.call('PATCH', `${R}/git/refs/heads/main`, { body: { sha: feature } });
    const gql = (q: string) => w.call('POST', '/graphql', { body: { query: q } });
    const created = await gql(
      `mutation { createBranchProtectionRule(input:{repositoryId:"${w.repo.nodeId}", pattern:"main", isAdminEnforced:true}) { branchProtectionRule { id } } }`,
    );
    const id = created.body.data.createBranchProtectionRule.branchProtectionRule.id;
    expect(
      (await w.call('PATCH', `${R}/git/refs/heads/main`, { body: { sha: main, force: true } }))
        .status,
    ).toBe(422);
    expect((await w.call('DELETE', `${R}/git/refs/heads/main`)).status).toBe(422);
    await gql(
      `mutation { updateBranchProtectionRule(input:{branchProtectionRuleId:"${id}", isAdminEnforced:false}) { clientMutationId } }`,
    );
    expect(
      (await w.call('PATCH', `${R}/git/refs/heads/main`, { body: { sha: main, force: true } }))
        .status,
    ).toBe(200);
  });

  it('[TST-011] workflow files need the Workflows permission', async () => {
    const w = world();
    const base = w.repo.git.refs.get('refs/heads/main') as string;
    const tree = await w.call('POST', `${R}/git/trees`, {
      body: {
        base_tree: w.repo.git.commits.get(base)?.tree,
        tree: [{ path: '.github/workflows/ci.yml', content: 'on: push\n' }],
      },
    });
    const commit = await w.call('POST', `${R}/git/commits`, {
      body: { message: 'ci', tree: tree.body.sha, parents: [base] },
    });
    const noWorkflows = w.fake.token({ permissions: { contents: 'write', metadata: 'read' } });
    const denied = await w.call('POST', `${R}/git/refs`, {
      token: noWorkflows,
      body: { ref: 'refs/heads/ci', sha: commit.body.sha },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.message).toContain('workflows');
    expect(
      (
        await w.call('POST', `${R}/git/refs`, {
          body: { ref: 'refs/heads/ci', sha: commit.body.sha },
        })
      ).status,
    ).toBe(201);
  });

  it('[TST-011] blobs over the configured maximum are rejected', async () => {
    const w = world();
    w.fake.state.config.maxBlobBytes = 4;
    expect((await w.call('POST', `${R}/git/blobs`, { body: { content: '12345' } })).status).toBe(
      422,
    );
    expect((await w.call('POST', `${R}/git/blobs`, { body: { content: '1234' } })).status).toBe(
      201,
    );
  });
});

describe('contents', () => {
  it('[TST-011] file, directory, root listing and errors', async () => {
    const w = world();
    const file = await w.spec(
      '/repos/{owner}/{repo}/contents/{path}',
      'get',
      `${R}/contents/.github/CODEOWNERS`,
      {},
      200,
    );
    expect(file.body).toMatchObject({
      type: 'file',
      encoding: 'base64',
      name: 'CODEOWNERS',
      path: '.github/CODEOWNERS',
    });
    expect(Buffer.from(file.body.content, 'base64').toString()).toBe('* @acme/platform\n');
    const dir = await w.spec(
      '/repos/{owner}/{repo}/contents/{path}',
      'get',
      `${R}/contents/src`,
      {},
      200,
    );
    expect(dir.body.map((e: { name: string; type: string }) => `${e.type}:${e.name}`)).toEqual([
      'file:a.txt',
      'dir:nested',
    ]);
    const root = await w.spec(
      '/repos/{owner}/{repo}/contents/{path}',
      'get',
      `${R}/contents`,
      {},
      200,
    );
    expect(root.body.map((e: { name: string }) => e.name)).toEqual(['.github', 'README.md', 'src']);
    await w.spec(
      '/repos/{owner}/{repo}/contents/{path}',
      'get',
      `${R}/contents/missing.txt`,
      {},
      404,
    );
    await w.spec(
      '/repos/{owner}/{repo}/contents/{path}',
      'get',
      `${R}/contents/src/new.txt?ref=feature/x`,
      {},
      200,
    );
    expect((await w.call('GET', `${R}/contents/src/new.txt`)).status).toBe(404);
    expect((await w.call('GET', `${R}/contents/README.md?ref=nope`)).body.message).toContain(
      'No commit found',
    );
  });
});

describe('compare', () => {
  it('[TST-011] statuses ahead, behind, identical and diverged with files', async () => {
    const w = world();
    const ahead = await w.spec(
      '/repos/{owner}/{repo}/compare/{basehead}',
      'get',
      `${R}/compare/main...feature/x`,
      {},
      200,
    );
    expect(ahead.body).toMatchObject({
      status: 'ahead',
      ahead_by: 1,
      behind_by: 0,
      total_commits: 1,
    });
    expect(ahead.body.files).toMatchObject([
      { filename: 'src/new.txt', status: 'added', additions: 1 },
    ]);
    const behind = await w.spec(
      '/repos/{owner}/{repo}/compare/{basehead}',
      'get',
      `${R}/compare/feature/x...main`,
      {},
      200,
    );
    expect(behind.body).toMatchObject({ status: 'behind', ahead_by: 0, behind_by: 1 });
    const same = await w.spec(
      '/repos/{owner}/{repo}/compare/{basehead}',
      'get',
      `${R}/compare/main...main`,
      {},
      200,
    );
    expect(same.body.status).toBe('identical');
    w.fake.state.addBranch(
      w.repo,
      'main',
      { ...{ 'README.md': 'changed\n' } },
      { message: 'diverge' },
    );
    const diverged = await w.spec(
      '/repos/{owner}/{repo}/compare/{basehead}',
      'get',
      `${R}/compare/main...feature/x`,
      {},
      200,
    );
    expect(diverged.body).toMatchObject({ status: 'diverged', ahead_by: 1, behind_by: 1 });
    await w.spec(
      '/repos/{owner}/{repo}/compare/{basehead}',
      'get',
      `${R}/compare/main...nope`,
      {},
      404,
    );
  });
});

describe('pull requests', () => {
  it('[LIF-047] create, list, get and update a Change Request', async () => {
    const w = world();
    const created = await w.spec(
      '/repos/{owner}/{repo}/pulls',
      'post',
      `${R}/pulls`,
      { body: { title: 'CR', head: 'feature/x', base: 'main', body: 'b' } },
      201,
    );
    expect(created.body).toMatchObject({ number: 1, state: 'open', commits: 1 });
    expect(w.repo.git.refs.has('refs/pull/1/head')).toBe(true);
    const list = await w.spec(
      '/repos/{owner}/{repo}/pulls',
      'get',
      `${R}/pulls?state=open&head=acme:feature/x`,
      {},
      200,
    );
    expect(list.body).toHaveLength(1);
    await w.spec('/repos/{owner}/{repo}/pulls/{pull_number}', 'get', `${R}/pulls/1`, {}, 200);
    const closed = await w.spec(
      '/repos/{owner}/{repo}/pulls/{pull_number}',
      'patch',
      `${R}/pulls/1`,
      { body: { state: 'closed', title: 'renamed' } },
      200,
    );
    expect(closed.body).toMatchObject({ state: 'closed', title: 'renamed' });
    expect((await w.call('GET', `${R}/pulls`)).body).toEqual([]);
    expect((await w.call('GET', `${R}/pulls?state=all`)).body).toHaveLength(1);
    await w.spec(
      '/repos/{owner}/{repo}/pulls',
      'post',
      `${R}/pulls`,
      { body: { title: 'x', head: 'nope', base: 'main' } },
      422,
    );
    const nothing = await w.spec(
      '/repos/{owner}/{repo}/pulls',
      'post',
      `${R}/pulls`,
      { body: { title: 'x', head: 'main', base: 'main' } },
      422,
    );
    expect(JSON.stringify(nothing.body.errors)).toContain('No commits between');
    expect((await w.call('GET', `${R}/pulls/99`)).status).toBe(404);
  });

  it('[LIF-047] a second open pull request for the same branches is rejected', async () => {
    const w = world();
    await w.call('POST', `${R}/pulls`, { body: { title: 'a', head: 'feature/x', base: 'main' } });
    const dup = await w.call('POST', `${R}/pulls`, {
      body: { title: 'b', head: 'feature/x', base: 'main' },
    });
    expect(dup.status).toBe(422);
    expect(JSON.stringify(dup.body.errors)).toContain('already exists');
  });
});

describe('Git LFS batch API', () => {
  const OID = 'a'.repeat(64);
  const lfs = (
    w: ReturnType<typeof world>,
    body: unknown,
    auth: string | null = `Basic ${Buffer.from(`x-access-token:${w.token}`).toString('base64')}`,
    path = '/acme/auto-ok.git/info/lfs/objects/batch',
  ) =>
    w.fake.app.request(path, {
      method: 'POST',
      headers: {
        ...(auth ? { authorization: auth } : {}),
        'content-type': 'application/vnd.git-lfs+json',
      },
      body: JSON.stringify(body),
    });

  it('[TST-011] download existence check: 200 per object with error.code 404 for missing', async () => {
    const w = world();
    w.fake.state.addLfsObject(w.repo, OID, 123);
    const res = await lfs(w, {
      operation: 'download',
      transfers: ['basic'],
      objects: [
        { oid: OID, size: 123 },
        { oid: 'b'.repeat(64), size: 5 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.git-lfs+json');
    const body = await jsonOf(res);
    expect(body.transfer).toBe('basic');
    expect(body.objects[0]).toMatchObject({ oid: OID, size: 123, authenticated: true });
    expect(body.objects[0].actions.download.href).toContain(OID);
    expect(body.objects[1]).toEqual({
      oid: 'b'.repeat(64),
      size: 5,
      error: { code: 404, message: 'Object does not exist' },
    });
  });

  it('[TST-011] needs credentials; unknown repository is 404; limits and validation', async () => {
    const w = world();
    const noAuth = await lfs(w, { operation: 'download', objects: [] }, null);
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get('www-authenticate')).toContain('Basic');
    expect(
      (
        await lfs(
          w,
          { operation: 'download', objects: [] },
          undefined,
          '/acme/nope.git/info/lfs/objects/batch',
        )
      ).status,
    ).toBe(404);
    expect((await lfs(w, { operation: 'bogus', objects: [] })).status).toBe(422);
    const many = Array.from({ length: 101 }, (_, i) => ({
      oid: String(i).padStart(64, '0'),
      size: 1,
    }));
    expect((await lfs(w, { operation: 'download', objects: many })).status).toBe(413);
    const readOnly = w.fake.token({ permissions: { contents: 'read', metadata: 'read' } });
    const basic = (t: string) => `Basic ${Buffer.from(`x-access-token:${t}`).toString('base64')}`;
    expect(
      (await lfs(w, { operation: 'upload', objects: [{ oid: OID, size: 1 }] }, basic(readOnly)))
        .status,
    ).toBe(403);
    expect(
      (await lfs(w, { operation: 'download', objects: [{ oid: OID, size: 1 }] }, basic(readOnly)))
        .status,
    ).toBe(200);
  });

  it('[TST-011] an authenticated, verified upload is found by a later download check; lfsHas can delegate to the git server', async () => {
    const w = world();
    const oid = createHash('sha256').update('abc').digest('hex');
    const up = await jsonOf(await lfs(w, { operation: 'upload', objects: [{ oid, size: 3 }] }));
    const href = new URL(up.objects[0].actions.upload.href);
    const put = (
      body: string,
      headers: Record<string, string>,
      path = href.pathname + href.search,
    ) => w.fake.app.request(path, { method: 'PUT', body, headers });
    const auth = {
      authorization: `Basic ${Buffer.from(`x-access-token:${w.token}`).toString('base64')}`,
    };
    expect((await put('abc', {})).status).toBe(401);
    expect((await put('abc', { authorization: 'Basic eDp5' })).status).toBe(401);
    const readOnly = w.fake.token({ permissions: { contents: 'read', metadata: 'read' } });
    const ro = {
      authorization: `Basic ${Buffer.from(`x-access-token:${readOnly}`).toString('base64')}`,
    };
    expect((await put('abc', ro)).status).toBe(403);
    const hidden = w.fake.token({ repositoryIds: [w.emptyRepo.id] });
    const hid = {
      authorization: `Basic ${Buffer.from(`x-access-token:${hidden}`).toString('base64')}`,
    };
    expect((await put('abc', hid)).status).toBe(404);
    expect((await put('abd', auth)).status).toBe(422); // sha256 differs from the oid
    expect((await put('abc', auth, `${href.pathname}?size=4`)).status).toBe(422); // size differs
    expect(
      (
        await w.fake.app.request(`/lfs-objects/acme/nope/${oid}`, {
          method: 'PUT',
          body: 'abc',
          headers: auth,
        })
      ).status,
    ).toBe(404);
    expect(w.repo.lfs.has(oid)).toBe(false);
    expect((await put('abc', auth)).status).toBe(200);
    const down = await jsonOf(await lfs(w, { operation: 'download', objects: [{ oid, size: 3 }] }));
    expect(down.objects[0].error).toBeUndefined();
    const delegated = world({ lfsHas: (_repo, oid) => (oid === OID ? 7 : undefined) });
    const res = await jsonOf(
      await lfs(delegated, { operation: 'download', objects: [{ oid: OID, size: 7 }] }),
    );
    expect(res.objects[0].size).toBe(7);
  });
});
