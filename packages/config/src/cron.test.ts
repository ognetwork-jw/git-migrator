import { describe, expect, it } from 'vitest';
import { isCron } from './cron.ts';

describe('cron validation (DEP-040 schedules)', () => {
  it('[DEP-040] accepts the default schedules of DEP-040 and JOB-050', () => {
    for (const text of [
      '0 */6 * * *',
      '* * * * *',
      '17 3 * * *',
      '47 3 * * *',
      '*/10 * * * *',
      '35 * * * *',
    ]) {
      expect(isCron(text), text).toBe(true);
    }
  });

  it('[DEP-040] accepts lists, ranges, steps and the Sunday value 7', () => {
    expect(isCron('0,30 9-17 1-15/2 1,6,12 0-5')).toBe(true);
    expect(isCron('5/15 * * * 7')).toBe(true);
    expect(isCron('0 0 1 1 0,7')).toBe(true);
  });

  it('[DEP-040] rejects the wrong number of fields and stray whitespace', () => {
    expect(isCron('* * * *')).toBe(false);
    expect(isCron('* * * * * *')).toBe(false);
    expect(isCron(' * * * * *')).toBe(false);
    expect(isCron('* * * * * ')).toBe(false);
    expect(isCron('')).toBe(false);
  });

  it('[DEP-040] rejects values outside each field range', () => {
    expect(isCron('60 * * * *')).toBe(false);
    expect(isCron('* 24 * * *')).toBe(false);
    expect(isCron('* * 0 * *')).toBe(false);
    expect(isCron('* * 32 * *')).toBe(false);
    expect(isCron('* * * 13 *')).toBe(false);
    expect(isCron('* * * 0 *')).toBe(false);
    expect(isCron('* * * * 8')).toBe(false);
  });

  it('[DEP-040] rejects malformed ranges, steps and names', () => {
    expect(isCron('5-3 * * * *')).toBe(false);
    expect(isCron('1-2-3 * * * *')).toBe(false);
    expect(isCron('*/0 * * * *')).toBe(false);
    expect(isCron('*/60 * * * *')).toBe(false);
    expect(isCron('*/x * * * *')).toBe(false);
    expect(isCron('*/5/2 * * * *')).toBe(false);
    expect(isCron('1-99 * * * *')).toBe(false);
    expect(isCron('a * * * *')).toBe(false);
    expect(isCron('MON * * * *')).toBe(false);
    expect(isCron('L * * * *')).toBe(false);
    expect(isCron('1,,2 * * * *')).toBe(false);
    expect(isCron('-5 * * * *')).toBe(false);
  });
});
