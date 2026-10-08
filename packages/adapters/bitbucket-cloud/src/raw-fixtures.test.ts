/** The drivers against raw provider JSON (fixtures/), served through the `fetch` seam. */
import { readFileSync } from 'node:fs';
import type { AdapterContext } from '@git-migrator/adapter-sdk';
import { describe, expect, it } from 'vitest';
import { bitbucketCloudAdapter } from './adapter.ts';
import { driverCtx, facet, target } from './harness.test.ts';

const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

const ROUTES: [RegExp, string][] = [
  [/\/effective-branching-model$/, 'effective-branching-model.json'],
  [/\/branch-restrictions$/, 'branch-restrictions.json'],
  [/\/refs\/branches\/main$/, 'branch-main.json'],
  [/\/branching-model\/settings$/, 'branching-model-settings.json'],
  [/\/hooks$/, 'webhooks.json'],
  [/\/deploy-keys$/, 'deploy-keys.json'],
  [/\/pipelines_config\/variables$/, 'pipeline-variables.json'],
  [/\/environments$/, 'environments.json'],
  [/\/permissions-config\/users$/, 'permissions-users.json'],
  [/\/workspaces\/acme\/permissions$/, 'workspace-permissions.json'],
  [/\/workspaces\/acme\/members$/, 'workspace-permissions.json'],
  [/\/1\.0\/groups\/acme$/, 'groups-1.0.json'],
  [/\/repositories\/acme\/auto-ok$/, 'repository.json'],
];

async function connect() {
  const requested: string[] = [];
  const fetchSeam: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requested.push(url.pathname);
    const hit = ROUTES.find(([re]) => re.test(url.pathname));
    const empty = { pagelen: 100, values: [] };
    return new Response(JSON.stringify(hit ? load(hit[1]) : empty), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const ctx = {
    quota: {
      acquire: async () => ({ granted: true, at: new Date(), buckets: [] }) as never,
      recordFeedback: async () => {},
      recordRateLimited: async () => new Date(),
      recordSecondaryLimit: async () => new Date(),
      adjust: async () => {},
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    fetch: fetchSeam,
    environment: 'test',
    git: { lsRemote: async () => ({ refs: [] }) },
    pool: 'background',
    signal: new AbortController().signal,
  } satisfies AdapterContext;
  const conn = await bitbucketCloudAdapter.connect(
    {
      id: 'bb',
      baseUrl: 'http://localhost:4010',
      config: { workspace: 'acme' },
      credential: { accountId: 'a', email: 'e@x.io', apiToken: 'tok-123456' },
      accountKey: 'a',
    },
    ctx,
  );
  return { conn, requested };
}

describe('drivers over raw provider JSON', () => {
  it('[FAC-BRR-001] branch-rules reads the real-shaped restrictions and branching model', async () => {
    const { conn } = await connect();
    const res = await facet(conn, 'branch-rules').read(driverCtx(conn), target());
    expect((res.data as { rules: { pattern: string }[] }).rules.map((r) => r.pattern)).toEqual([
      '**',
      'feature/**',
      'main',
      'release/**',
    ]);
    expect(res.warnings.map((w: { code: string }) => w.code).sort()).toEqual([
      'branch-rules.branching-model',
      'branch-rules.unknown-kind',
    ]);
  });

  it('[FAC-MRG-002] merge-settings reads the branch and the string default_branch_deletion', async () => {
    const { conn } = await connect();
    const res = await facet(conn, 'merge-settings').read(driverCtx(conn), target());
    expect(res.data).toEqual({
      allowed: ['merge-commit', 'squash', 'rebase', 'fast-forward-only'],
      deleteBranchOnMerge: true,
    });
  });

  it('[FAC-WEB-001] webhooks, deploy-keys, variables and environments read the raw shapes', async () => {
    const { conn } = await connect();
    const ctx = driverCtx(conn);
    const hooks = await facet(conn, 'webhooks').read(ctx, target());
    expect((hooks.data as { hooks: unknown[] }).hooks).toHaveLength(2);
    const keys = await facet(conn, 'deploy-keys').read(ctx, target());
    expect((keys.data as { keys: unknown[] }).keys).toHaveLength(1);
    const vars = await facet(conn, 'variables').read(ctx, target());
    expect((vars.data as { variables: { key: string }[] }).variables.map((v) => v.key)).toContain(
      'repository/NODE_ENV',
    );
    const secrets = await facet(conn, 'secrets').read(ctx, target());
    expect((secrets.data as { secrets: { key: string }[] }).secrets.map((v) => v.key)).toContain(
      'repository/NPM_TOKEN',
    );
  });

  it('[FAC-ACL-001] access-control reads real-shaped permissions; the owner is implicit', async () => {
    const { conn } = await connect();
    const res = await facet(conn, 'access-control').read(driverCtx(conn), target());
    const grants = (res.data as { grants: { principal: { id: string }; role: string }[] }).grants;
    expect(grants.map((g) => `${g.principal.id}:${g.role}`)).toContain('developers:write');
    expect(JSON.stringify(grants)).not.toContain('11111111-aaaa');
  });

  it('[FAC-END] members read the workspace permission list', async () => {
    const { conn } = await connect();
    const res = await facet(conn, 'members').read(driverCtx(conn), {
      scope: 'endpoint',
      namespace: { providerId: 'acme', slug: 'acme' },
    });
    expect((res.data as { members: { role: string }[] }).members.map((m) => m.role).sort()).toEqual(
      ['admin', 'member'],
    );
  });
});
