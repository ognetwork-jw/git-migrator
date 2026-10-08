/** Where an Actor lands after signing in when no `next` address is given. */
export const DEFAULT_LANDING = '/';

/** Addresses of the sign-in flow itself: returning to them after sign-in would loop. */
const SIGN_IN_FLOW = ['/signin', '/denied', '/auth', '/api'];

const isFlowPath = (path: string): boolean =>
  SIGN_IN_FLOW.some(
    (prefix) =>
      path === prefix ||
      path.startsWith(`${prefix}/`) ||
      path.startsWith(`${prefix}?`) ||
      path.startsWith(`${prefix}#`),
  );

const hasControlCharacter = (value: string): boolean => {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/**
 * The address to return to after sign-in, taken from `?next=`. Only a path on this site is kept: a
 * value that could leave it (`//host`, `/\host`, `https://host`) or that points at the sign-in
 * flow itself falls back to the dashboard, so the parameter cannot be used as an open redirect.
 */
export function safeNextPath(value: string | null | undefined): string {
  if (typeof value !== 'string' || !value.startsWith('/')) return DEFAULT_LANDING;
  if (value.startsWith('//') || value.includes('\\') || hasControlCharacter(value)) {
    return DEFAULT_LANDING;
  }
  return isFlowPath(value) ? DEFAULT_LANDING : value;
}

/** `/signin` with a `next` that returns to `pathname` (and its query) afterwards. */
export function signInHref(pathname: string, search = ''): string {
  const next = safeNextPath(`${pathname}${search}`);
  return next === DEFAULT_LANDING ? '/signin' : `/signin?next=${encodeURIComponent(next)}`;
}

/** The `auth.error.<code>` key to show for `?error=`; unknown or malformed codes show `unknown`. */
export function resolveAuthErrorCode(
  code: string | null | undefined,
  known: readonly string[],
): string {
  if (typeof code !== 'string' || code === 'title' || !/^[a-z_]+$/.test(code)) return 'unknown';
  return known.includes(code) ? code : 'unknown';
}
