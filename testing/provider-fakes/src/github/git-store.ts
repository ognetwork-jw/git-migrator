import { sha1 } from './util.ts';

/**
 * A tiny in-memory git object store (blobs, trees, commits, refs) with real git object hashing, so
 * the REST Git Data API, contents and compare endpoints work without the git server. The real
 * bytes are served by T-040's server; `RepoRecord.gitRoot` is the seam to it.
 */

export interface TreeEntry {
  path: string;
  mode: '100644' | '100755' | '040000' | '120000' | '160000';
  type: 'blob' | 'tree' | 'commit';
  sha: string;
}

export interface Signature {
  name: string;
  email: string;
  date: string;
}

export interface GitCommit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  author: Signature;
  committer: Signature;
}

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const BASE_DATE = Date.UTC(2026, 0, 1);

export class GitStore {
  readonly blobs = new Map<string, Buffer>();
  readonly trees = new Map<string, TreeEntry[]>();
  readonly commits = new Map<string, GitCommit>();
  /** Full ref names (`refs/heads/main`) to commit shas. */
  readonly refs = new Map<string, string>();
  private tick = 0;

  constructor() {
    this.trees.set(EMPTY_TREE, []);
  }

  /** A deterministic, strictly increasing commit date (the git side never uses the wall clock). */
  nextDate(): string {
    this.tick += 1;
    return new Date(BASE_DATE + this.tick * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  putBlob(content: Buffer | string): string {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const sha = sha1(`blob ${buf.length}\0`, buf);
    this.blobs.set(sha, buf);
    return sha;
  }

  putTree(entries: TreeEntry[]): string {
    const sorted = [...entries].sort((a, b) => {
      const ka = a.type === 'tree' ? `${a.path}/` : a.path;
      const kb = b.type === 'tree' ? `${b.path}/` : b.path;
      return Buffer.compare(Buffer.from(ka), Buffer.from(kb));
    });
    const body = Buffer.concat(
      sorted.map((e) =>
        Buffer.concat([
          Buffer.from(`${e.mode.replace(/^0+/, '')} ${e.path}\0`),
          Buffer.from(e.sha, 'hex'),
        ]),
      ),
    );
    const sha = sha1(`tree ${body.length}\0`, body);
    this.trees.set(sha, sorted);
    return sha;
  }

  putCommit(input: {
    tree: string;
    parents?: string[];
    message: string;
    author?: Partial<Signature>;
    committer?: Partial<Signature>;
  }): GitCommit {
    const date = this.nextDate();
    const author: Signature = {
      name: input.author?.name ?? 'Fake Author',
      email: input.author?.email ?? 'author@fake.invalid',
      date: input.author?.date ?? date,
    };
    const committer: Signature = {
      name: input.committer?.name ?? author.name,
      email: input.committer?.email ?? author.email,
      date: input.committer?.date ?? author.date,
    };
    const parents = input.parents ?? [];
    const sig = (s: Signature) =>
      `${s.name} <${s.email}> ${Math.floor(Date.parse(s.date) / 1000)} +0000`;
    const text = `tree ${input.tree}\n${parents.map((p) => `parent ${p}\n`).join('')}author ${sig(author)}\ncommitter ${sig(committer)}\n\n${input.message}`;
    const sha = sha1(`commit ${Buffer.byteLength(text)}\0`, text);
    const commit: GitCommit = {
      sha,
      tree: input.tree,
      parents,
      message: input.message,
      author,
      committer,
    };
    this.commits.set(sha, commit);
    return commit;
  }

  /** Writes a nested tree for a flat `path -> content` map and returns its sha. */
  treeFromFiles(files: Record<string, string | Buffer>): string {
    interface Dir {
      files: Map<string, string>;
      dirs: Map<string, Dir>;
    }
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, content] of Object.entries(files)) {
      const parts = path.split('/');
      const name = parts.pop() as string;
      let dir = root;
      for (const part of parts) {
        let next = dir.dirs.get(part);
        if (!next) {
          next = { files: new Map(), dirs: new Map() };
          dir.dirs.set(part, next);
        }
        dir = next;
      }
      dir.files.set(name, this.putBlob(content));
    }
    const write = (dir: Dir): string => {
      const entries: TreeEntry[] = [];
      for (const [name, sha] of dir.files)
        entries.push({ path: name, mode: '100644', type: 'blob', sha });
      for (const [name, sub] of dir.dirs)
        entries.push({ path: name, mode: '040000', type: 'tree', sha: write(sub) });
      return this.putTree(entries);
    };
    return write(root);
  }

  /** Writes nested trees for a flat `path -> { mode, sha }` map (blob entries) and returns the root sha. */
  treeFromFlat(flat: Map<string, { mode: string; sha: string }>): string {
    interface Dir {
      files: Map<string, { mode: TreeEntry['mode']; sha: string }>;
      dirs: Map<string, Dir>;
    }
    const root: Dir = { files: new Map(), dirs: new Map() };
    for (const [path, v] of flat) {
      const parts = path.split('/');
      const name = parts.pop() as string;
      let dir = root;
      for (const part of parts) {
        let next = dir.dirs.get(part);
        if (!next) {
          next = { files: new Map(), dirs: new Map() };
          dir.dirs.set(part, next);
        }
        dir = next;
      }
      dir.files.set(name, { mode: v.mode as TreeEntry['mode'], sha: v.sha });
    }
    const write = (dir: Dir): string => {
      const entries: TreeEntry[] = [];
      for (const [name, f] of dir.files)
        entries.push({
          path: name,
          mode: f.mode,
          type: f.mode === '160000' ? 'commit' : 'blob',
          sha: f.sha,
        });
      for (const [name, sub] of dir.dirs)
        entries.push({ path: name, mode: '040000', type: 'tree', sha: write(sub) });
      return this.putTree(entries);
    };
    return write(root);
  }

  /** Flattens a tree to `path -> { mode, sha }` for blob (and submodule) entries. */
  flatten(treeSha: string, prefix = ''): Map<string, { mode: string; sha: string }> {
    const out = new Map<string, { mode: string; sha: string }>();
    for (const e of this.trees.get(treeSha) ?? []) {
      if (e.type === 'tree') {
        for (const [p, v] of this.flatten(e.sha, `${prefix}${e.path}/`)) out.set(p, v);
      } else out.set(`${prefix}${e.path}`, { mode: e.mode, sha: e.sha });
    }
    return out;
  }

  /** Creates a commit on `ref` (creating the branch if needed) holding exactly `files`. */
  commitFiles(
    ref: string,
    files: Record<string, string | Buffer>,
    message: string,
    options: { parents?: string[]; author?: Partial<Signature> } = {},
  ): GitCommit {
    const parents = options.parents ?? (this.refs.has(ref) ? [this.refs.get(ref) as string] : []);
    const commit = this.putCommit({
      tree: this.treeFromFiles(files),
      parents,
      message,
      author: options.author,
    });
    this.refs.set(ref, commit.sha);
    return commit;
  }

  filesAt(commitSha: string): Map<string, { mode: string; sha: string }> {
    const c = this.commits.get(commitSha);
    return c ? this.flatten(c.tree) : new Map();
  }

  /** All ancestors of `sha` including itself, nearest first (breadth-first). */
  ancestors(sha: string): string[] {
    const seen = new Set<string>();
    const queue = [sha];
    const out: string[] = [];
    while (queue.length) {
      const next = queue.shift() as string;
      if (seen.has(next) || !this.commits.has(next)) continue;
      seen.add(next);
      out.push(next);
      queue.push(...(this.commits.get(next)?.parents ?? []));
    }
    return out;
  }

  isAncestor(maybeAncestor: string, descendant: string): boolean {
    return this.ancestors(descendant).includes(maybeAncestor);
  }

  mergeBase(a: string, b: string): string | undefined {
    const ofA = new Set(this.ancestors(a));
    return this.ancestors(b).find((s) => ofA.has(s));
  }

  /** Commits reachable from `head` but not from `base`, oldest first. */
  range(base: string, head: string): GitCommit[] {
    const exclude = new Set(this.ancestors(base));
    return this.ancestors(head)
      .filter((s) => !exclude.has(s))
      .reverse()
      .map((s) => this.commits.get(s) as GitCommit);
  }

  /** `refs/heads/x`, `heads/x`, `x`, a tag or a sha to a commit sha. */
  resolve(rev: string): string | undefined {
    if (/^[0-9a-f]{40}$/.test(rev) && this.commits.has(rev)) return rev;
    for (const candidate of [rev, `refs/${rev}`, `refs/heads/${rev}`, `refs/tags/${rev}`]) {
      const sha = this.refs.get(candidate);
      if (sha) return sha;
    }
    return undefined;
  }

  branches(): string[] {
    return [...this.refs.keys()]
      .filter((r) => r.startsWith('refs/heads/'))
      .map((r) => r.slice('refs/heads/'.length))
      .sort();
  }

  get isEmpty(): boolean {
    return this.branches().length === 0;
  }
}
