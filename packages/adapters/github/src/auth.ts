/**
 * App authentication (docs/providers/github.md "Authentication"): an RS256 JWT is exchanged for an
 * installation token, cached until 5 minutes before expiry, single-flight per installation.
 */
import { createHash, createPrivateKey, createSign } from 'node:crypto';
import { AdapterError } from '@git-migrator/adapter-sdk';
import { PROVIDER } from './config.ts';

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** Signs the App JWT: iat 60 s in the past (clock drift), 9 minutes lifetime. */
export function signAppJwt(appId: number, privateKeyPem: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000) - 60;
  const signingInput = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(
    JSON.stringify({ iat, exp: iat + 60 + 9 * 60, iss: String(appId) }),
  )}`;
  try {
    const signature = createSign('RSA-SHA256')
      .update(signingInput)
      .sign(createPrivateKey(privateKeyPem));
    return `${signingInput}.${b64(signature)}`;
  } catch {
    // Never echo the key or the library message.
    throw new AdapterError({
      code: 'unauthorized',
      provider: PROVIDER,
      message: 'The GitHub App private key could not be used to sign a token',
    });
  }
}

export interface InstallationToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export const REFRESH_BEFORE_MS = 5 * 60 * 1000;

/** Token cache with one mint in flight per key. Failures are never cached. */
export class InstallationTokenCache {
  readonly #tokens = new Map<string, InstallationToken>();
  readonly #inflight = new Map<string, Promise<InstallationToken>>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  async get(key: string, mint: () => Promise<InstallationToken>): Promise<InstallationToken> {
    const cached = this.#tokens.get(key);
    if (cached && cached.expiresAt.getTime() - REFRESH_BEFORE_MS > this.#now().getTime()) {
      return cached;
    }
    const running = this.#inflight.get(key);
    if (running) return running;
    const promise = mint()
      .then((token) => {
        this.#tokens.set(key, token);
        return token;
      })
      .finally(() => {
        this.#inflight.delete(key);
      });
    this.#inflight.set(key, promise);
    return promise;
  }

  invalidate(key: string): void {
    this.#tokens.delete(key);
  }
}

/** Cache key: never contains the key itself, only a digest. */
export function cacheKey(
  baseUrl: string,
  appId: number,
  installationId: number,
  pem: string,
): string {
  const digest = createHash('sha256').update(pem).digest('hex').slice(0, 16);
  return `${baseUrl}|${appId}|${installationId}|${digest}`;
}
