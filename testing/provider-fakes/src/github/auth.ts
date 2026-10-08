import { createPublicKey, verify } from 'node:crypto';
import type { GitHubState } from './state.ts';
import type { AppRec, InstallationRec, Permissions, TokenRec } from './types.ts';
import { GhError } from './util.ts';

export interface AuthCtx {
  kind: 'none' | 'jwt' | 'installation';
  app?: AppRec;
  installation?: InstallationRec;
  token?: TokenRec;
  permissions: Permissions;
  /** Rate limit bucket owner. */
  rateKey: string;
  /** Name shown as creator of things the caller creates. */
  actor: string;
}

export const NO_AUTH: AuthCtx = {
  kind: 'none',
  permissions: {},
  rateKey: 'anonymous',
  actor: 'anonymous',
};

const DOCS = 'https://docs.github.com/rest';

export const badCredentials = (): GhError => new GhError(401, 'Bad credentials');

function decodeSegment(seg: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Checks the structure and claims of an App JWT (provider doc, Authentication): three base64url
 * segments, RS256, `iss` = the App id (or client id), integer `iat` that is not in the future and
 * integer `exp` in the future and at most 10 minutes ahead. Any signature is accepted unless the fake
 * was given the App's public key.
 */
export function verifyAppJwt(state: GitHubState, jwt: string): AppRec {
  const parts = jwt.split('.');
  const [h, p, s] = parts;
  if (parts.length !== 3 || !h || !p || !s)
    throw new GhError(401, 'A JSON web token could not be decoded');
  const header = decodeSegment(h);
  const claims = decodeSegment(p);
  if (!header || !claims || !/^[A-Za-z0-9_-]+$/.test(s))
    throw new GhError(401, 'A JSON web token could not be decoded');
  if (header.alg !== 'RS256')
    throw new GhError(
      401,
      `'${String(header.alg)}' is not a supported signing algorithm; use RS256`,
    );
  const now = Math.floor(state.clock() / 1000);
  const skew = state.options.jwtClockSkewSeconds ?? 0;
  const { iat, exp, iss } = claims;
  if (!Number.isInteger(iat) || (iat as number) > now + skew)
    throw new GhError(
      401,
      "'Issued at' claim ('iat') must be an Integer representing the time that the assertion was issued",
    );
  if (!Number.isInteger(exp) || (exp as number) <= now)
    throw new GhError(
      401,
      "'Expiration time' claim ('exp') must be a numeric value representing the future time at which the assertion expires",
    );
  if ((exp as number) - now > 600)
    throw new GhError(
      401,
      "'Expiration time' claim ('exp') must be less than 10 minutes in the future",
    );
  const issuer = String(iss ?? '');
  const app = [...state.apps.values()].find(
    (a) => String(a.id) === issuer || (a === state.ownApp && issuer === state.appClientId),
  );
  if (!issuer || !app || ![...state.installations.values()].some((i) => i.appId === app.id))
    throw new GhError(
      401,
      `'Issuer' claim ('iss') does not match an App: ${issuer || '(missing)'}`,
    );
  const pem = state.options.appPublicKeyPem;
  if (pem) {
    const ok = verify(
      'RSA-SHA256',
      Buffer.from(`${h}.${p}`),
      createPublicKey(pem),
      Buffer.from(s, 'base64url'),
    );
    if (!ok) throw new GhError(401, 'A JSON web token could not be decoded');
  }
  return app;
}

/** Resolves an `Authorization` header (`Bearer`, `token`, or Basic with the token as password). */
export function authenticate(state: GitHubState, header: string | undefined): AuthCtx {
  if (!header) return NO_AUTH;
  const m = /^(Bearer|token|Basic)\s+(.+)$/i.exec(header.trim());
  if (!m) throw badCredentials();
  const scheme = (m[1] as string).toLowerCase();
  let credential = m[2] as string;
  if (scheme === 'basic') {
    const decoded = Buffer.from(credential, 'base64').toString('utf8');
    credential = decoded.slice(decoded.indexOf(':') + 1);
  }
  if (credential.split('.').length === 3 && scheme !== 'basic') {
    const app = verifyAppJwt(state, credential);
    return {
      kind: 'jwt',
      app,
      permissions: {},
      rateKey: `app:${app.id}`,
      actor: app.slug,
    };
  }
  const token = state.tokens.get(credential);
  if (!token || token.expiresAt <= state.clock()) throw badCredentials();
  const installation = state.installations.get(token.installationId);
  if (!installation) throw badCredentials();
  if (installation.suspended) throw new GhError(403, 'This installation has been suspended');
  return {
    kind: 'installation',
    installation,
    token,
    app: state.apps.get(installation.appId),
    permissions: token.permissions,
    rateKey: `inst:${installation.id}`,
    actor: `${state.apps.get(installation.appId)?.slug ?? 'app'}[bot]`,
  };
}

export { DOCS };
