import { problemCodeOf } from '../api/actor.ts';
import { safeNextPath } from './paths.ts';

export const SIGN_IN_SOCIAL_PATH = '/api/auth/sign-in/social';
export const SIGN_IN_EMAIL_PATH = '/api/auth/sign-in/email';
export const SIGN_OUT_PATH = '/api/auth/sign-out';

/** Better Auth's provider id of the Entra sign-in (AUTH-002). */
export const ENTRA_PROVIDER_ID = 'microsoft';

export type SignInOutcome =
  /** Go to `url` (the Entra authorize endpoint, or the landing page after test sign-in). */
  | { readonly kind: 'redirect'; readonly url: string }
  /** The credentials were refused (test sign-in). */
  | { readonly kind: 'invalid' }
  /** The sign-in could not be started; `code` is an `auth.error.<code>` key. */
  | { readonly kind: 'error'; readonly code: string };

const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify(body),
  credentials: 'same-origin',
});

async function errorCodeOf(response: Response): Promise<string> {
  const code = await problemCodeOf(response);
  return code === 'internal_error' ? 'sign_in_failed' : code;
}

/**
 * Starts the Entra redirect flow. The body carries only the fields the server accepts (ADR-0170);
 * the server answers with the authorize URL and the page navigates to it.
 */
export async function startEntraSignIn(
  next: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<SignInOutcome> {
  const callbackURL = safeNextPath(next);
  const errorCallbackURL = '/auth/error';
  let response: Response;
  try {
    response = await fetchImpl(
      SIGN_IN_SOCIAL_PATH,
      jsonPost({ provider: ENTRA_PROVIDER_ID, callbackURL, errorCallbackURL }),
    );
  } catch {
    return { kind: 'error', code: 'sign_in_failed' };
  }
  if (!response.ok) return { kind: 'error', code: await errorCodeOf(response) };
  try {
    const body = (await response.json()) as { url?: unknown };
    if (typeof body.url === 'string' && body.url !== '') return { kind: 'redirect', url: body.url };
  } catch {
    // Falls through.
  }
  return { kind: 'error', code: 'sign_in_failed' };
}

/** Test sign-in (AUTH-012), offered only when the server has it enabled. */
export async function signInWithPassword(
  input: { readonly email: string; readonly password: string },
  next: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<SignInOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(SIGN_IN_EMAIL_PATH, jsonPost({ ...input, rememberMe: false }));
  } catch {
    return { kind: 'error', code: 'sign_in_failed' };
  }
  if (response.ok) return { kind: 'redirect', url: safeNextPath(next) };
  if (response.status === 401 || response.status === 400 || response.status === 422) {
    return { kind: 'invalid' };
  }
  return { kind: 'error', code: await errorCodeOf(response) };
}

/** Ends the session on the server (AUTH-004). True when it was ended. */
export async function signOut(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(SIGN_OUT_PATH, jsonPost({}));
    return response.ok;
  } catch {
    return false;
  }
}
