import { describe, expect, it } from 'vitest';
import { QUEUE_STATES, resetQueueCounts } from './queue-metrics.ts';
import { QUEUE_NAMES } from './queues.ts';

describe('queue metrics reset', () => {
  it('[DEP-050] zeroes every queue and state gauge when the leader stops leading', () => {
    const seen = new Map<string, number>();
    resetQueueCounts({
      setQueueJobs: (queue, state, value) => void seen.set(`${queue}:${state}`, value),
    });
    expect(seen.size).toBe(QUEUE_NAMES.length * QUEUE_STATES.length);
    expect([...seen.values()].every((value) => value === 0)).toBe(true);
  });
});
