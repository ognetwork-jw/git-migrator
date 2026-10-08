/**
 * Git LFS (FAC-GIT-005, LIF-040 steps 2 and 4). Objects are listed from the pointers in every ref
 * of the mirror (`git lfs ls-files --all`), fetched with `git lfs fetch --all` and pushed with
 * `git lfs push --all`. Each transfer pre-acquires 1 quota unit per 100 objects (JOB-041). After
 * the push, parity is checked through the LFS batch API `download` operation.
 */
import { AdapterError } from '@git-migrator/adapter-sdk';
import { type GitQuota, LFS_OBJECTS_PER_UNIT, lfsUnits } from './quota.ts';
import { GIT_REMOTE_SOURCE, GIT_REMOTE_TARGET } from './remotes.ts';
import type { GitContext, GitRunner } from './runner.ts';

export interface LfsObject {
  readonly oid: string;
  readonly size: number;
  /** Paths the pointer appears under (one is enough for messages). */
  readonly paths: readonly string[];
  /** Whether the object content is already in the mirror's LFS store. */
  readonly downloaded: boolean;
}

interface LsFilesJson {
  readonly files?:
    | readonly {
        readonly name?: string;
        readonly size?: number;
        readonly oid?: string;
        readonly downloaded?: boolean;
      }[]
    | null;
}

const OID = /^[0-9a-f]{64}$/;

/** `git lfs ls-files --all --json`, deduplicated by oid. */
export async function listLfsObjects(
  runner: GitRunner,
  context: GitContext,
  dir: string,
  signal?: AbortSignal,
): Promise<LfsObject[]> {
  const result = await runner.run(context, ['lfs', 'ls-files', '--all', '--long', '--json'], {
    cwd: dir,
    maxStdoutBytes: 512 * 1024 * 1024,
    operation: 'lfs ls-files',
    ...(signal !== undefined ? { signal } : {}),
  });
  const text = result.stdout.trim();
  if (text === '') return [];
  const parsed = JSON.parse(text) as LsFilesJson;
  const byOid = new Map<string, { size: number; paths: string[]; downloaded: boolean }>();
  for (const file of parsed.files ?? []) {
    if (typeof file.oid !== 'string' || !OID.test(file.oid)) continue;
    const entry = byOid.get(file.oid) ?? {
      size: file.size ?? 0,
      paths: [],
      downloaded: file.downloaded === true,
    };
    if (file.name !== undefined && entry.paths.length < 5) entry.paths.push(file.name);
    byOid.set(file.oid, entry);
  }
  return [...byOid.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([oid, entry]) => ({ oid, ...entry }));
}

/** Total bytes of LFS content, for the size classes (JOB-015). */
export function lfsBytes(objects: readonly LfsObject[]): number {
  return objects.reduce((sum, object) => sum + object.size, 0);
}

export interface LfsTransferResult {
  /** Objects the transfer covered. */
  readonly objects: number;
  /** Quota units spent. */
  readonly units: number;
}

/** `git lfs fetch --all origin`. Objects already present are not counted, so a resume is cheap. */
export async function fetchLfsObjects(
  runner: GitRunner,
  context: GitContext,
  options: { dir: string; quota: GitQuota; signal?: AbortSignal; objects: readonly LfsObject[] },
): Promise<LfsTransferResult> {
  const missing = options.objects.filter((object) => !object.downloaded);
  const units = lfsUnits(missing.length);
  if (missing.length === 0) return { objects: 0, units: 0 };
  await options.quota.acquire(units);
  await runner.run(context, ['lfs', 'fetch', '--all', GIT_REMOTE_SOURCE], {
    cwd: options.dir,
    operation: 'lfs fetch',
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  return { objects: missing.length, units };
}

/** `git lfs push --all <target>`. The batch API skips what the target already has. */
export async function pushLfsObjects(
  runner: GitRunner,
  context: GitContext,
  options: { dir: string; quota: GitQuota; signal?: AbortSignal; objects: readonly LfsObject[] },
): Promise<LfsTransferResult> {
  const units = lfsUnits(options.objects.length);
  if (options.objects.length === 0) return { objects: 0, units: 0 };
  await options.quota.acquire(units);
  await runner.run(context, ['lfs', 'push', '--all', GIT_REMOTE_TARGET], {
    cwd: options.dir,
    operation: 'lfs push',
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  return { objects: options.objects.length, units };
}

/** One entry of an LFS batch API response. */
export interface LfsBatchObject {
  readonly oid: string;
  readonly size?: number;
  readonly actions?: Readonly<Record<string, unknown>>;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/**
 * Asks a target's LFS batch API whether objects can be downloaded. Implemented by the adapter or
 * the worker over `ProviderHttpClient` (all provider HTTP goes through it); this package only
 * chunks the objects and interprets the answer.
 */
export interface LfsBatchClient {
  download(objects: readonly { oid: string; size: number }[]): Promise<readonly LfsBatchObject[]>;
}

export interface LfsParityResult {
  readonly checked: number;
  /** Oids the target cannot serve (error 404, or no download action). */
  readonly missing: readonly string[];
  /** Oids the target answered with another error. The caller treats these as unverifiable. */
  readonly failed: readonly { oid: string; code?: number; message?: string }[];
}

/**
 * Every LFS object referenced by a ref in the mirror MUST exist on the target (FAC-GIT-005),
 * checked through the batch API `download` operation in groups of up to 100 objects.
 */
export async function verifyLfsParity(
  batch: LfsBatchClient,
  objects: readonly { oid: string; size: number }[],
  options: { batchSize?: number } = {},
): Promise<LfsParityResult> {
  const requested = options.batchSize ?? LFS_OBJECTS_PER_UNIT;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new AdapterError({
      code: 'invalid',
      provider: 'git',
      message: 'The LFS batch size must be a positive integer',
    });
  }
  const size = Math.min(requested, LFS_OBJECTS_PER_UNIT);
  const missing: string[] = [];
  const failed: { oid: string; code?: number; message?: string }[] = [];
  for (let i = 0; i < objects.length; i += size) {
    const group = objects.slice(i, i + size);
    const answers = await batch.download(group);
    const byOid = new Map(answers.map((answer) => [answer.oid, answer]));
    for (const wanted of group) {
      const answer = byOid.get(wanted.oid);
      if (answer === undefined) {
        throw new AdapterError({
          code: 'invalid',
          provider: 'git',
          message: 'The LFS batch response omitted a requested object',
        });
      }
      if (answer.error !== undefined) {
        if (answer.error.code === 404) missing.push(wanted.oid);
        else {
          failed.push({
            oid: wanted.oid,
            ...(answer.error.code !== undefined ? { code: answer.error.code } : {}),
            ...(answer.error.message !== undefined ? { message: answer.error.message } : {}),
          });
        }
      } else if (answer.actions?.download === undefined) missing.push(wanted.oid);
    }
  }
  return { checked: objects.length, missing, failed };
}
