import type { GitStore } from '../git-store.ts';
import { paginate } from '../link.ts';
import type { Out, Req, Router } from '../router.ts';
import { checkRefUpdate, type RefUpdateKind } from '../rules.ts';
import { GitHubState } from '../state.ts';
import type { PullRec, RepoRec } from '../types.ts';
import { forbidden, GhError, invalidField, notFound, validationFailed } from '../util.ts';

const EMPTY = () => new GhError(409, 'Git Repository is empty.');
const HIDDEN_PREFIX = 'refs/pull/';
/** `refs/pull/*` is read-only: GitHub answers `deny updating a hidden ref` (provider doc, Quirks). */
export const isHiddenRef = (ref: string): boolean => ref.startsWith(HIDDEN_PREFIX);

const normRef = (ref: string): string => `refs/${ref.replace(/^refs\//, '')}`;

function needNonEmpty(repo: RepoRec): void {
  if (repo.git.isEmpty) throw EMPTY();
}

function refBody(q: Req, repo: RepoRec, ref: string, sha: string) {
  const api = `${q.ser.base}/repos/${repo.owner}/${repo.name}`;
  return {
    ref,
    node_id: `REF_${Buffer.from(ref).toString('base64url')}`,
    url: `${api}/git/${ref}`,
    object: { type: 'commit', sha, url: `${api}/git/commits/${sha}` },
  };
}

/** Workflow files need the Workflows permission, like GitHub Apps on real GitHub. */
function checkWorkflows(q: Req, git: GitStore, oldSha: string | undefined, newSha: string): void {
  if (GitHubState.allows(q.auth.permissions, 'workflows', 'write')) return;
  const before = oldSha ? git.filesAt(oldSha) : new Map();
  for (const [path, v] of git.filesAt(newSha))
    if (path.startsWith('.github/workflows/') && before.get(path)?.sha !== v.sha)
      throw forbidden(
        `refusing to allow a GitHub App to create or update workflow \`${path}\` without \`workflows\` permission`,
      );
}

function lineCounts(a: string, b: string): { additions: number; deletions: number } {
  const count = (lines: string[]) => {
    const m = new Map<string, number>();
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const split = (s: string) => (s ? s.replace(/\n$/, '').split('\n') : []);
  const oldM = count(split(a));
  const newM = count(split(b));
  let additions = 0;
  let deletions = 0;
  for (const [l, n] of newM) additions += Math.max(0, n - (oldM.get(l) ?? 0));
  for (const [l, n] of oldM) deletions += Math.max(0, n - (newM.get(l) ?? 0));
  return { additions, deletions };
}

export function registerGit(r: Router, state: GitHubState): void {
  const read = ['contents', 'read'] as const;
  const write = ['contents', 'write'] as const;

  // -- refs ---------------------------------------------------------------------------------------

  r.get('/repos/:owner/:repo/git/ref/:ref{.+}', read, (q) => {
    const repo = q.repo();
    needNonEmpty(repo);
    const ref = normRef(q.param('ref'));
    const sha = repo.git.refs.get(ref);
    if (!sha) throw notFound();
    return { body: refBody(q, repo, ref, sha) };
  });

  r.get('/repos/:owner/:repo/git/matching-refs/:ref{.+}', read, (q) => {
    const repo = q.repo();
    needNonEmpty(repo);
    const prefix = normRef(q.param('ref'));
    const refs = [...repo.git.refs]
      .filter(([name]) => name.startsWith(prefix) && !isHiddenRef(name))
      .sort(([a], [b]) => a.localeCompare(b));
    return q.page(refs, ([name, sha]) => refBody(q, repo, name, sha));
  });

  r.post('/repos/:owner/:repo/git/refs', write, async (q) => {
    const repo = q.repo();
    needNonEmpty(repo); // "cannot create refs in a repository with no branches" (provider doc)
    const body = await q.body();
    const ref = body.ref;
    const sha = body.sha;
    if (typeof ref !== 'string' || !ref.startsWith('refs/') || ref.split('/').length < 3)
      throw validationFailed({ resource: 'Reference', code: 'invalid', field: 'ref' });
    if (typeof sha !== 'string')
      throw validationFailed({ resource: 'Reference', code: 'missing_field', field: 'sha' });
    if (isHiddenRef(ref)) throw new GhError(422, 'Reference update failed');
    if (repo.git.refs.has(ref)) throw new GhError(422, 'Reference already exists');
    if (!repo.git.commits.has(sha)) throw new GhError(422, 'Object does not exist');
    refProtection(q, repo, ref, 'create');
    checkWorkflows(q, repo.git, undefined, sha);
    repo.git.refs.set(ref, sha);
    repo.pushedAt = state.clock();
    return { status: 201, body: refBody(q, repo, ref, sha) };
  });

  r.patch('/repos/:owner/:repo/git/refs/:ref{.+}', write, async (q) => {
    const repo = q.repo();
    needNonEmpty(repo);
    const ref = normRef(q.param('ref'));
    const body = await q.body();
    const sha = body.sha;
    if (typeof sha !== 'string')
      throw validationFailed({ resource: 'Reference', code: 'missing_field', field: 'sha' });
    if (isHiddenRef(ref)) throw new GhError(422, 'Reference update failed');
    const current = repo.git.refs.get(ref);
    if (!current) throw new GhError(422, 'Reference does not exist');
    if (!repo.git.commits.has(sha)) throw new GhError(422, 'Object does not exist');
    const fastForward = repo.git.isAncestor(current, sha);
    if (!fastForward && body.force !== true) throw new GhError(422, 'Update is not a fast forward');
    refProtection(q, repo, ref, fastForward ? 'update' : 'force');
    checkWorkflows(q, repo.git, current, sha);
    repo.git.refs.set(ref, sha);
    repo.pushedAt = state.clock();
    return { body: refBody(q, repo, ref, sha) };
  });

  r.delete('/repos/:owner/:repo/git/refs/:ref{.+}', write, (q) => {
    const repo = q.repo();
    needNonEmpty(repo);
    const ref = normRef(q.param('ref'));
    if (isHiddenRef(ref)) throw new GhError(422, 'Reference update failed');
    if (!repo.git.refs.has(ref)) throw new GhError(422, 'Reference does not exist');
    refProtection(q, repo, ref, 'delete');
    repo.git.refs.delete(ref);
    return {};
  });

  // -- commits, trees, blobs ----------------------------------------------------------------------

  r.get('/repos/:owner/:repo/git/commits/:sha', read, (q) => {
    const repo = q.repo();
    needNonEmpty(repo);
    const c = repo.git.commits.get(q.param('sha'));
    if (!c) throw notFound();
    return { body: q.ser.gitCommit(repo, c) };
  });

  r.post('/repos/:owner/:repo/git/commits', write, async (q) => {
    const repo = q.repo();
    needNonEmpty(repo);
    const body = await q.body();
    if (typeof body.message !== 'string')
      throw validationFailed({ resource: 'Commit', code: 'missing_field', field: 'message' });
    if (typeof body.tree !== 'string')
      throw validationFailed({ resource: 'Commit', code: 'missing_field', field: 'tree' });
    if (!repo.git.trees.has(body.tree)) throw new GhError(422, 'Tree SHA does not exist');
    const parents = (body.parents as string[] | undefined) ?? [];
    for (const p of parents)
      if (!repo.git.commits.has(p)) throw new GhError(422, `Parent SHA ${p} does not exist`);
    const sig = (v: unknown) =>
      v && typeof v === 'object'
        ? (v as { name: string; email: string; date?: string })
        : undefined;
    const author = sig(body.author) ?? {
      name: q.auth.actor,
      email: `${q.auth.actor}@users.noreply.github.invalid`,
    };
    const commit = repo.git.putCommit({
      tree: body.tree,
      parents,
      message: body.message,
      author,
      committer: sig(body.committer) ?? author,
    });
    return { status: 201, body: q.ser.gitCommit(repo, commit) };
  });

  const treeBody = (q: Req, repo: RepoRec, sha: string, recursive: boolean) => {
    const api = `${q.ser.base}/repos/${repo.owner}/${repo.name}`;
    const entries = recursive
      ? [...repo.git.flatten(sha)].map(([path, v]) => ({
          path,
          mode: v.mode,
          type: v.mode === '160000' ? 'commit' : 'blob',
          sha: v.sha,
        }))
      : (repo.git.trees.get(sha) ?? []);
    return {
      sha,
      url: `${api}/git/trees/${sha}`,
      truncated: false,
      tree: entries.map((e) => ({
        path: e.path,
        mode: e.mode,
        type: e.type,
        sha: e.sha,
        ...(e.type === 'blob' ? { size: repo.git.blobs.get(e.sha)?.length ?? 0 } : {}),
        url: `${api}/git/${e.type === 'tree' ? 'trees' : 'blobs'}/${e.sha}`,
      })),
    };
  };

  r.get('/repos/:owner/:repo/git/trees/:sha{.+}', read, (q) => {
    const repo = q.repo();
    needNonEmpty(repo);
    const arg = q.param('sha');
    const commit = repo.git.resolve(arg);
    const sha = repo.git.trees.has(arg)
      ? arg
      : commit
        ? repo.git.commits.get(commit)?.tree
        : undefined;
    if (!sha) throw notFound();
    const recursive =
      q.url.searchParams.has('recursive') &&
      q.url.searchParams.get('recursive') !== '0' &&
      q.url.searchParams.get('recursive') !== 'false';
    return { body: treeBody(q, repo, sha, recursive) };
  });

  r.post('/repos/:owner/:repo/git/trees', write, async (q) => {
    const repo = q.repo();
    needNonEmpty(repo);
    const body = await q.body();
    if (!Array.isArray(body.tree))
      throw validationFailed({ resource: 'Tree', code: 'missing_field', field: 'tree' });
    let flat = new Map<string, { mode: string; sha: string }>();
    if (body.base_tree !== undefined) {
      if (typeof body.base_tree !== 'string' || !repo.git.trees.has(body.base_tree))
        throw new GhError(422, 'base_tree does not exist');
      flat = repo.git.flatten(body.base_tree);
    }
    for (const raw of body.tree as Record<string, unknown>[]) {
      const path = raw.path;
      if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('//'))
        throw validationFailed({ resource: 'Tree', code: 'invalid', field: 'path' });
      const mode = (raw.mode as string | undefined) ?? '100644';
      if (!['100644', '100755', '120000', '160000', '040000'].includes(mode))
        throw validationFailed({ resource: 'Tree', code: 'invalid', field: 'mode' });
      if (raw.sha === null) {
        flat.delete(path);
        continue;
      }
      let sha = raw.sha as string | undefined;
      if (typeof raw.content === 'string') sha = repo.git.putBlob(raw.content);
      if (!sha || !(repo.git.blobs.has(sha) || mode === '160000'))
        throw validationFailed({
          resource: 'Tree',
          code: 'invalid',
          field: 'sha',
          message: 'GitRPC::BadObjectState',
        });
      flat.set(path, { mode, sha });
    }
    const sha = repo.git.treeFromFlat(flat);
    return { status: 201, body: treeBody(q, repo, sha, false) };
  });

  r.post('/repos/:owner/:repo/git/blobs', write, async (q) => {
    const repo = q.repo();
    needNonEmpty(repo);
    const body = await q.body();
    if (typeof body.content !== 'string')
      throw validationFailed({ resource: 'Blob', code: 'missing_field', field: 'content' });
    const encoding = (body.encoding as string | undefined) ?? 'utf-8';
    if (encoding !== 'utf-8' && encoding !== 'base64')
      throw validationFailed({ resource: 'Blob', code: 'invalid', field: 'encoding' });
    const buf =
      encoding === 'base64'
        ? Buffer.from(body.content, 'base64')
        : Buffer.from(body.content, 'utf8');
    if (buf.length > state.config.maxBlobBytes)
      throw validationFailed({
        resource: 'Blob',
        code: 'custom',
        field: 'content',
        message: 'file is too large',
      });
    const sha = repo.git.putBlob(buf);
    return {
      status: 201,
      body: { sha, url: `${q.ser.base}/repos/${repo.owner}/${repo.name}/git/blobs/${sha}` },
    };
  });

  // -- contents -----------------------------------------------------------------------------------

  const contents = (q: Req, rawPath: string): Out => {
    const repo = q.repo();
    if (repo.git.isEmpty) throw notFound('This repository is empty.');
    const ref = q.url.searchParams.get('ref') ?? repo.defaultBranch;
    const commitSha = repo.git.resolve(ref);
    if (!commitSha) throw new GhError(404, `No commit found for the ref ${ref}`);
    const path = rawPath.replace(/^\/+|\/+$/g, '');
    const files = repo.git.filesAt(commitSha);
    const api = `${q.ser.base}/repos/${repo.owner}/${repo.name}`;
    const html = `${q.ser.base}/${repo.owner}/${repo.name}`;
    const item = (p: string, type: 'file' | 'dir', sha: string, size: number) => ({
      type,
      size,
      name: p.split('/').pop() as string,
      path: p,
      sha,
      url: `${api}/contents/${p}?ref=${ref}`,
      git_url: `${api}/git/${type === 'dir' ? 'trees' : 'blobs'}/${sha}`,
      html_url: `${html}/${type === 'dir' ? 'tree' : 'blob'}/${ref}/${p}`,
      download_url: type === 'file' ? `${html}/raw/${ref}/${p}` : null,
      _links: {
        self: `${api}/contents/${p}?ref=${ref}`,
        git: `${api}/git/${type === 'dir' ? 'trees' : 'blobs'}/${sha}`,
        html: `${html}/${type === 'dir' ? 'tree' : 'blob'}/${ref}/${p}`,
      },
    });
    const file = path ? files.get(path) : undefined;
    if (file) {
      const buf = repo.git.blobs.get(file.sha) ?? Buffer.alloc(0);
      const tooBig = buf.length > 1024 * 1024;
      return {
        body: {
          ...item(path, 'file', file.sha, buf.length),
          content: tooBig
            ? ''
            : (buf.toString('base64').match(/.{1,60}/g) ?? []).join('\n') +
              (buf.length ? '\n' : ''),
          encoding: tooBig ? 'none' : 'base64',
        },
      };
    }
    // Directory listing: direct children of `path`.
    const prefix = path ? `${path}/` : '';
    const children = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
    for (const [p, v] of files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const first = rest.split('/')[0] as string;
      if (rest.includes('/')) {
        if (!children.has(first))
          children.set(first, {
            type: 'dir',
            sha: dirSha(repo, commitSha, `${prefix}${first}`),
            size: 0,
          });
      } else
        children.set(first, {
          type: 'file',
          sha: v.sha,
          size: repo.git.blobs.get(v.sha)?.length ?? 0,
        });
    }
    if (!children.size) throw notFound();
    const list = [...children]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, c]) => item(`${prefix}${name}`, c.type, c.sha, c.size));
    return { body: list };
  };
  r.get('/repos/:owner/:repo/contents', read, (q) => contents(q, ''));
  r.get('/repos/:owner/:repo/contents/:path{.+}', read, (q) => contents(q, q.param('path')));

  // -- compare ------------------------------------------------------------------------------------

  r.get('/repos/:owner/:repo/compare/:basehead{.+}', read, (q) => {
    const repo = q.repo();
    const m = /^(.+?)\.{2,3}(.+)$/.exec(q.param('basehead'));
    if (!m) throw notFound();
    const resolve = (v: string) => repo.git.resolve(v.replace(/^[^:/]+:/, ''));
    const base = resolve(m[1] as string);
    const head = resolve(m[2] as string);
    if (!base || !head) throw notFound();
    const git = repo.git;
    const mergeBase = git.mergeBase(base, head);
    if (!mergeBase) throw new GhError(404, `No common ancestor between ${m[1]} and ${m[2]}.`);
    const ahead = git.range(base, head);
    const behind = git.range(head, base);
    const status =
      base === head
        ? 'identical'
        : ahead.length && behind.length
          ? 'diverged'
          : ahead.length
            ? 'ahead'
            : 'behind';
    const api = `${q.ser.base}/repos/${repo.owner}/${repo.name}`;
    const html = `${q.ser.base}/${repo.owner}/${repo.name}`;
    const spec = `${m[1]}...${m[2]}`;
    const paged = paginate(ahead, q.url, { perPage: 250, max: 250 });
    const oldFiles = git.filesAt(mergeBase);
    const newFiles = git.filesAt(head);
    const files: unknown[] = [];
    for (const path of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
      const o = oldFiles.get(path);
      const n = newFiles.get(path);
      if (o?.sha === n?.sha) continue;
      const text = (sha?: string) =>
        sha ? (git.blobs.get(sha) ?? Buffer.alloc(0)).toString('utf8') : '';
      const { additions, deletions } = lineCounts(text(o?.sha), text(n?.sha));
      const sha = (n ?? o)?.sha as string;
      files.push({
        sha,
        filename: path,
        status: !o ? 'added' : !n ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
        blob_url: `${html}/blob/${head}/${path}`,
        raw_url: `${html}/raw/${head}/${path}`,
        contents_url: `${api}/contents/${path}?ref=${head}`,
      });
    }
    const commit = (sha: string) => q.ser.commit(repo, git.commits.get(sha) as never);
    return {
      body: {
        url: `${api}/compare/${spec}`,
        html_url: `${html}/compare/${spec}`,
        permalink_url: `${html}/compare/${repo.owner}:${base}...${repo.owner}:${head}`,
        diff_url: `${html}/compare/${spec}.diff`,
        patch_url: `${html}/compare/${spec}.patch`,
        base_commit: commit(base),
        merge_base_commit: commit(mergeBase),
        status,
        ahead_by: ahead.length,
        behind_by: behind.length,
        total_commits: ahead.length,
        commits: paged.items.map((c) => q.ser.commit(repo, c)),
        files,
      },
      headers: paged.link ? { link: paged.link } : undefined,
    };
  });

  // -- pull requests ------------------------------------------------------------------------------

  const pullOf = (q: Req): PullRec => {
    const p = q.repo().pulls.find((x) => x.number === Number(q.param('number')));
    if (!p) throw notFound();
    return p;
  };

  r.get('/repos/:owner/:repo/pulls', ['pull_requests', 'read'], (q) => {
    const repo = q.repo();
    const st = q.url.searchParams.get('state') ?? 'open';
    if (!['open', 'closed', 'all'].includes(st)) throw invalidField('PullRequest', 'state');
    const head = q.url.searchParams.get('head')?.replace(/^[^:]+:/, '');
    const base = q.url.searchParams.get('base');
    let pulls = repo.pulls.filter(
      (p) =>
        (st === 'all' || p.state === st) &&
        (!head || p.headRef === head) &&
        (!base || p.baseRef === base),
    );
    if (q.url.searchParams.get('direction') !== 'asc') pulls = [...pulls].reverse();
    return q.page(pulls, (p) => q.ser.pullSimple(repo, p));
  });

  r.post('/repos/:owner/:repo/pulls', ['pull_requests', 'write'], async (q) => {
    const repo = q.repo();
    const body = await q.body();
    if (typeof body.title !== 'string' || !body.title)
      throw validationFailed({ resource: 'PullRequest', code: 'missing_field', field: 'title' });
    if (typeof body.head !== 'string')
      throw validationFailed({ resource: 'PullRequest', code: 'missing_field', field: 'head' });
    if (typeof body.base !== 'string')
      throw validationFailed({ resource: 'PullRequest', code: 'missing_field', field: 'base' });
    const head = body.head.replace(/^[^:]+:/, '');
    if (repo.pulls.some((p) => p.state === 'open' && p.headRef === head && p.baseRef === body.base))
      throw validationFailed({
        resource: 'PullRequest',
        code: 'custom',
        message: `A pull request already exists for ${repo.owner}:${head}.`,
      });
    const pull = state.addPull(repo, {
      title: body.title,
      head,
      base: body.base,
      body: (body.body as string | undefined) ?? null,
      draft: body.draft === true,
      user: q.auth.actor,
    });
    return { status: 201, body: q.ser.pull(repo, pull) };
  });

  r.get('/repos/:owner/:repo/pulls/:number', ['pull_requests', 'read'], (q) => ({
    body: q.ser.pull(q.repo(), pullOf(q)),
  }));

  r.patch('/repos/:owner/:repo/pulls/:number', ['pull_requests', 'write'], async (q) => {
    const repo = q.repo();
    const p = pullOf(q);
    const body = await q.body();
    if (typeof body.title === 'string') p.title = body.title;
    if ('body' in body) p.body = (body.body as string | null) ?? null;
    if (body.state !== undefined) {
      if (body.state !== 'open' && body.state !== 'closed')
        throw invalidField('PullRequest', 'state');
      p.state = body.state;
      p.closedAt = body.state === 'closed' ? state.clock() : null;
    }
    if (typeof body.base === 'string') {
      const sha = repo.git.refs.get(`refs/heads/${body.base}`);
      if (!sha) throw invalidField('PullRequest', 'base');
      p.baseRef = body.base;
      p.baseSha = sha;
    }
    p.updatedAt = state.clock();
    return { body: q.ser.pull(repo, p) };
  });
}

function dirSha(repo: RepoRec, commitSha: string, path: string): string {
  let tree = repo.git.commits.get(commitSha)?.tree as string;
  for (const part of path.split('/')) {
    const e = repo.git.trees.get(tree)?.find((x) => x.path === part && x.type === 'tree');
    if (!e) return tree;
    tree = e.sha;
  }
  return tree;
}

/** Branch protection for REST ref writes; the actor is the App behind the installation token. */
function refProtection(q: Req, repo: RepoRec, ref: string, kind: RefUpdateKind): void {
  const message = checkRefUpdate(repo, ref, kind, {
    nodeIds: q.auth.app ? [q.auth.app.nodeId] : [],
    isAdmin: GitHubState.allows(q.auth.permissions, 'administration', 'write'),
  });
  if (message) throw new GhError(422, message);
}
