import { describe, expect, it } from 'vitest';
import { GitCommandError } from './errors.ts';
import { type BatchedPushInput, type LocalRef, type PushDeps, pushBatched } from './push.ts';

/**
 * Simulated repository: a sha is `chain:index`, a chain is linear history, and each commit costs
 * 10 bytes of pack. `estimate` counts the commits of each chain between the excluded tip and the
 * included one.
 */
const UNIT = 10;
const index = (sha: string): number => Number(sha.split(':')[1]);
const chain = (sha: string): string => sha.split(':')[0] as string;

function estimateFor(scale = 1) {
  return async (include: readonly string[], exclude: readonly string[]): Promise<number> => {
    const top = new Map<string, number>();
    for (const sha of include) top.set(chain(sha), Math.max(top.get(chain(sha)) ?? -1, index(sha)));
    let total = 0;
    for (const [name, high] of top) {
      let low = -1;
      for (const sha of exclude) if (chain(sha) === name) low = Math.max(low, index(sha));
      total += Math.max(0, high - low) * UNIT * scale;
    }
    return total;
  };
}

interface Sim {
  pushed: string[][];
  deps: PushDeps;
}

function simulate(options: { realScale?: number; limitReal?: number } = {}): Sim {
  const pushed: string[][] = [];
  const have: string[] = [];
  const deps: PushDeps = {
    estimate: estimateFor(),
    async push(refspecs) {
      const real = options.limitReal;
      if (real !== undefined) {
        const bytes = await estimateFor(options.realScale ?? 1)(
          refspecs.map((r) => r.split(':').slice(0, 2).join(':')),
          have,
        );
        if (bytes > real) {
          throw new GitCommandError({
            operation: 'push',
            exitCode: 1,
            stderr: 'error: RPC failed; HTTP 413 curl 22',
            secrets: [],
          });
        }
      }
      pushed.push([...refspecs]);
      for (const spec of refspecs) have.push(spec.split(':').slice(0, 2).join(':'));
      return { attempts: 1 };
    },
    async firstParentCommits(tip, exclude) {
      const low = exclude.reduce(
        (n, sha) => (chain(sha) === chain(tip) ? Math.max(n, index(sha)) : n),
        -1,
      );
      const out: string[] = [];
      for (let i = low + 1; i <= index(tip); i++) out.push(`${chain(tip)}:${i}`);
      return out;
    },
  };
  return { pushed, deps };
}

const ref = (name: string, sha: string): LocalRef => ({ name, sha });
const base = (
  sim: Sim,
  refs: LocalRef[],
  extra: Partial<BatchedPushInput> = {},
): BatchedPushInput => ({
  refs,
  defaultBranch: 'main',
  remoteRefs: new Map(),
  knownShas: [],
  maxPushBytes: 100,
  deps: sim.deps,
  ...extra,
});

describe('pushBatched (LIF-044)', () => {
  it('[LIF-044] walks the default branch in checkpoints that each fit maxPushBytes', async () => {
    const sim = simulate();
    const report = await pushBatched(base(sim, [ref('refs/heads/main', 'm:29')]));
    // Costs are (index + 1) * 10 for the first push, then 10 per commit after the checkpoint.
    expect(sim.pushed).toEqual([
      ['m:9:refs/heads/main'],
      ['m:19:refs/heads/main'],
      ['m:29:refs/heads/main'],
    ]);
    expect(report.pushes.map((p) => p.estimatedBytes)).toEqual([100, 100, 100]);
    expect(report.pushes.every((p) => p.kind === 'default-branch')).toBe(true);
  });

  it('[LIF-044] one push when everything fits', async () => {
    const sim = simulate();
    await pushBatched(base(sim, [ref('refs/heads/main', 'm:4')]));
    expect(sim.pushed).toEqual([['m:4:refs/heads/main']]);
  });

  it('[LIF-042] a commit larger than the limit is pushed alone', async () => {
    const sim = simulate();
    await pushBatched(base(sim, [ref('refs/heads/main', 'm:3')], { maxPushBytes: 5 }));
    expect(sim.pushed.map((p) => p[0])).toEqual([
      'm:0:refs/heads/main',
      'm:1:refs/heads/main',
      'm:2:refs/heads/main',
      'm:3:refs/heads/main',
    ]);
  });

  it('[LIF-044] shas the target already has are excluded from the estimates', async () => {
    const sim = simulate();
    const report = await pushBatched(
      base(sim, [ref('refs/heads/main', 'm:29')], {
        knownShas: ['m:19'],
        remoteRefs: new Map([['refs/heads/main', 'm:19']]),
      }),
    );
    expect(sim.pushed).toEqual([['m:29:refs/heads/main']]);
    expect(report.pushes[0]?.estimatedBytes).toBe(100);
  });

  it('[LIF-044] refs already at the wanted sha are skipped', async () => {
    const sim = simulate();
    const report = await pushBatched(
      base(sim, [ref('refs/heads/main', 'm:2'), ref('refs/tags/v1', 't:0')], {
        remoteRefs: new Map([
          ['refs/heads/main', 'm:2'],
          ['refs/tags/v1', 't:0'],
        ]),
      }),
    );
    expect(sim.pushed).toEqual([]);
    expect(report.upToDate).toEqual(['refs/heads/main', 'refs/tags/v1']);
  });

  it('[LIF-044] other branches go in groups of 50, tags in groups of 100, tags last', async () => {
    const sim = simulate();
    const refs = [
      ref('refs/heads/main', 'm:0'),
      ...Array.from({ length: 120 }, (_, i) =>
        ref(`refs/heads/b${String(i).padStart(3, '0')}`, `b${i}:0`),
      ),
      ...Array.from({ length: 250 }, (_, i) =>
        ref(`refs/tags/t${String(i).padStart(3, '0')}`, `t${i}:0`),
      ),
    ];
    const report = await pushBatched(base(sim, refs, { maxPushBytes: 1_000_000 }));
    expect(report.pushes.map((p) => [p.kind, p.refs.length])).toEqual([
      ['default-branch', 1],
      ['branches', 50],
      ['branches', 50],
      ['branches', 20],
      ['tags', 100],
      ['tags', 100],
      ['tags', 50],
    ]);
    expect(report.pushes[1]?.refs[0]).toBe('refs/heads/b000');
  });

  it('[LIF-044] a group whose estimate exceeds the limit is split', async () => {
    const sim = simulate();
    const refs = [
      ref('refs/heads/main', 'm:0'),
      ...Array.from({ length: 8 }, (_, i) => ref(`refs/heads/b${i}`, `b${i}:0`)),
    ];
    const report = await pushBatched(base(sim, refs, { maxPushBytes: 25, knownShas: [] }));
    const groups = report.pushes.filter((p) => p.kind === 'branches');
    expect(groups.map((p) => p.refs.length)).toEqual([2, 2, 2, 2]);
    expect(groups.every((p) => p.estimatedBytes <= 25)).toBe(true);
  });

  it('[LIF-044] a single branch above the limit is pushed in checkpoints', async () => {
    const sim = simulate();
    const refs = [ref('refs/heads/main', 'm:0'), ref('refs/heads/long', 'long:24')];
    const report = await pushBatched(base(sim, refs, { maxPushBytes: 100 }));
    expect(sim.pushed.slice(1).map((p) => p[0])).toEqual([
      'long:9:refs/heads/long',
      'long:19:refs/heads/long',
      'long:24:refs/heads/long',
    ]);
    expect(report.pushes.filter((p) => p.kind === 'branches')).toHaveLength(3);
  });

  it('[LIF-044] when the provider rejects a pack the estimate said would fit, the planner aims lower', async () => {
    // The real pack is twice the estimate and the provider accepts 100 bytes.
    const sim = simulate({ realScale: 2, limitReal: 100 });
    await pushBatched(base(sim, [ref('refs/heads/main', 'm:19')], { maxPushBytes: 100 }));
    const last = sim.pushed.at(-1);
    expect(last).toEqual(['m:19:refs/heads/main']);
    expect(sim.pushed.length).toBeGreaterThanOrEqual(4);
  });

  it('[LIF-042] a rejected single commit surfaces push-too-large', async () => {
    const sim = simulate({ realScale: 1, limitReal: 5 });
    const error = await pushBatched(base(sim, [ref('refs/heads/main', 'm:3')])).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ reason: 'push-too-large', code: 'blocked_by_provider' });
  });

  it('[LIF-044] a single oversized tag is not split further and surfaces the rejection', async () => {
    const sim = simulate({ realScale: 1, limitReal: 5 });
    const error = await pushBatched(
      base(sim, [ref('refs/tags/big', 't:3')], { maxPushBytes: 1000 }),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: 'push-too-large' });
  });

  it('[LIF-044] a mirror whose default branch is missing is an error, and an empty one is not', async () => {
    const sim = simulate();
    await expect(pushBatched(base(sim, [ref('refs/heads/dev', 'd:0')]))).rejects.toThrow(
      /default branch main/,
    );
    expect(await pushBatched(base(sim, []))).toEqual({ pushes: [], upToDate: [] });
  });
});
