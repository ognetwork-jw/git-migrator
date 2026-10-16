import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { basicAuthEnv, isolatedGitEnv, runGit } from '../git/index.ts';
import { type RunningFakes, startFakes } from '../start.ts';
import { must } from './harness.ts';
import { validateAgainstSpec } from './spec-validation.ts';

// These tests spawn git and servers; a loaded machine needs more than the 5 s default.
vi.setConfig({ testTimeout: 60_000 });

describe('REST reads after a git push (ADR-0070)', () => {
  let running: RunningFakes | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  async function setup() {
    running = await startFakes({ bitbucketPort: 0, githubPort: 0, gitPort: 0 });
    const gh = must(running.github);
    const git = must(running.git);
    const token = gh.token();
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${gh.port}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    };
    const spec = async (template: string, path: string) => {
      const reply = await api('GET', path);
      expect(reply.status, `${path}: ${JSON.stringify(reply.body)}`).toBe(200);
      expect(validateAgainstSpec('get', template, reply.status, reply.body).errors, path).toEqual(
        [],
      );
      return reply.body;
    };
    expect((await api('POST', '/orgs/acme/repos', { name: 'app', private: true })).status).toBe(
      201,
    );
    const home = await mkdtemp(join(tmpdir(), 'gh-git-sync-'));
    const work = join(home, 'work');
    await mkdir(work);
    const run = async (...args: string[]) =>
      (
        await runGit(args, {
          cwd: work,
          env: isolatedGitEnv(home, basicAuthEnv('x-access-token', token)),
        })
      ).stdout.trim();
    const url = git.repoUrl('target', 'acme/app');
    return { gh, api, spec, run, url, work };
  }

  it('[TST-011] refs, tags, branches, commits, contents and REST protection show what was pushed over git', async () => {
    const t = await setup();
    expect((await t.api('GET', '/repos/acme/app/git/matching-refs/heads')).status).toBe(409);
    await t.run('init', '-q', '-b', 'main');
    await mkdir(join(t.work, 'assets'));
    const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 3\n';
    await writeFile(join(t.work, 'assets/sample.bin'), pointer);
    await writeFile(join(t.work, 'README.md'), '# app\n');
    await t.run('add', '.');
    await t.run('commit', '-q', '-m', 'first');
    await t.run('tag', '-a', 'v1.0.0', '-m', 'Release v1.0.0');
    await t.run('tag', 'v1.0.1');
    await t.run('checkout', '-q', '-b', 'develop');
    await writeFile(join(t.work, 'dev.txt'), 'dev\n');
    await t.run('add', '.');
    await t.run('commit', '-q', '-m', 'develop');
    await t.run('push', '-q', t.url, 'main', 'develop', '--tags');
    const main = await t.run('rev-parse', 'main');
    const develop = await t.run('rev-parse', 'develop');
    const tagObject = await t.run('rev-parse', 'v1.0.0');

    const heads = await t.spec(
      '/repos/{owner}/{repo}/git/matching-refs/{ref}',
      '/repos/acme/app/git/matching-refs/heads',
    );
    expect(
      heads.map((r: { ref: string; object: { sha: string } }) => [r.ref, r.object.sha]),
    ).toEqual([
      ['refs/heads/develop', develop],
      ['refs/heads/main', main],
    ]);
    const tags = await t.spec(
      '/repos/{owner}/{repo}/git/matching-refs/{ref}',
      '/repos/acme/app/git/matching-refs/tags',
    );
    expect(tags.map((r: { ref: string; object: object }) => [r.ref, r.object])).toEqual([
      ['refs/tags/v1.0.0', expect.objectContaining({ type: 'tag', sha: tagObject })],
      ['refs/tags/v1.0.1', expect.objectContaining({ type: 'commit', sha: main })],
    ]);
    const commit = await t.spec(
      '/repos/{owner}/{repo}/git/commits/{commit_sha}',
      `/repos/acme/app/git/commits/${develop}`,
    );
    expect(commit.parents.map((p: { sha: string }) => p.sha)).toEqual([main]);
    expect(commit.message).toBe('develop\n');
    const file = await t.spec(
      '/repos/{owner}/{repo}/contents/{path}',
      '/repos/acme/app/contents/assets/sample.bin',
    );
    expect(Buffer.from(file.content, 'base64').toString('utf8')).toBe(pointer);
    const branches = await t.api('GET', '/repos/acme/app/branches');
    expect(branches.body.map((b: { name: string }) => b.name)).toEqual(['develop', 'main']);
    const compare = await t.api('GET', '/repos/acme/app/compare/main...develop');
    expect(compare.body).toMatchObject({ status: 'ahead', ahead_by: 1 });

    // The REST protection read and write take the pushed branch.
    const protect = await t.api('PUT', '/repos/acme/app/branches/main/protection', {
      required_status_checks: null,
      enforce_admins: false,
      required_pull_request_reviews: null,
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
    });
    expect(protect.status).toBe(200);
    const read = await t.spec(
      '/repos/{owner}/{repo}/branches/{branch}/protection',
      '/repos/acme/app/branches/main/protection',
    );
    expect(read.allow_force_pushes.enabled).toBe(false);
    expect(read.allow_deletions.enabled).toBe(false);
  });

  it('[TST-011] a branch deleted by a push disappears from REST; refs created through REST stay', async () => {
    const t = await setup();
    await t.run('init', '-q', '-b', 'main');
    await writeFile(join(t.work, 'a.txt'), 'a\n');
    await t.run('add', '.');
    await t.run('commit', '-q', '-m', 'a');
    await t.run('push', '-q', t.url, 'main', 'main:refs/heads/gone');
    const main = await t.run('rev-parse', 'main');
    const created = await t.api('POST', '/repos/acme/app/git/refs', {
      ref: 'refs/heads/rest-only',
      sha: main,
    });
    expect(created.status).toBe(201);
    await t.run('push', '-q', t.url, ':refs/heads/gone');
    const heads = await t.api('GET', '/repos/acme/app/git/matching-refs/heads');
    expect(heads.body.map((r: { ref: string }) => r.ref)).toEqual([
      'refs/heads/main',
      'refs/heads/rest-only',
    ]);
    expect((await t.api('GET', '/repos/acme/app/git/ref/heads/gone')).status).toBe(404);
  });
});
