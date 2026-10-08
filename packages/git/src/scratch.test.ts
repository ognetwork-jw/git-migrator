import { describe, expect, it } from 'vitest';
import { scratchNeededBytes } from './scratch.ts';

describe('scratchNeededBytes (JOB-015)', () => {
  it('[JOB-015] is sizeBytes x 2.2 plus lfsBytes, exact for integers', () => {
    expect(scratchNeededBytes({ sizeBytes: 100, lfsBytes: 0 })).toBe(220);
    expect(scratchNeededBytes({ sizeBytes: 1000, lfsBytes: 50 })).toBe(2250);
    expect(scratchNeededBytes({ sizeBytes: 5, lfsBytes: 0 })).toBe(11);
    expect(scratchNeededBytes({ sizeBytes: 5_368_709_120, lfsBytes: 1 })).toBe(11_811_160_065);
  });

  it('[JOB-015] unknown sizes count as zero and bigint inputs work', () => {
    expect(scratchNeededBytes({ sizeBytes: null, lfsBytes: undefined })).toBe(0);
    expect(scratchNeededBytes({ sizeBytes: 10n, lfsBytes: 4n })).toBe(26);
  });
});
