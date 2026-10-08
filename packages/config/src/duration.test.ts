import { describe, expect, it } from 'vitest';
import { isDuration, parseDuration } from './duration.ts';

describe('duration parsing (DEP-040 schedules)', () => {
  it('[DEP-040] converts seconds, minutes, hours and days to milliseconds', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('24h')).toBe(86_400_000);
    expect(parseDuration('7d')).toBe(604_800_000);
  });

  it('[DEP-040] rejects text that is not a whole number with a unit', () => {
    for (const text of ['', '7', 'd7', '7 d', '1.5h', '-1h', '7w', '7ms', ' 7d', '7D']) {
      expect(parseDuration(text), text).toBeUndefined();
      expect(isDuration(text), text).toBe(false);
    }
  });

  it('[DEP-040] returns undefined when the result is not a safe integer', () => {
    expect(parseDuration('9999999999999999d')).toBeUndefined();
  });

  it('[DEP-040] reports valid durations', () => {
    expect(isDuration('0s')).toBe(true);
  });
});
