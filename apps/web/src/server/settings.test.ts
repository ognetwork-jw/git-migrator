import { describe, expect, it } from 'vitest';
import { loadWebSettings } from './settings.ts';

describe('loadWebSettings', () => {
  it('[UI-036] offers no test sign-in by default', () => {
    expect(loadWebSettings({})).toEqual({ testSignIn: false });
  });

  it('[UI-036] shows the test form when the configuration enables test sign-in', () => {
    expect(loadWebSettings({ GM_AUTH_TEST_SIGN_IN_ENABLED: 'true' })).toEqual({ testSignIn: true });
  });
});
