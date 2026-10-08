/**
 * Blob scan (FAC-GIT-004). During `git.prepare`, every blob reachable from a branch or tag that is
 * larger than the target's `maxBlobBytes` is a blocker (`git-refs.blob-too-large`), and every blob
 * above the warning size (50 MiB) up to the limit is a warning (`git-refs.blob-large`). LFS
 * pointer files are small, so LFS content never trips the scan.
 */
import { GitCommandError } from './errors.ts';
import type { GitContext, GitRunner } from './runner.ts';

export const BLOB_TOO_LARGE = 'git-refs.blob-too-large';
export const BLOB_LARGE = 'git-refs.blob-large';

/** The target warns above 50 MiB (docs/providers). */
export const DEFAULT_BLOB_WARN_BYTES = 50 * 1024 * 1024;

export interface BlobFinding {
  readonly code: typeof BLOB_TOO_LARGE | typeof BLOB_LARGE;
  readonly params: {
    readonly path: string;
    readonly size: number;
    readonly oid: string;
    /** The limit that was exceeded (the target's maximum, or the warning size). */
    readonly limit: number;
  };
}

export interface BlobScanResult {
  readonly blockers: readonly BlobFinding[];
  readonly warnings: readonly BlobFinding[];
  /** Blobs looked at; for logs and tests. */
  readonly scannedBlobs: number;
  readonly largestBlobBytes: number;
}

export interface BlobScanOptions {
  readonly dir: string;
  /** The target's maximum blob size; without it there are no blockers. */
  readonly maxBlobBytes?: number;
  readonly warnBlobBytes?: number;
  readonly signal?: AbortSignal;
}

const bySize = (a: BlobFinding, b: BlobFinding): number =>
  b.params.size - a.params.size || (a.params.path < b.params.path ? -1 : 1);

/**
 * `git rev-list --objects` lists every object once with its first path; `git cat-file
 * --batch-check` reads those lines and prints `blob <oid> <size> <path>`.
 */
export async function scanBlobs(
  runner: GitRunner,
  context: GitContext,
  options: BlobScanOptions,
): Promise<BlobScanResult> {
  const warnAt = options.warnBlobBytes ?? DEFAULT_BLOB_WARN_BYTES;
  const maxBytes = options.maxBlobBytes;
  const blockers: BlobFinding[] = [];
  const warnings: BlobFinding[] = [];
  let scanned = 0;
  let largest = 0;
  const onLine = (line: string): void => {
    const first = line.indexOf(' ');
    if (first < 0 || line.slice(0, first) !== 'blob') return;
    const second = line.indexOf(' ', first + 1);
    const third = line.indexOf(' ', second + 1);
    if (second < 0) return;
    const oid = line.slice(first + 1, second);
    const size = Number(third < 0 ? line.slice(second + 1) : line.slice(second + 1, third));
    if (!Number.isFinite(size)) return;
    scanned++;
    largest = Math.max(largest, size);
    const path = third < 0 ? oid : line.slice(third + 1) || oid;
    if (maxBytes !== undefined && size > maxBytes) {
      blockers.push({ code: BLOB_TOO_LARGE, params: { path, size, oid, limit: maxBytes } });
    } else if (size > warnAt) {
      warnings.push({ code: BLOB_LARGE, params: { path, size, oid, limit: warnAt } });
    }
  };
  const common = {
    cwd: options.dir,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
  const cat = runner.start(
    context,
    ['cat-file', '--batch-check=%(objecttype) %(objectname) %(objectsize) %(rest)'],
    { ...common, onStdoutLine: onLine, manualStdin: true },
  );
  if (cat.child.stdin === null) throw new Error('git cat-file has no stdin');
  const list = runner.start(context, ['rev-list', '--objects', '--branches', '--tags'], {
    ...common,
    pipeStdoutTo: cat.child.stdin,
  });
  const [catResult, listResult] = await Promise.all([cat.result, list.result]);
  for (const [name, result] of [
    ['rev-list', listResult],
    ['cat-file', catResult],
  ] as const) {
    if (result.code !== 0) {
      throw new GitCommandError({
        operation: name,
        exitCode: result.code,
        stderr: result.stderr,
        secrets: context.secrets,
      });
    }
  }
  return {
    blockers: blockers.sort(bySize),
    warnings: warnings.sort(bySize),
    scannedBlobs: scanned,
    largestBlobBytes: largest,
  };
}
