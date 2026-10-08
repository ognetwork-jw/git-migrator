import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isolatedGitEnv, runGit } from './client.ts';
import type { LfsObjectStore } from './lfs.ts';

export interface SeedBranch {
  name: string;
  /** Commits on top of the default branch's head. Default 1. */
  commits?: number;
}

export interface SeedTag {
  name: string;
  /** Annotated tag object when true, lightweight otherwise. */
  annotated?: boolean;
  /** Branch the tag points at. Default: the default branch. */
  target?: string;
  message?: string;
}

export interface SeedFile {
  path: string;
  /** Literal content; or `bytes` of deterministic pseudo-random data. */
  content?: Buffer | string;
  bytes?: number;
}

export interface SeedSpec {
  /** Default `main`. */
  defaultBranch?: string;
  /** Commits on the default branch before the file commits. Default 3. */
  commits?: number;
  /**
   * Size of the file each default-branch commit adds (deterministic incompressible bytes), so the
   * pack grows with history like a real repository (about this many bytes per commit). Default:
   * a one-line text file.
   */
  bytesPerCommit?: number;
  branches?: SeedBranch[];
  tags?: SeedTag[];
  /** Files tracked with git-lfs: a pointer is committed and the object is stored in `lfs`. */
  lfsFiles?: SeedFile[];
  /** Ordinary (non-LFS) large blobs, e.g. to trigger the target's blob size rejection. */
  bigBlobs?: SeedFile[];
}

export interface SeedResult {
  /** Branch name -> head commit id. */
  heads: Record<string, string>;
  /** Tag name -> object id the tag ref points at (tag object for annotated tags). */
  tags: Record<string, string>;
  /** LFS objects stored, by path. */
  lfs: Record<string, { oid: string; size: number }>;
}

const EPOCH = 1_700_000_000;

/** Deterministic, hard-to-compress bytes (xorshift32), so pack sizes are close to blob sizes. */
export function pseudoRandomBytes(size: number, seed = 1): Buffer {
  const buf = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i += 4) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    for (let j = 0; j < 4 && i + j < size; j++) buf[i + j] = (x >>> (8 * j)) & 0xff;
  }
  return buf;
}

export async function createBareRepo(barePath: string, defaultBranch = 'main'): Promise<void> {
  await mkdir(dirname(barePath), { recursive: true });
  await runGit(['init', '--bare', '-q', `--initial-branch=${defaultBranch}`, barePath], {
    env: isolatedGitEnv(dirname(barePath)),
  });
}

class Stream {
  private parts: Buffer[] = [];
  private marks = 0;
  private clock = EPOCH;
  line(s: string): void {
    this.parts.push(Buffer.from(`${s}\n`));
  }
  data(content: Buffer | string): void {
    const buf = typeof content === 'string' ? Buffer.from(content) : content;
    this.parts.push(Buffer.from(`data ${buf.length}\n`), buf, Buffer.from('\n'));
  }
  blob(content: Buffer | string): number {
    const mark = ++this.marks;
    this.line('blob');
    this.line(`mark :${mark}`);
    this.data(content);
    return mark;
  }
  commit(
    ref: string,
    message: string,
    from: number | undefined,
    files: [string, number][],
  ): number {
    const mark = ++this.marks;
    this.line(`commit ${ref}`);
    this.line(`mark :${mark}`);
    const who = `Fake Author <author@example.invalid> ${this.clock++} +0000`;
    this.line(`author ${who}`);
    this.line(`committer ${who}`);
    this.data(message);
    if (from !== undefined) this.line(`from :${from}`);
    for (const [path, blob] of files) this.line(`M 100644 :${blob} ${path}`);
    return mark;
  }
  tag(name: string, from: number, annotated: boolean, message: string): void {
    if (annotated) {
      this.line(`tag ${name}`);
      this.line(`from :${from}`);
      this.line(`tagger Fake Tagger <tagger@example.invalid> ${this.clock++} +0000`);
      this.data(message);
    } else {
      this.line(`reset refs/tags/${name}`);
      this.line(`from :${from}`);
    }
  }
  toBuffer(): Buffer {
    return Buffer.concat(this.parts);
  }
}

function fileBytes(f: SeedFile, seed: number): Buffer {
  if (f.content !== undefined)
    return typeof f.content === 'string' ? Buffer.from(f.content) : f.content;
  return pseudoRandomBytes(f.bytes ?? 0, seed);
}

/**
 * Populates an existing bare repository with history, branches, annotated and lightweight tags, LFS
 * pointers (with objects stored in `lfs`) and big blobs, using `git fast-import` (fast even for
 * thousands of commits). Intended for T-043's fixture world.
 */
export async function seedBareRepo(
  barePath: string,
  spec: SeedSpec = {},
  lfs?: { store: LfsObjectStore; repo: string },
): Promise<SeedResult> {
  const def = spec.defaultBranch ?? 'main';
  const s = new Stream();
  const result: SeedResult = { heads: {}, tags: {}, lfs: {} };
  const marks: Record<string, number> = {};

  let head: number | undefined;
  const total = spec.commits ?? 3;
  for (let i = 1; i <= total; i++) {
    const b = s.blob(
      spec.bytesPerCommit ? pseudoRandomBytes(spec.bytesPerCommit, i) : `content ${i}\n`,
    );
    head = s.commit(`refs/heads/${def}`, `commit ${i}`, head, [[`file-${i}.txt`, b]]);
  }

  const files: [string, number][] = [];
  const lfsFiles = spec.lfsFiles ?? [];
  if (lfsFiles.length > 0) {
    if (!lfs) throw new Error('seedBareRepo: lfsFiles requires the `lfs` store');
    const attributes = lfsFiles
      .map((f) => `${f.path} filter=lfs diff=lfs merge=lfs -text\n`)
      .join('');
    files.push(['.gitattributes', s.blob(attributes)]);
    for (const [i, f] of lfsFiles.entries()) {
      const stored = await lfs.store.put(lfs.repo, fileBytes(f, 100 + i));
      result.lfs[f.path] = stored;
      files.push([
        f.path,
        s.blob(
          `version https://git-lfs.github.com/spec/v1\noid sha256:${stored.oid}\nsize ${stored.size}\n`,
        ),
      ]);
    }
  }
  for (const [i, f] of (spec.bigBlobs ?? []).entries()) {
    files.push([f.path, s.blob(fileBytes(f, 1000 + i))]);
  }
  if (files.length > 0) head = s.commit(`refs/heads/${def}`, 'add large files', head, files);
  if (head === undefined) throw new Error('seedBareRepo: needs at least one commit');
  marks[def] = head;

  for (const b of spec.branches ?? []) {
    let tip = head;
    for (let i = 1; i <= (b.commits ?? 1); i++) {
      const blob = s.blob(`${b.name} ${i}\n`);
      tip = s.commit(`refs/heads/${b.name}`, `${b.name} ${i}`, tip, [
        [`branch-${b.name}-${i}.txt`, blob],
      ]);
    }
    marks[b.name] = tip;
  }
  for (const t of spec.tags ?? []) {
    const target = marks[t.target ?? def];
    if (target === undefined) throw new Error(`seedBareRepo: unknown tag target ${t.target}`);
    s.tag(t.name, target, t.annotated ?? false, t.message ?? `Release ${t.name}\n`);
  }

  const env = isolatedGitEnv(dirname(barePath));
  await runGit(['fast-import', '--quiet', '--force'], { cwd: barePath, env, input: s.toBuffer() });

  const refs = await runGit(['for-each-ref', '--format=%(refname) %(objectname)'], {
    cwd: barePath,
    env,
  });
  for (const line of refs.stdout.split('\n')) {
    const [ref, oid] = line.split(' ');
    if (!ref || !oid) continue;
    if (ref.startsWith('refs/heads/')) result.heads[ref.slice(11)] = oid;
    else if (ref.startsWith('refs/tags/')) result.tags[ref.slice(10)] = oid;
  }
  return result;
}

/** sha256 hex of a buffer; handy when asserting LFS pointers. */
export function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}
