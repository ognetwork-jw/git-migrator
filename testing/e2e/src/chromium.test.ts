import { describe, expect, it } from 'vitest';
import { chromiumBuilds, chromiumRevision, fallbackNote } from './chromium.ts';

describe('the pre-installed Chromium fallback', () => {
  it('[TST-021] orders the builds by revision number, not as text', () => {
    expect(
      chromiumBuilds([
        'chromium-999',
        'chromium_headless_shell-1194',
        'chromium-1194',
        'ffmpeg-1011',
        'chromium-1000',
        'chromium',
      ]),
    ).toEqual(['chromium-1194', 'chromium-1000', 'chromium-999']);
  });

  it('[TST-021] reads the revision from a folder name or an executable path', () => {
    expect(chromiumRevision('chromium-1194')).toBe(1194);
    expect(chromiumRevision('/opt/pw/chromium-1200/chrome-linux/chrome')).toBe(1200);
    expect(chromiumRevision('/opt/pw/chromium_headless_shell-1200/chrome')).toBeUndefined();
  });

  it('[TST-021] says which build stands in for the expected one, and only when they differ', () => {
    const expected = '/root/.cache/ms-playwright/chromium-1200/chrome-linux/chrome';
    expect(fallbackNote(expected, '/opt/pw/chromium-1194/chrome-linux/chrome')).toMatch(
      /expects Chromium 1200.*using 1194/,
    );
    expect(fallbackNote(expected, '/opt/pw/chromium-1200/chrome-linux/chrome')).toBeUndefined();
  });
});
