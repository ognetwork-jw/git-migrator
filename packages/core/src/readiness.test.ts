import { describe, expect, it } from 'vitest';
import { deriveReadiness, type ReadinessInput, type ReadinessTask } from './readiness.ts';

const empty: ReadinessInput = {
  analysis: { blockers: [], warnings: 0 },
  runBlockers: [],
  tasks: [],
};
const task = (phase: 'pre' | 'post', status: 'open' | 'done' | 'dismissed'): ReadinessTask => ({
  phase,
  status,
});

describe('[LIF-004] readiness derivation', () => {
  it('[LIF-004] is ready when there are no blockers and no open pre tasks', () => {
    expect(deriveReadiness(empty)).toEqual({
      readiness: 'ready',
      counts: { blockers: 0, preTasks: 0, postTasks: 0, warnings: 0 },
      blockerCodes: [],
    });
  });

  it('[LIF-004] an analysis blocker makes it blocked, whatever else is true', () => {
    const r = deriveReadiness({
      ...empty,
      analysis: { blockers: [{ code: 'naming.invalid' }], warnings: 2 },
      tasks: [task('pre', 'open')],
    });
    expect(r.readiness).toBe('blocked');
    expect(r.blockerCodes).toEqual(['naming.invalid']);
    expect(r.counts).toEqual({ blockers: 1, preTasks: 1, postTasks: 0, warnings: 2 });
  });

  it('[LIF-004] an open run-origin blocker makes it blocked even if the analysis is clean (LIF-049)', () => {
    const r = deriveReadiness({ ...empty, runBlockers: [{ code: 'git-refs.push-too-large' }] });
    expect(r.readiness).toBe('blocked');
    expect(r.blockerCodes).toEqual(['git-refs.push-too-large']);
  });

  it('[LIF-004] blocker codes are unique and sorted across both sources; counts are not deduplicated', () => {
    const r = deriveReadiness({
      ...empty,
      analysis: { blockers: [{ code: 'b' }, { code: 'a' }], warnings: 0 },
      runBlockers: [{ code: 'a' }, { code: 'c' }],
    });
    expect(r.blockerCodes).toEqual(['a', 'b', 'c']);
    expect(r.counts.blockers).toBe(4);
  });

  it('[LIF-004] an open pre task makes it needs_attention', () => {
    expect(
      deriveReadiness({ ...empty, tasks: [task('pre', 'open'), task('pre', 'open')] }),
    ).toMatchObject({
      readiness: 'needs_attention',
      counts: { preTasks: 2 },
    });
  });

  it('[LIF-004] done and dismissed pre tasks do not count', () => {
    const r = deriveReadiness({ ...empty, tasks: [task('pre', 'done'), task('pre', 'dismissed')] });
    expect(r.readiness).toBe('ready');
    expect(r.counts.preTasks).toBe(0);
  });

  it('[LIF-004] post tasks never affect readiness, but are counted when open', () => {
    const r = deriveReadiness({
      ...empty,
      tasks: [task('post', 'open'), task('post', 'open'), task('post', 'done')],
    });
    expect(r.readiness).toBe('ready');
    expect(r.counts.postTasks).toBe(2);
  });

  it('[LIF-004] blocked outranks needs_attention', () => {
    const r = deriveReadiness({
      ...empty,
      runBlockers: [{ code: 'x' }],
      tasks: [task('pre', 'open')],
    });
    expect(r.readiness).toBe('blocked');
  });

  it('[LIF-004] with no analysis readiness is unset, but run-origin blockers still block', () => {
    expect(
      deriveReadiness({ analysis: null, runBlockers: [], tasks: [task('pre', 'open')] }),
    ).toEqual({
      readiness: null,
      counts: { blockers: 0, preTasks: 1, postTasks: 0, warnings: 0 },
      blockerCodes: [],
    });
    expect(
      deriveReadiness({ analysis: null, runBlockers: [{ code: 'k' }], tasks: [] }).readiness,
    ).toBe('blocked');
  });

  it('[LIF-004] does not mutate its input', () => {
    const input: ReadinessInput = {
      analysis: { blockers: [{ code: 'b' }, { code: 'a' }], warnings: 1 },
      runBlockers: [{ code: 'c' }],
      tasks: [task('pre', 'open')],
    };
    const copy = structuredClone(input);
    deriveReadiness(input);
    expect(input).toEqual(copy);
  });
});
