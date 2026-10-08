import { loadConfig } from '@git-migrator/config';

type Env = Readonly<Record<string, string | undefined>>;

/** What server-rendered pages need from the configuration. Nothing secret, nothing from the database. */
export interface WebSettings {
  /** `auth.testSignIn.enabled` (AUTH-012): `/signin` shows the email and password form. */
  readonly testSignIn: boolean;
}

/**
 * Reads the settings pages depend on. It loads the configuration only, so `/signin` renders even
 * while the database is down. Startup refuses test sign-in in production (AUTH-012), so no extra
 * check is needed here.
 */
export function loadWebSettings(env: Env = process.env): WebSettings {
  const config = loadConfig({ env, warn: () => {} });
  return { testSignIn: config.auth.testSignIn.enabled };
}
