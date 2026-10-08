import { b64url } from './util.ts';

/**
 * Builds an App JWT shaped like GitHub's (RS256, `iat` 60 s in the past, `exp` 9 minutes ahead,
 * the recommended values of the provider doc). The signature is a placeholder: the fake accepts any
 * key unless it was given the App's public key. For tests and fixtures only.
 */
export function fakeAppJwt(options: {
  appId: number | string;
  nowMs?: number;
  /** Seconds relative to `now`. */
  iatOffset?: number;
  expOffset?: number;
}): string {
  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: String(options.appId),
      iat: now + (options.iatOffset ?? -60),
      exp: now + (options.expOffset ?? 540),
    }),
  );
  return `${header}.${payload}.${b64url('fake-signature')}`;
}
