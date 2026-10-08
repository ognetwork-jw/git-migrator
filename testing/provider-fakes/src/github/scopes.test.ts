import { describe, expect, it } from 'vitest';
import { world } from './harness.ts';

describe('variables', () => {
  it('[FAC-VAR-003] repository variables: names are upper-cased and validated, CRUD round trip', async () => {
    const w = world();
    await w.spec(
      '/repos/{owner}/{repo}/actions/variables',
      'post',
      '/repos/acme/auto-ok/actions/variables',
      { body: { name: 'my_var', value: '1' } },
      201,
    );
    const got = await w.spec(
      '/repos/{owner}/{repo}/actions/variables/{name}',
      'get',
      '/repos/acme/auto-ok/actions/variables/my_var',
      {},
      200,
    );
    expect(got.body).toMatchObject({ name: 'MY_VAR', value: '1' });
    const dup = await w.call('POST', '/repos/acme/auto-ok/actions/variables', {
      body: { name: 'MY_VAR', value: '2' },
    });
    expect(dup.status).toBe(409);
    for (const name of ['GITHUB_X', '1ABC', 'has-dash', 'a b'])
      expect(
        (
          await w.call('POST', '/repos/acme/auto-ok/actions/variables', {
            body: { name, value: 'x' },
          })
        ).status,
        name,
      ).toBe(422);
    await w.spec(
      '/repos/{owner}/{repo}/actions/variables/{name}',
      'patch',
      '/repos/acme/auto-ok/actions/variables/MY_VAR',
      { body: { value: '3' } },
      204,
    );
    const list = await w.spec(
      '/repos/{owner}/{repo}/actions/variables',
      'get',
      '/repos/acme/auto-ok/actions/variables',
      {},
      200,
    );
    expect(list.body).toMatchObject({
      total_count: 1,
      variables: [{ name: 'MY_VAR', value: '3' }],
    });
    await w.spec(
      '/repos/{owner}/{repo}/actions/variables/{name}',
      'delete',
      '/repos/acme/auto-ok/actions/variables/MY_VAR',
      {},
      204,
    );
    expect((await w.call('GET', '/repos/acme/auto-ok/actions/variables/MY_VAR')).status).toBe(404);
  });

  it('[TST-011] variable lists paginate with default 10 and maximum 30 per page', async () => {
    const w = world();
    for (let i = 0; i < 12; i++) w.fake.state.addVariable(w.repo, `V${i}`, 'x');
    const first = await w.call('GET', '/repos/acme/auto-ok/actions/variables');
    expect(first.body.variables).toHaveLength(10);
    expect(first.body.total_count).toBe(12);
    expect(first.headers.get('link')).toContain('rel="next"');
    expect(
      (await w.call('GET', '/repos/acme/auto-ok/actions/variables?per_page=100')).body.variables,
    ).toHaveLength(12);
  });

  it('[TST-011] environment and organization variables, with selected repositories', async () => {
    const w = world();
    w.fake.state.addEnvironment(w.repo, 'prod');
    await w.spec(
      '/repos/{owner}/{repo}/environments/{environment_name}/variables',
      'post',
      '/repos/acme/auto-ok/environments/prod/variables',
      { body: { name: 'E1', value: 'e' } },
      201,
    );
    await w.spec(
      '/repos/{owner}/{repo}/environments/{environment_name}/variables/{name}',
      'get',
      '/repos/acme/auto-ok/environments/prod/variables/E1',
      {},
      200,
    );
    await w.spec(
      '/repos/{owner}/{repo}/environments/{environment_name}/variables',
      'get',
      '/repos/acme/auto-ok/environments/prod/variables',
      {},
      200,
    );
    await w.spec(
      '/repos/{owner}/{repo}/environments/{environment_name}/variables/{name}',
      'patch',
      '/repos/acme/auto-ok/environments/prod/variables/E1',
      { body: { value: 'f' } },
      204,
    );
    await w.spec(
      '/repos/{owner}/{repo}/environments/{environment_name}/variables/{name}',
      'delete',
      '/repos/acme/auto-ok/environments/prod/variables/E1',
      {},
      204,
    );
    expect((await w.call('GET', '/repos/acme/auto-ok/environments/nope/variables')).status).toBe(
      404,
    );

    await w.spec(
      '/orgs/{org}/actions/variables',
      'post',
      '/orgs/acme/actions/variables',
      {
        body: {
          name: 'ORGV',
          value: 'o',
          visibility: 'selected',
          selected_repository_ids: [w.repo.id],
        },
      },
      201,
    );
    const one = await w.spec(
      '/orgs/{org}/actions/variables/{name}',
      'get',
      '/orgs/acme/actions/variables/ORGV',
      {},
      200,
    );
    expect(one.body.visibility).toBe('selected');
    await w.spec('/orgs/{org}/actions/variables', 'get', '/orgs/acme/actions/variables', {}, 200);
    const repos = await w.spec(
      '/orgs/{org}/actions/variables/{name}/repositories',
      'get',
      '/orgs/acme/actions/variables/ORGV/repositories',
      {},
      200,
    );
    expect(repos.body.repositories.map((x: { name: string }) => x.name)).toEqual(['auto-ok']);
    await w.spec(
      '/orgs/{org}/actions/variables/{name}/repositories/{repository_id}',
      'put',
      `/orgs/acme/actions/variables/ORGV/repositories/${w.emptyRepo.id}`,
      {},
      204,
    );
    await w.spec(
      '/orgs/{org}/actions/variables/{name}/repositories',
      'put',
      '/orgs/acme/actions/variables/ORGV/repositories',
      { body: { selected_repository_ids: [w.emptyRepo.id] } },
      204,
    );
    await w.spec(
      '/orgs/{org}/actions/variables/{name}/repositories/{repository_id}',
      'delete',
      `/orgs/acme/actions/variables/ORGV/repositories/${w.emptyRepo.id}`,
      {},
      204,
    );
    await w.spec(
      '/orgs/{org}/actions/variables/{name}',
      'patch',
      '/orgs/acme/actions/variables/ORGV',
      { body: { visibility: 'all' } },
      204,
    );
    const notSelected = await w.call('GET', '/orgs/acme/actions/variables/ORGV/repositories');
    expect(notSelected.status).toBe(409);
    await w.spec(
      '/orgs/{org}/actions/variables/{name}',
      'delete',
      '/orgs/acme/actions/variables/ORGV',
      {},
      204,
    );
  });
});

describe('secrets (names only)', () => {
  it('[TST-011] never returns values; PUT is 201 then 204; names are upper-case', async () => {
    const w = world();
    const key = await w.spec(
      '/repos/{owner}/{repo}/actions/secrets/public-key',
      'get',
      '/repos/acme/auto-ok/actions/secrets/public-key',
      {},
      200,
    );
    const put = { encrypted_value: 'c2VjcmV0', key_id: key.body.key_id };
    await w.spec(
      '/repos/{owner}/{repo}/actions/secrets/{secret_name}',
      'put',
      '/repos/acme/auto-ok/actions/secrets/my_secret',
      { body: put },
      201,
    );
    await w.spec(
      '/repos/{owner}/{repo}/actions/secrets/{secret_name}',
      'put',
      '/repos/acme/auto-ok/actions/secrets/my_secret',
      { body: put },
      204,
    );
    const got = await w.spec(
      '/repos/{owner}/{repo}/actions/secrets/{secret_name}',
      'get',
      '/repos/acme/auto-ok/actions/secrets/MY_SECRET',
      {},
      200,
    );
    expect(Object.keys(got.body).sort()).toEqual(['created_at', 'name', 'updated_at']);
    const list = await w.spec(
      '/repos/{owner}/{repo}/actions/secrets',
      'get',
      '/repos/acme/auto-ok/actions/secrets',
      {},
      200,
    );
    expect(list.body.secrets.map((s: { name: string }) => s.name)).toEqual(['MY_SECRET']);
    expect(
      (
        await w.call('PUT', '/repos/acme/auto-ok/actions/secrets/X', {
          body: { encrypted_value: 'c2VjcmV0', key_id: 'wrong' },
        })
      ).status,
    ).toBe(422);
    expect(
      (await w.call('PUT', '/repos/acme/auto-ok/actions/secrets/GITHUB_X', { body: put })).status,
    ).toBe(422);
    await w.spec(
      '/repos/{owner}/{repo}/actions/secrets/{secret_name}',
      'delete',
      '/repos/acme/auto-ok/actions/secrets/MY_SECRET',
      {},
      204,
    );
    expect((await w.call('GET', '/repos/acme/auto-ok/actions/secrets/MY_SECRET')).status).toBe(404);
  });

  it('[TST-011] environment and organization secrets', async () => {
    const w = world();
    w.fake.state.addEnvironment(w.repo, 'prod');
    const base = '/repos/acme/auto-ok/environments/prod/secrets';
    const key = await w.spec(
      '/repos/{owner}/{repo}/environments/{environment_name}/secrets/public-key',
      'get',
      `${base}/public-key`,
      {},
      200,
    );
    const put = { encrypted_value: 'AAAA', key_id: key.body.key_id };
    await w.spec(
      '/repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}',
      'put',
      `${base}/S1`,
      { body: put },
      201,
    );
    await w.spec(
      '/repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}',
      'get',
      `${base}/S1`,
      {},
      200,
    );
    await w.spec(
      '/repos/{owner}/{repo}/environments/{environment_name}/secrets',
      'get',
      base,
      {},
      200,
    );
    await w.spec(
      '/repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}',
      'delete',
      `${base}/S1`,
      {},
      204,
    );

    await w.spec(
      '/orgs/{org}/actions/secrets/public-key',
      'get',
      '/orgs/acme/actions/secrets/public-key',
      {},
      200,
    );
    await w.spec(
      '/orgs/{org}/actions/secrets/{secret_name}',
      'put',
      '/orgs/acme/actions/secrets/O1',
      { body: { ...put, visibility: 'selected', selected_repository_ids: [w.repo.id] } },
      201,
    );
    const one = await w.spec(
      '/orgs/{org}/actions/secrets/{secret_name}',
      'get',
      '/orgs/acme/actions/secrets/O1',
      {},
      200,
    );
    expect(one.body.visibility).toBe('selected');
    await w.spec('/orgs/{org}/actions/secrets', 'get', '/orgs/acme/actions/secrets', {}, 200);
    const repos = await w.spec(
      '/orgs/{org}/actions/secrets/{secret_name}/repositories',
      'get',
      '/orgs/acme/actions/secrets/O1/repositories',
      {},
      200,
    );
    expect(repos.body.total_count).toBe(1);
    await w.spec(
      '/orgs/{org}/actions/secrets/{secret_name}/repositories',
      'put',
      '/orgs/acme/actions/secrets/O1/repositories',
      { body: { selected_repository_ids: [w.repo.id, w.emptyRepo.id] } },
      204,
    );
    await w.spec(
      '/orgs/{org}/actions/secrets/{secret_name}/repositories/{repository_id}',
      'delete',
      `/orgs/acme/actions/secrets/O1/repositories/${w.emptyRepo.id}`,
      {},
      204,
    );
    await w.spec(
      '/orgs/{org}/actions/secrets/{secret_name}/repositories/{repository_id}',
      'put',
      `/orgs/acme/actions/secrets/O1/repositories/${w.emptyRepo.id}`,
      {},
      204,
    );
    await w.spec(
      '/orgs/{org}/actions/secrets/{secret_name}',
      'delete',
      '/orgs/acme/actions/secrets/O1',
      {},
      204,
    );
  });
});

describe('webhooks', () => {
  const hookBody = {
    name: 'web',
    active: true,
    events: ['push'],
    config: {
      url: 'https://example.test/hook',
      content_type: 'json',
      secret: 's3cret',
      insecure_ssl: '0',
    },
  };

  it('[TST-011] repository webhooks: CRUD never exposes the secret', async () => {
    const w = world();
    const created = await w.spec(
      '/repos/{owner}/{repo}/hooks',
      'post',
      '/repos/acme/auto-ok/hooks',
      { body: hookBody },
      201,
    );
    expect(created.body.config.secret).toBe('********');
    const id = created.body.id;
    await w.spec(
      '/repos/{owner}/{repo}/hooks/{hook_id}',
      'get',
      `/repos/acme/auto-ok/hooks/${id}`,
      {},
      200,
    );
    await w.spec('/repos/{owner}/{repo}/hooks', 'get', '/repos/acme/auto-ok/hooks', {}, 200);
    const patched = await w.spec(
      '/repos/{owner}/{repo}/hooks/{hook_id}',
      'patch',
      `/repos/acme/auto-ok/hooks/${id}`,
      { body: { add_events: ['pull_request'], active: false } },
      200,
    );
    expect(patched.body.events).toEqual(['push', 'pull_request']);
    expect(patched.body.active).toBe(false);
    const cfg = await w.spec(
      '/repos/{owner}/{repo}/hooks/{hook_id}/config',
      'get',
      `/repos/acme/auto-ok/hooks/${id}/config`,
      {},
      200,
    );
    expect(cfg.body.url).toBe('https://example.test/hook');
    await w.spec(
      '/repos/{owner}/{repo}/hooks/{hook_id}/config',
      'patch',
      `/repos/acme/auto-ok/hooks/${id}/config`,
      { body: { url: 'https://example.test/other' } },
      200,
    );
    await w.spec(
      '/repos/{owner}/{repo}/hooks/{hook_id}/deliveries',
      'get',
      `/repos/acme/auto-ok/hooks/${id}/deliveries`,
      {},
      200,
    );
    expect((await w.call('GET', `/repos/acme/auto-ok/hooks/${id}/deliveries/1`)).status).toBe(404);
    await w.spec(
      '/repos/{owner}/{repo}/hooks/{hook_id}/pings',
      'post',
      `/repos/acme/auto-ok/hooks/${id}/pings`,
      {},
      204,
    );
    await w.spec(
      '/repos/{owner}/{repo}/hooks/{hook_id}/tests',
      'post',
      `/repos/acme/auto-ok/hooks/${id}/tests`,
      {},
      204,
    );
    await w.spec(
      '/repos/{owner}/{repo}/hooks/{hook_id}',
      'delete',
      `/repos/acme/auto-ok/hooks/${id}`,
      {},
      204,
    );
    expect((await w.call('GET', `/repos/acme/auto-ok/hooks/${id}`)).status).toBe(404);
    await w.spec(
      '/repos/{owner}/{repo}/hooks',
      'post',
      '/repos/acme/auto-ok/hooks',
      { body: { config: {} } },
      422,
    );
    expect(JSON.stringify(w.fake.state.snapshot())).not.toContain('s3cret');
  });

  it('[TST-011] organization webhooks', async () => {
    const w = world();
    const created = await w.spec(
      '/orgs/{org}/hooks',
      'post',
      '/orgs/acme/hooks',
      { body: hookBody },
      201,
    );
    const id = created.body.id;
    await w.spec('/orgs/{org}/hooks', 'get', '/orgs/acme/hooks', {}, 200);
    await w.spec('/orgs/{org}/hooks/{hook_id}', 'get', `/orgs/acme/hooks/${id}`, {}, 200);
    await w.spec(
      '/orgs/{org}/hooks/{hook_id}',
      'patch',
      `/orgs/acme/hooks/${id}`,
      { body: { events: ['push', 'repository'] } },
      200,
    );
    await w.spec(
      '/orgs/{org}/hooks/{hook_id}/config',
      'get',
      `/orgs/acme/hooks/${id}/config`,
      {},
      200,
    );
    await w.spec(
      '/orgs/{org}/hooks/{hook_id}/config',
      'patch',
      `/orgs/acme/hooks/${id}/config`,
      { body: { insecure_ssl: '1' } },
      200,
    );
    await w.spec(
      '/orgs/{org}/hooks/{hook_id}/deliveries',
      'get',
      `/orgs/acme/hooks/${id}/deliveries`,
      {},
      200,
    );
    await w.spec(
      '/orgs/{org}/hooks/{hook_id}/pings',
      'post',
      `/orgs/acme/hooks/${id}/pings`,
      {},
      204,
    );
    await w.spec('/orgs/{org}/hooks/{hook_id}', 'delete', `/orgs/acme/hooks/${id}`, {}, 204);
    await w.spec('/orgs/{org}/hooks/{hook_id}', 'get', `/orgs/acme/hooks/${id}`, {}, 404);
  });
});

describe('environments', () => {
  it('[TST-011] environment CRUD with deployment branch policies', async () => {
    const w = world();
    const put = await w.spec(
      '/repos/{owner}/{repo}/environments/{environment_name}',
      'put',
      '/repos/acme/auto-ok/environments/prod',
      {
        body: {
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        },
      },
      200,
    );
    expect(put.body.deployment_branch_policy).toEqual({
      protected_branches: false,
      custom_branch_policies: true,
    });
    await w.spec(
      '/repos/{owner}/{repo}/environments/{environment_name}',
      'get',
      '/repos/acme/auto-ok/environments/prod',
      {},
      200,
    );
    const list = await w.spec(
      '/repos/{owner}/{repo}/environments',
      'get',
      '/repos/acme/auto-ok/environments',
      {},
      200,
    );
    expect(list.body.total_count).toBe(1);
    const pol = await w.spec(
      '/repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies',
      'post',
      '/repos/acme/auto-ok/environments/prod/deployment-branch-policies',
      { body: { name: 'release/*', type: 'branch' } },
      200,
    );
    const base = `/repos/acme/auto-ok/environments/prod/deployment-branch-policies`;
    await w.spec(
      '/repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies',
      'get',
      base,
      {},
      200,
    );
    await w.spec(
      '/repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies/{branch_policy_id}',
      'get',
      `${base}/${pol.body.id}`,
      {},
      200,
    );
    const upd = await w.spec(
      '/repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies/{branch_policy_id}',
      'put',
      `${base}/${pol.body.id}`,
      { body: { name: 'main' } },
      200,
    );
    expect(upd.body.name).toBe('main');
    await w
      .call('POST', base, { body: { name: 'main', type: 'branch' } })
      .then((x) => expect(x.status).toBe(422));
    await w.spec(
      '/repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies/{branch_policy_id}',
      'delete',
      `${base}/${pol.body.id}`,
      {},
      204,
    );
    await w.spec(
      '/repos/{owner}/{repo}/environments/{environment_name}',
      'delete',
      '/repos/acme/auto-ok/environments/prod',
      {},
      204,
    );
  });

  it('[TST-011] policies need custom branch policies; both flags true or false is 422', async () => {
    const w = world();
    await w.call('PUT', '/repos/acme/auto-ok/environments/prod', { body: {} });
    const r = await w.call(
      'POST',
      '/repos/acme/auto-ok/environments/prod/deployment-branch-policies',
      { body: { name: 'x' } },
    );
    expect(r.status).toBe(303);
    const bad = await w.call('PUT', '/repos/acme/auto-ok/environments/prod', {
      body: {
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: true },
      },
    });
    expect(bad.status).toBe(422);
  });

  it('[TST-011] reviewers and wait timers are rejected on private Team repositories, accepted on public ones', async () => {
    const w = world();
    const rejected = await w.spec(
      '/repos/{owner}/{repo}/environments/{environment_name}',
      'put',
      '/repos/acme/auto-ok/environments/prod',
      { body: { wait_timer: 30 } },
      422,
    );
    expect(rejected.body.errors[0].field).toBe('wait_timer');
    const alice = w.fake.state.findUser('alice');
    expect(
      (
        await w.call('PUT', '/repos/acme/auto-ok/environments/prod', {
          body: { reviewers: [{ type: 'User', id: alice?.id }] },
        })
      ).status,
    ).toBe(422);
    const pub = w.fake.state.addRepository('acme', { name: 'pub', private: false });
    const ok = await w.spec(
      '/repos/{owner}/{repo}/environments/{environment_name}',
      'put',
      `/repos/acme/pub/environments/prod`,
      { body: { wait_timer: 30, reviewers: [{ type: 'User', id: alice?.id }] } },
      200,
    );
    expect(ok.body.protection_rules.map((r: { type: string }) => r.type)).toEqual([
      'wait_timer',
      'required_reviewers',
    ]);
    expect(pub.environments).toHaveLength(1);
    w.fake.state.config.environmentProtection = 'ignore';
    const ignored = await w.call('PUT', '/repos/acme/auto-ok/environments/stage', {
      body: { wait_timer: 30 },
    });
    expect(ignored.status).toBe(200);
    expect(ignored.body.protection_rules).toEqual([]);
    expect(
      (
        await w.call('PUT', '/repos/acme/pub/environments/many', {
          body: { reviewers: Array.from({ length: 7 }, () => ({ type: 'User', id: alice?.id })) },
        })
      ).status,
    ).toBe(422);
  });
});
