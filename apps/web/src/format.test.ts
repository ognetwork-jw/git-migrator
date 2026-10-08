import { describe, expect, it } from 'vitest';
import { formatDateTime } from './format.ts';

const INSTANT = '2026-10-08T20:30:00Z';

describe('formatDateTime', () => {
  it('[UI-001] formats in the given locale and time zone through Intl', () => {
    const us = formatDateTime(INSTANT, { locale: 'en-US', timeZone: 'UTC' });
    expect(us).toMatch(/Oct 8, 2026/);
    expect(us).toMatch(/8:30/);
    expect(formatDateTime(INSTANT, { locale: 'de-DE', timeZone: 'UTC' })).toMatch(/08\.10\.2026/);
    expect(formatDateTime(INSTANT, { locale: 'en-US', timeZone: 'Asia/Tokyo' })).toMatch(
      /Oct 9, 2026/,
    );
  });

  it('[UI-001] accepts dates and epoch values, and the short style', () => {
    const opts = { locale: 'en-US', timeZone: 'UTC' } as const;
    expect(formatDateTime(new Date(INSTANT), opts)).toMatch(/2026/);
    expect(formatDateTime(Date.parse(INSTANT), opts)).toMatch(/2026/);
    expect(formatDateTime(INSTANT, { ...opts, style: 'short' })).toMatch(/10\/8\/26/);
  });

  it('[UI-001] renders nothing for a missing or invalid value instead of throwing', () => {
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime(undefined)).toBe('');
    expect(formatDateTime('not a date')).toBe('');
  });
});
