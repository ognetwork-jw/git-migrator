/**
 * The color scheme the browser asked for on its last visit, kept in a cookie so the server can
 * render the first paint in it (UI-001, ADR-0520). It is a display preference, nothing more: the
 * OS setting still decides once the page runs.
 */
export const COLOR_SCHEME_COOKIE = 'gm-color-scheme';

/** One year, so a returning visitor keeps the first paint they had. */
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** True when the cookie's value asks for the dark theme; anything else is light. */
export const prefersDarkFromCookie = (value: string | undefined): boolean => value === 'dark';

/** The `document.cookie` assignment that remembers `dark` for the next server render. */
export const colorSchemeCookie = (dark: boolean): string =>
  `${COLOR_SCHEME_COOKIE}=${dark ? 'dark' : 'light'}; Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax`;
