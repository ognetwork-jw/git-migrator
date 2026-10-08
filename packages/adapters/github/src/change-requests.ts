/**
 * ChangeRequestWriter (LIF-047): branch `git-migrator/<purpose>` from the default branch head, one
 * commit authored by git-migrator, one pull request. Idempotent: an open one is updated, a merged
 * one is never reopened.
 */
import {
  AdapterError,
  type ChangeRequestState,
  type ChangeRequestWriter,
  type MutationRecord,
  type RepositoryRef,
} from '@git-migrator/adapter-sdk';
import { PROVIDER } from './config.ts';
import { encodePath, type Gh, type Json, obj, repoPath, str } from './gh.ts';

export const AUTHOR = { name: 'git-migrator', email: 'noreply@git-migrator.invalid' };

const record = (
  action: MutationRecord['action'],
  resourceRef: Record<string, unknown>,
  before: unknown,
  after: unknown,
): MutationRecord => ({
  facetKey: 'change-requests',
  action,
  resourceRef,
  paths: [],
  before: before ?? null,
  after: after ?? null,
});

function stateOf(pr: Json): ChangeRequestState {
  if (pr.merged === true || (typeof pr.merged_at === 'string' && pr.merged_at !== ''))
    return 'merged';
  return pr.state === 'open' ? 'open' : 'closed';
}

function conflict(message: string): AdapterError {
  return new AdapterError({ code: 'conflict', provider: PROVIDER, message });
}

/** Records already written when a call fails midway; the runner still has to ledger them (LIF-045). */
export function partialMutations(error: unknown): MutationRecord[] {
  const list = (error as { mutations?: unknown } | null)?.mutations;
  return Array.isArray(list) ? (list as MutationRecord[]) : [];
}

export function createChangeRequestWriter(
  gh: () => Gh,
  org: string,
  /** Link to the Migration in the app, appended to the body (LIF-047 step 3). */
  migrationUrl?: (repo: RepositoryRef) => string | undefined,
): ChangeRequestWriter {
  const branchOf = (purpose: string) => `git-migrator/${purpose}`;

  /** The newest pull request from the purpose branch (any state), open ones first. */
  async function find(client: Gh, repo: string, branch: string): Promise<Json | undefined> {
    const list = await client.list<Json>(`${repoPath(org, repo)}/pulls`, {
      state: 'all',
      head: `${org}:${branch}`,
    });
    return (
      list.find((p) => p.state === 'open') ??
      list.sort((a, b) => Number(b.number) - Number(a.number))[0]
    );
  }

  /**
   * Adopting an existing purpose branch (ADR-0231 §13): every commit it is ahead of the default branch
   * by must be authored by git-migrator. One compare call; anything else is refused without a write.
   */
  async function refuseForeignCommits(
    client: Gh,
    base: string,
    defaultBranch: string,
    branch: string,
  ): Promise<void> {
    const res = obj(
      await client.get(`${base}/compare/${encodePath(defaultBranch)}...${encodePath(branch)}`, {
        per_page: 250,
      }),
    );
    const commits = Array.isArray(res.commits) ? (res.commits as unknown[]) : [];
    const total = typeof res.total_commits === 'number' ? res.total_commits : commits.length;
    const foreign = commits.some((c) => str(obj(obj(obj(c).commit).author).email) !== AUTHOR.email);
    // Commits not all listed cannot be checked: refuse them as well.
    if (foreign || total > commits.length) {
      throw conflict(
        `The branch ${branch} already exists and holds commits that git-migrator did not make; not writing to it`,
      );
    }
  }

  async function fileAt(
    client: Gh,
    base: string,
    path: string,
    ref: string,
  ): Promise<string | undefined> {
    const file = await client.getOrNull<Json>(`${base}/contents/${encodePath(path)}`, { ref });
    if (!file || Array.isArray(file) || typeof file.content !== 'string') return undefined;
    return Buffer.from(file.content, 'base64').toString('utf8');
  }

  return {
    async upsert(ref: RepositoryRef, rawReq) {
      const mutations: MutationRecord[] = [];
      try {
        return await upsertInto(ref, rawReq, mutations);
      } catch (error) {
        // Keep what was already written: a retry sees the branch and would record nothing.
        if (error !== null && typeof error === 'object') Object.assign(error, { mutations });
        throw error;
      }
    },

    async status(ref, purpose) {
      const pr = await find(gh(), ref.slug, branchOf(purpose));
      return pr ? stateOf(pr) : 'none';
    },

    async close(ref, purpose) {
      return closeChangeRequest(ref, purpose);
    },
  };

  async function upsertInto(
    ref: RepositoryRef,
    rawReq: Parameters<ChangeRequestWriter['upsert']>[1],
    mutations: MutationRecord[],
  ) {
    const link = migrationUrl?.(ref);
    const req =
      link !== undefined && !rawReq.body.includes(link)
        ? { ...rawReq, body: `${rawReq.body}\n\nMigration: ${link}` }
        : rawReq;
    const client = gh();
    const repo = ref.slug;
    const base = repoPath(org, repo);
    if (req.branch !== branchOf(req.purpose)) {
      throw new AdapterError({
        code: 'invalid',
        provider: PROVIDER,
        message: 'The branch of a Change Request must be git-migrator/<purpose>',
      });
    }
    const info = obj(await client.get(base));
    const defaultBranch = str(info.default_branch);
    const repoUrl = str(info.html_url);
    const existing = await find(client, repo, req.branch);
    if (existing && stateOf(existing) === 'merged') {
      return { url: str(existing.html_url), state: 'merged' as const, mutations };
    }
    const defaultRef = await client.getOrNull<Json>(
      `${base}/git/ref/heads/${encodePath(defaultBranch)}`,
    );
    if (!defaultRef)
      throw conflict('The repository has no default branch yet; push the refs first');
    const defaultSha = str(obj(defaultRef.object).sha);
    const branchRef = await client.getOrNull<Json>(
      `${base}/git/ref/heads/${encodePath(req.branch)}`,
    );
    const baseRef = branchRef ? req.branch : defaultBranch;
    if (branchRef) await refuseForeignCommits(client, base, defaultBranch, req.branch);

    const changed: { path: string; content: string }[] = [];
    for (const file of req.files) {
      if ((await fileAt(client, base, file.path, baseRef)) !== file.content) changed.push(file);
    }
    const open = existing && stateOf(existing) === 'open' ? existing : undefined;
    if (changed.length === 0 && !open) {
      // Nothing to change and nothing open: the content is already on the branch (or default).
      if (branchRef && baseRef === req.branch) {
        // Branch has the content but no open PR: fall through to open one.
      } else {
        return { url: repoUrl, state: 'merged' as const, mutations };
      }
    }

    let headSha = branchRef ? str(obj(branchRef.object).sha) : defaultSha;
    if (branchRef && !open) {
      // The branch exists but no pull request does: an earlier call died after creating it. It is
      // ours by name, so ledger it now (adopted) or a rollback would never find it.
      mutations.push(
        record(
          'create',
          { kind: 'ref', repository: repo, ref: `refs/heads/${req.branch}`, adopted: true },
          { sha: headSha },
          { sha: headSha },
        ),
      );
    }
    if (!branchRef) {
      await client.send('POST', `${base}/git/refs`, {
        ref: `refs/heads/${req.branch}`,
        sha: defaultSha,
      });
      mutations.push(
        record('create', { kind: 'ref', repository: repo, ref: `refs/heads/${req.branch}` }, null, {
          sha: defaultSha,
        }),
      );
    }
    if (changed.length > 0) {
      const parent = obj(await client.get(`${base}/git/commits/${headSha}`));
      const tree: { path: string; mode: string; type: string; sha: string }[] = [];
      for (const file of changed) {
        const blob = obj(
          await client.send('POST', `${base}/git/blobs`, {
            content: file.content,
            encoding: 'utf-8',
          }),
        );
        tree.push({ path: file.path, mode: '100644', type: 'blob', sha: str(blob.sha) });
      }
      const newTree = obj(
        await client.send('POST', `${base}/git/trees`, {
          base_tree: str(obj(parent.tree).sha),
          tree,
        }),
      );
      const commit = obj(
        await client.send('POST', `${base}/git/commits`, {
          message: `${req.title}\n\nPurpose: ${req.purpose}`,
          tree: str(newTree.sha),
          parents: [headSha],
          author: { ...AUTHOR, date: new Date().toISOString() },
          committer: { ...AUTHOR, date: new Date().toISOString() },
        }),
      );
      await client.send('PATCH', `${base}/git/refs/heads/${encodePath(req.branch)}`, {
        sha: str(commit.sha),
        force: false,
      });
      mutations.push(
        record(
          'update',
          { kind: 'ref', repository: repo, ref: `refs/heads/${req.branch}` },
          { sha: headSha },
          {
            sha: str(commit.sha),
            files: changed.map((f) => f.path),
          },
        ),
      );
      headSha = str(commit.sha);
    }

    if (open) {
      const patch: Json = {};
      if (str(open.title) !== req.title) patch.title = req.title;
      if (str(open.body) !== req.body) patch.body = req.body;
      if (Object.keys(patch).length > 0) {
        await client.send('PATCH', `${base}/pulls/${open.number}`, patch);
        mutations.push(
          record(
            'update',
            { kind: 'change-request', repository: repo, number: open.number },
            { title: open.title },
            patch,
          ),
        );
      }
      return { url: str(open.html_url), state: 'open' as const, mutations };
    }
    let created: Json;
    try {
      created = obj(
        await client.send('POST', `${base}/pulls`, {
          title: req.title,
          head: req.branch,
          base: defaultBranch,
          body: req.body,
        }),
      );
    } catch (error) {
      // A lost response may still have opened the Change Request: read back and ledger it (ADR-0222).
      const found = await find(client, repo, req.branch).catch(() => undefined);
      if (
        !(error instanceof AdapterError && error.code === 'transient') ||
        found === undefined ||
        stateOf(found) !== 'open'
      ) {
        throw error;
      }
      created = found;
    }
    mutations.push(
      record(
        'create',
        {
          kind: 'change-request',
          repository: repo,
          number: created.number,
          purpose: req.purpose,
        },
        null,
        {
          title: req.title,
          branch: req.branch,
        },
      ),
    );
    return { url: str(created.html_url), state: 'open' as const, mutations };
  }

  async function closeChangeRequest(ref: RepositoryRef, purpose: string) {
    const client = gh();
    const pr = await find(client, ref.slug, branchOf(purpose));
    if (!pr || stateOf(pr) !== 'open') return [];
    await client.send('PATCH', `${repoPath(org, ref.slug)}/pulls/${pr.number}`, {
      state: 'closed',
    });
    return [
      record(
        'update',
        { kind: 'change-request', repository: ref.slug, number: pr.number },
        { state: 'open' },
        { state: 'closed' },
      ),
    ];
  }
}
