import { spawn } from 'node:child_process';
import type { GitStore, GitTag, Signature, TreeEntry } from './git-store.ts';

/**
 * Reads a bare repository of the git server's `target` side into the fake GitHub's in-memory object
 * store, so the REST reads (refs, branches, commits, trees, contents, compare, branch protection on
 * an existing branch) show what was pushed over git, as they do on GitHub. Objects are added (never
 * removed, so objects written through the REST Git Data API stay); refs read from the bare repository
 * replace the ones read last time, and a ref that disappeared from it (a deleted branch) is dropped.
 * Refs that only exist in memory (`refs/pull/*`, refs created through REST) are kept.
 */
export async function importBareRepository(bareDir: string, store: GitStore): Promise<void> {
  const refsOut = await git(bareDir, [
    'for-each-ref',
    '--format=%(objectname) %(refname)',
    'refs/heads',
    'refs/tags',
  ]);
  const refs = new Map<string, string>();
  for (const line of refsOut.toString('utf8').split('\n')) {
    const i = line.indexOf(' ');
    if (i > 0) refs.set(line.slice(i + 1), line.slice(0, i));
  }
  const objects = await git(bareDir, ['cat-file', '--batch-all-objects', '--batch']);
  readObjects(objects, store);
  for (const ref of store.importedRefs) if (!refs.has(ref)) store.refs.delete(ref);
  store.importedRefs.clear();
  for (const [ref, sha] of refs) {
    store.refs.set(ref, sha);
    store.importedRefs.add(ref);
  }
}

/** Parses `git cat-file --batch` output (`<sha> <type> <size>\n<content>\n` per object). */
function readObjects(out: Buffer, store: GitStore): void {
  let at = 0;
  while (at < out.length) {
    const eol = out.indexOf(0x0a, at);
    if (eol < 0) break;
    const [sha, type, size] = out.subarray(at, eol).toString('latin1').split(' ');
    const length = Number(size);
    if (!sha || !type || !Number.isFinite(length)) break;
    const body = out.subarray(eol + 1, eol + 1 + length);
    at = eol + 1 + length + 1;
    if (type === 'blob') store.blobs.set(sha, Buffer.from(body));
    else if (type === 'tree') store.trees.set(sha, parseTree(body));
    else if (type === 'commit') store.commits.set(sha, { sha, ...parseCommit(body) });
    else if (type === 'tag') store.tags.set(sha, { sha, ...parseTag(body) });
  }
}

function parseTree(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    const nul = body.indexOf(0x00, space);
    const mode = body.subarray(at, space).toString('latin1');
    const path = body.subarray(space + 1, nul).toString('utf8');
    const sha = body.subarray(nul + 1, nul + 21).toString('hex');
    at = nul + 21;
    const type = mode === '40000' ? 'tree' : mode === '160000' ? 'commit' : 'blob';
    entries.push({
      path,
      mode: (mode === '40000' ? '040000' : mode) as TreeEntry['mode'],
      type,
      sha,
    });
  }
  return entries;
}

/** Headers up to the first blank line (continuation lines start with a space), then the message. */
function headersOf(body: Buffer): { headers: [string, string][]; message: string } {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const headers: [string, string][] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith(' ')) continue; // continuation of a multi-line header (gpgsig)
    const i = line.indexOf(' ');
    headers.push(i < 0 ? [line, ''] : [line.slice(0, i), line.slice(i + 1)]);
  }
  return { headers, message };
}

/** `Name <email> 1700000000 +0100` -> name, email and the instant as ISO 8601 UTC. */
function signature(value: string): Signature {
  const m = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(value);
  if (!m) return { name: value, email: '', date: new Date(0).toISOString() };
  const date = new Date(Number(m[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { name: m[1] as string, email: m[2] as string, date };
}

function parseCommit(body: Buffer) {
  const { headers, message } = headersOf(body);
  const get = (name: string) => headers.find(([k]) => k === name)?.[1] ?? '';
  return {
    tree: get('tree'),
    parents: headers.filter(([k]) => k === 'parent').map(([, v]) => v),
    author: signature(get('author')),
    committer: signature(get('committer')),
    message,
  };
}

function parseTag(body: Buffer): Omit<GitTag, 'sha'> {
  const { headers, message } = headersOf(body);
  const get = (name: string) => headers.find(([k]) => k === name)?.[1];
  const tagger = get('tagger');
  return {
    object: get('object') ?? '',
    type: (get('type') ?? 'commit') as GitTag['type'],
    tag: get('tag') ?? '',
    tagger: tagger ? signature(tagger) : null,
    message,
  };
}

function git(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`git ${args[0]} failed: ${err.trim()}`)),
    );
  });
}
