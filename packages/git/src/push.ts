/**
 * Batched push planner (LIF-044). The default branch goes first, incrementally: the first-parent
 * history is walked oldest first and a checkpoint is pushed whenever the estimated pack since the
 * previous checkpoint would reach `maxPushBytes`. Other branches follow in groups of up to 50,
 * tags last in groups of 100. A group whose estimate exceeds the limit is split. A single commit
 * whose pack exceeds the limit is still pushed alone (LIF-042); the provider's rejection then
 * surfaces as `push-too-large`. The planner is pure over its dependencies, so tests can drive it
 * with simulated sizes.
 */
import { isGitCommandError } from './errors.ts';
import type { PackEstimator } from './pack-size.ts';

export const DEFAULT_MAX_PUSH_BYTES = 1.5 * 1024 * 1024 * 1024;
export const BRANCH_GROUP_SIZE = 50;
export const TAG_GROUP_SIZE = 100;

export interface LocalRef {
  readonly name: string;
  readonly sha: string;
}

export type PushKind = 'default-branch' | 'branches' | 'tags';

export interface PushEvent {
  readonly kind: PushKind;
  readonly refs: readonly string[];
  readonly estimatedBytes: number;
  readonly attempts: number;
}

export interface PushDeps {
  readonly estimate: PackEstimator;
  /** Pushes `sha:ref` refspecs in one `git push`, with retries. Resolves with the attempts used. */
  push(refspecs: readonly string[]): Promise<{ attempts: number }>;
  /** First-parent commits of `tip` not reachable from `exclude`, oldest first. */
  firstParentCommits(tip: string, exclude: readonly string[]): Promise<readonly string[]>;
}

export interface BatchedPushInput {
  readonly refs: readonly LocalRef[];
  /** Short name of the default branch, for example `main`. */
  readonly defaultBranch: string;
  /** Ref name to sha on the target now. Refs already at the wanted sha are skipped. */
  readonly remoteRefs: ReadonlyMap<string, string>;
  /** Shas the target has and the mirror has too: excluded from every estimate. */
  readonly knownShas: readonly string[];
  readonly maxPushBytes: number;
  readonly branchGroupSize?: number;
  readonly tagGroupSize?: number;
  readonly deps: PushDeps;
  readonly onPush?: (event: PushEvent) => void;
}

export interface PushReport {
  readonly pushes: readonly PushEvent[];
  /** Refs the target already had at the wanted sha. */
  readonly upToDate: readonly string[];
}

const isTooLarge = (error: unknown): boolean =>
  isGitCommandError(error) && error.reason === 'push-too-large';

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const byName = (a: LocalRef, b: LocalRef): number => (a.name < b.name ? -1 : 1);

export async function pushBatched(input: BatchedPushInput): Promise<PushReport> {
  const { deps } = input;
  const known = new Set(input.knownShas);
  const pushes: PushEvent[] = [];
  const upToDate: string[] = [];
  const record = (event: PushEvent): void => {
    pushes.push(event);
    input.onPush?.(event);
  };
  const pending: LocalRef[] = [];
  for (const ref of input.refs) {
    if (input.remoteRefs.get(ref.name) === ref.sha) upToDate.push(ref.name);
    else pending.push(ref);
  }
  const defaultName = `refs/heads/${input.defaultBranch}`;
  const heads = input.refs.filter((ref) => ref.name.startsWith('refs/heads/'));
  if (heads.length > 0 && !heads.some((ref) => ref.name === defaultName)) {
    throw new Error(`The default branch ${input.defaultBranch} is not in the mirror`);
  }

  /** Pushes one ref's history in checkpoints. */
  async function pushIncremental(ref: LocalRef, kind: PushKind, startLimit: number): Promise<void> {
    const history = await deps.firstParentCommits(ref.sha, [...known]);
    const list = history.at(-1) === ref.sha ? [...history] : [...history, ref.sha];
    const tipIndex = list.length - 1;
    let start = 0;
    let limit = startLimit;
    while (start < list.length) {
      let at = tipIndex;
      let size = await deps.estimate([ref.sha], [...known]);
      if (size > limit) {
        // Largest checkpoint whose pack fits; the pack grows with the index.
        let low = start;
        let high = tipIndex - 1;
        let best = -1;
        let bestSize = 0;
        while (low <= high) {
          const mid = (low + high) >> 1;
          const midSize = await deps.estimate([list[mid] as string], [...known]);
          if (midSize <= limit) {
            best = mid;
            bestSize = midSize;
            low = mid + 1;
          } else high = mid - 1;
        }
        if (best >= 0) {
          at = best;
          size = bestSize;
        } else {
          // Not even one commit fits: push it alone (LIF-042).
          at = start;
          size = await deps.estimate([list[start] as string], [...known]);
        }
      }
      const sha = list[at] as string;
      try {
        const { attempts } = await deps.push([`${sha}:${ref.name}`]);
        record({ kind, refs: [ref.name], estimatedBytes: size, attempts });
      } catch (error) {
        // The estimate was too low for this provider: aim lower and plan again.
        if (isTooLarge(error) && at > start && size > 1) {
          limit = Math.max(1, Math.floor(size / 2));
          continue;
        }
        throw error;
      }
      known.add(sha);
      start = at + 1;
      limit = startLimit;
    }
  }

  async function pushGroup(kind: PushKind, group: readonly LocalRef[]): Promise<void> {
    const shas = [...new Set(group.map((ref) => ref.sha))];
    const size = await deps.estimate(shas, [...known]);
    const [first] = group;
    const split = async (): Promise<void> => {
      const middle = group.length >> 1;
      await pushGroup(kind, group.slice(0, middle));
      await pushGroup(kind, group.slice(middle));
    };
    if (group.length > 1 && size > input.maxPushBytes) return split();
    if (
      first !== undefined &&
      group.length === 1 &&
      size > input.maxPushBytes &&
      kind === 'branches'
    ) {
      return pushIncremental(first, 'branches', input.maxPushBytes);
    }
    try {
      const { attempts } = await deps.push(group.map((ref) => `${ref.sha}:${ref.name}`));
      record({ kind, refs: group.map((ref) => ref.name), estimatedBytes: size, attempts });
    } catch (error) {
      if (!isTooLarge(error)) throw error;
      if (group.length > 1) return split();
      if (first !== undefined && kind === 'branches' && size > 1) {
        return pushIncremental(first, 'branches', Math.max(1, Math.floor(size / 2)));
      }
      throw error;
    }
    for (const sha of shas) known.add(sha);
  }

  const defaultRef = pending.find((ref) => ref.name === defaultName);
  if (defaultRef !== undefined) {
    await pushIncremental(defaultRef, 'default-branch', input.maxPushBytes);
  }
  const branches = pending
    .filter((ref) => ref.name.startsWith('refs/heads/') && ref.name !== defaultName)
    .sort(byName);
  for (const group of chunks(branches, input.branchGroupSize ?? BRANCH_GROUP_SIZE)) {
    await pushGroup('branches', group);
  }
  const tags = pending.filter((ref) => ref.name.startsWith('refs/tags/')).sort(byName);
  for (const group of chunks(tags, input.tagGroupSize ?? TAG_GROUP_SIZE)) {
    await pushGroup('tags', group);
  }
  return { pushes, upToDate };
}
