import { describe, expect, inject, it } from 'vitest';
import { parseTimeFactor } from './test-timing.ts';

describe('GM_TEST_TIME_FACTOR (ADR-0507)', () => {
  it('[TST-001] defaults to 1 and accepts any finite number of at least 1', () => {
    expect(parseTimeFactor(undefined)).toBe(1);
    expect(parseTimeFactor('')).toBe(1);
    expect(parseTimeFactor(' ')).toBe(1);
    expect(parseTimeFactor('1')).toBe(1);
    expect(parseTimeFactor('2.5')).toBe(2.5);
    expect(parseTimeFactor('10')).toBe(10);
  });

  it('[TST-001] refuses a factor that would tighten budgets or is not a number', () => {
    for (const raw of ['0', '0.5', '-1', 'abc', 'NaN', 'Infinity', '3x']) {
      expect(() => parseTimeFactor(raw), raw).toThrow(/GM_TEST_TIME_FACTOR/);
    }
  });

  it('[TST-001] the configured factor reaches the tests', () => {
    expect(inject('timeFactor')).toBe(parseTimeFactor(process.env.GM_TEST_TIME_FACTOR));
  });
});
