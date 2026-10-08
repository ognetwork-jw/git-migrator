import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findingSpec } from '@git-migrator/guidance';
import {
  basicAuthEnv,
  isolatedGitEnv,
  type RunningFakes,
  runGit,
} from '@git-migrator/provider-fakes';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorldFakes } from './start.ts';
import { fakePublicKey } from './world.ts';
import { WORLD_WORKSPACE as W, WORLD_LIMITS, WORLD_REPOSITORIES } from './world-spec.ts';
import { renderExpectationTable } from './world-table.ts';

const BB_AUTH = `Basic ${Buffer.from('operator@test.local:fake-bitbucket-api-token').toString('base64')}`;
let fakes: RunningFakes;
/** Arguments of every `setLimits('target', …)` call, to observe which limits are in force. */
const targetLimits: { maxBlobBytes?: number | null; maxPushBytes?: number | null }[] = [];
const lastTargetLimits = () => targetLimits[targetLimits.length - 1];

const bbUrl = (path: string) => `http://127.0.0.1:${fakes.bitbucket.port}/2.0${path}`;
const bb = async (path: string) => {
  const res = await fetch(bbUrl(path), { headers: { Authorization: BB_AUTH } });
  return { status: res.status, body: (await res.json()) as any };
};
const bareOf = (slug: string) => fakes.git?.repoDir('source', `${W}/${slug}`) ?? '';
const git = async (slug: string, ...args: string[]) =>
  (await runGit(args, { cwd: bareOf(slug), env: isolatedGitEnv(fakes.git?.rootDir ?? '') })).stdout;
const post = (port: number, fixture: string) =>
  fetch(`http://127.0.0.1:${port}/__reset`, { method: 'POST', body: JSON.stringify({ fixture }) });

beforeAll(async () => {
  fakes = await startWorldFakes({ bitbucketPort: 0, githubPort: 0, gitPort: 0 });
  const server = fakes.git;
  if (server) {
    const original = server.setLimits.bind(server);
    server.setLimits = (side, limits) => {
      if (side === 'target') targetLimits.push(limits);
      original(side, limits);
    };
  }
  // The control plane over HTTP, as the integration tier uses it.
  expect((await post(fakes.github?.port ?? 0, 'world')).status).toBe(200);
  expect((await post(fakes.bitbucket.port, 'world')).status).toBe(200);
}, 120_000);

afterAll(async () => {
  await fakes?.close();
});

describe('fixture world', () => {
  it('[TST-012] /__reset world builds every repository in its project with git data', async () => {
    const list = await bb(`/repositories/${W}?pagelen=100`);
    expect(list.status).toBe(200);
    const bySlug = new Map<string, any>(list.body.values.map((r: any) => [r.slug, r]));
    expect(bySlug.size).toBe(WORLD_REPOSITORIES.length);
    for (const r of WORLD_REPOSITORIES) {
      expect(bySlug.get(r.slug)?.project.key, r.key).toBe(r.project);
      expect(await git(r.slug, 'rev-parse', '--verify', 'refs/heads/main')).toMatch(
        /^[0-9a-f]{40}/,
      );
    }
    const projects = await bb(`/workspaces/${W}/projects`);
    expect(projects.body.values.map((p: any) => p.key).sort()).toEqual([
      'DATA',
      'KEYS',
      'OPS',
      'PLAT',
    ]);
  });

  it('[TST-012] plat/auto-ok mirrors the live fixture', async () => {
    const names = (await git('auto-ok', 'for-each-ref', '--format=%(refname:short)', 'refs/heads'))
      .trim()
      .split('\n')
      .sort();
    expect(names).toEqual(['develop', 'feature/one', 'main']);
    expect(await git('auto-ok', 'cat-file', '-t', 'v1.0.0')).toBe('tag\n');
    expect(await git('auto-ok', 'cat-file', '-t', 'v1.0.1')).toBe('commit\n');
    const pointer = await git('auto-ok', 'show', 'main:assets/sample.bin');
    const oid = /oid sha256:([0-9a-f]{64})/.exec(pointer)?.[1] ?? '';
    expect(await fakes.git?.lfsStore('source').size(`${W}/auto-ok`, oid)).toBe(1_000_000);

    const base = `/repositories/${W}/auto-ok`;
    const restr = (await bb(`${base}/branch-restrictions`)).body.values;
    expect(restr.map((r: any) => r.kind).sort()).toEqual(['delete', 'force']);
    expect(restr.every((r: any) => r.users.length === 0 && r.groups.length === 0)).toBe(true);
    expect((await bb(`${base}/deploy-keys`)).body.values).toHaveLength(1);
    const vars = (await bb(`${base}/pipelines_config/variables`)).body.values;
    expect(vars.map((v: any) => v.key)).toContain('E2E_VAR');
    expect(vars.some((v: any) => v.secured)).toBe(false);
    expect((await bb(`${base}/environments`)).body.values).toHaveLength(1);
    expect((await bb(`${base}/permissions-config/users`)).body.values).toHaveLength(0);
    expect((await bb(`${base}/permissions-config/groups`)).body.values).toHaveLength(0);
    expect((await bb(`${base}/hooks`)).body.values).toHaveLength(0);
    expect((await bb(`${base}/pullrequests?state=OPEN`)).body.values).toHaveLength(0);
    expect((await bb(`${base}/pipelines_config`)).body.enabled).toBe(false);
    const branch = await bb(`${base}/refs/branches/develop`);
    expect(branch.body.target.hash).toBe(
      (await git('auto-ok', 'rev-parse', 'refs/heads/develop')).trim(),
    );
    const proj = await bb(`/workspaces/${W}/projects/PLAT/deploy-keys`);
    expect(proj.body.values).toHaveLength(0);
  });

  it('[TST-012] the other repositories have the shapes their expectations rely on', async () => {
    const r = (slug: string) => `/repositories/${W}/${slug}`;
    expect((await bb(`${r('with-grants')}/permissions-config/groups`)).body.values).toHaveLength(1);
    expect((await bb(`${r('with-grants')}/permissions-config/users`)).body.values).toHaveLength(2);
    const push = (await bb(`${r('with-grants')}/branch-restrictions`)).body.values[0];
    expect(push.kind).toBe('push');
    expect(push.groups.map((g: any) => g.slug)).toEqual(['platform-team']);
    const vars = (await bb(`${r('with-secrets')}/pipelines_config/variables`)).body.values;
    expect(vars.filter((v: any) => v.secured)).toHaveLength(1);
    expect((await bb(`${r('open-pr')}/pullrequests?state=OPEN`)).body.values).toHaveLength(1);
    expect((await bb(`${r('unmapped-user')}/permissions-config/users`)).body.values).toHaveLength(
      1,
    );
    for (const slug of ['pipelines-simple', 'pipelines-pipes']) {
      expect((await bb(`${r(slug)}/pipelines_config`)).body.enabled).toBe(true);
      const src = await fetch(bbUrl(`${r(slug)}/src/main/bitbucket-pipelines.yml`), {
        headers: { Authorization: BB_AUTH },
      });
      expect(await src.text()).toContain('pipelines:');
      expect(await git(slug, 'show', 'main:bitbucket-pipelines.yml')).toContain('pipelines:');
    }
    expect(await git('pipelines-pipes', 'show', 'main:bitbucket-pipelines.yml')).toContain('pipe:');
    expect(await git('pipelines-simple', 'show', 'main:bitbucket-pipelines.yml')).not.toContain(
      'pipe:',
    );
    const hooks = (await bb(`${r('hooks')}/hooks`)).body.values;
    expect(hooks.map((h: any) => h.url).sort()).toEqual([
      'https://hooks.acme.example/ci',
      'https://thirdparty.example/hooks/bitbucket',
    ]);
    expect(hooks.find((h: any) => h.url.startsWith('https://thirdparty')).secret_set).toBe(true);
    const k1 = (await bb(`/workspaces/${W}/projects/KEYS/deploy-keys`)).body.values;
    expect(k1).toHaveLength(1);
    expect(k1[0].key).toBe(fakePublicKey('shared-project-key'));
    expect(k1[0].key).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI/);
    const wiki = (await bb(r('wiki-issues'))).body;
    expect(wiki.has_wiki && wiki.has_issues).toBe(true);
    expect((await bb(`${r('wiki-issues')}/issues?pagelen=1`)).body.size).toBe(3);
    expect((await bb(`${r('wiki-issues')}/downloads?pagelen=1`)).body.size).toBe(2);
  });

  it('[TST-012] the wiki of ops/wiki-issues has refs over the git server (FAC-EXT ls-remote)', async () => {
    const url = `${fakes.git?.repoUrl('source', `${W}/wiki-issues`)}/wiki`;
    const out = await runGit(['ls-remote', url], {
      env: { ...isolatedGitEnv(fakes.git?.rootDir ?? ''), ...basicAuthEnv('x', 'fake-token') },
    });
    expect(out.stdout).toMatch(/refs\/heads\/main/);
  });

  it('[TST-012] ops/big-blob holds a 2 MiB blob over the target limit, ops/large-history exceeds the push limit', async () => {
    const size = Number((await git('big-blob', 'cat-file', '-s', 'main:data/dump.bin')).trim());
    expect(size).toBe(2 * 1024 * 1024);
    expect(size).toBeGreaterThan(WORLD_LIMITS.maxBlobBytes);
    const count = Number((await git('large-history', 'rev-list', '--count', 'main')).trim());
    expect(count).toBeGreaterThanOrEqual(60);
    const total = (
      await git('large-history', 'rev-list', '--objects', '--disk-usage', 'main')
    ).trim();
    expect(Number(total)).toBeGreaterThan(3 * WORLD_LIMITS.maxPushBytes);
  });

  it('[TST-012] the limits are set on the fake GitHub and the git target side', async () => {
    const state = fakes.github?.state;
    expect(state?.config.maxBlobBytes).toBe(WORLD_LIMITS.maxBlobBytes);
  });

  it('[TST-012] the GitHub org acme has no repositories or teams and matching members', () => {
    const state = fakes.github?.state;
    const org = state?.orgs.get('acme');
    expect(state?.repos.size).toBe(0);
    expect(org?.teams).toHaveLength(0);
    expect([...(org?.members.keys() ?? [])].sort()).toEqual(['alice-gh', 'bob', 'erin']);
    expect(state?.findUser('alice-gh')?.publicEmail).toBe('alice@acme.example');
    expect(state?.findUser('bob')?.email).toBeNull();
  });

  it('[TST-012] two resets give the same commit ids and ids', async () => {
    const before = (
      await git('auto-ok', 'for-each-ref', '--format=%(refname) %(objectname)')
    ).trim();
    const state1 = JSON.stringify(
      (
        (await (await fetch(`http://127.0.0.1:${fakes.bitbucket.port}/__state`)).json()) as {
          state: unknown;
        }
      ).state,
    );
    expect((await post(fakes.bitbucket.port, 'world')).status).toBe(200);
    const after = (
      await git('auto-ok', 'for-each-ref', '--format=%(refname) %(objectname)')
    ).trim();
    const state2 = JSON.stringify(
      (
        (await (await fetch(`http://127.0.0.1:${fakes.bitbucket.port}/__state`)).json()) as {
          state: unknown;
        }
      ).state,
    );
    expect(after).toBe(before);
    expect(state2).toBe(state1);
  }, 60_000);

  it('[TST-012] default naming collides exactly the two collision repositories', () => {
    const names = new Map<string, string[]>();
    for (const r of WORLD_REPOSITORIES) {
      const key = r.plannedTargetName.toLowerCase();
      names.set(key, [...(names.get(key) ?? []), r.key]);
    }
    const collisions = [...names.values()].filter((v) => v.length > 1);
    expect(collisions).toEqual([['ops/name-collision-a', 'ops/name_collision_a']]);
    for (const r of WORLD_REPOSITORIES) {
      const kebab = `${r.project.toLowerCase()}-${r.slug
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')}`;
      expect(r.plannedTargetName).toBe(kebab);
    }
  });

  it('[TST-012] every expected finding is a known code with the same severity, and readiness follows LIF-004', () => {
    for (const r of WORLD_REPOSITORIES) {
      for (const o of [r.analysis, ...(r.stages ?? [])]) {
        for (const f of o.findings) {
          const spec = findingSpec(f.code);
          expect(spec, `${r.key} ${f.code}`).toBeDefined();
          expect(spec?.severity, `${r.key} ${f.code}`).toBe(f.severity);
        }
        const expected = o.findings.some((f) => f.severity === 'blocker')
          ? 'blocked'
          : o.findings.some((f) => f.severity === 'pre')
            ? 'needs_attention'
            : 'ready';
        // The run-origin blocker of ops/big-blob is a blocker too, so the rule is uniform.
        expect(o.readiness, r.key).toBe(expected);
      }
    }
  });

  it('[TST-012] the README table equals the expectation data', () => {
    const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8');
    expect(readme).toContain(renderExpectationTable());
  });
  it('[TST-012] resetting to empty removes the world git state and restores the target limits, and world rebuilds it', async () => {
    const gitRoot = fakes.git;
    expect(gitRoot).toBeDefined();
    expect((await post(fakes.github?.port ?? 0, 'empty')).status).toBe(200);
    expect((await post(fakes.bitbucket.port, 'empty')).status).toBe(200);
    expect(existsSync(bareOf('auto-ok'))).toBe(false);
    expect(existsSync(join(gitRoot?.lfsStore('source').dir ?? '', W))).toBe(false);
    expect(fakes.github?.state.config.maxBlobBytes).toBe(100 * 1024 * 1024);
    expect(lastTargetLimits()?.maxBlobBytes).toBe(100 * 1024 * 1024);
    expect(lastTargetLimits()?.maxPushBytes).toBe(2 * 1024 * 1024 * 1024);
    expect((await bb(`/repositories/${W}`)).status).toBe(404);

    expect((await post(fakes.github?.port ?? 0, 'world')).status).toBe(200);
    expect((await post(fakes.bitbucket.port, 'world')).status).toBe(200);
    expect(existsSync(bareOf('auto-ok'))).toBe(true);
    expect(lastTargetLimits()).toEqual(WORLD_LIMITS);
    expect((await bb(`/repositories/${W}?pagelen=1`)).status).toBe(200);
  }, 60_000);
});
