import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface EntraStubOptions {
  /** The tenant the stub issues tokens for (the `tid` claim and the path segment). */
  readonly tenantId: string;
  /** The audience of the issued id tokens. */
  readonly clientId: string;
}

export interface EntraStub {
  /** Pass as `AuthTestSeams.entraAuthority` to `createAuthForTest`. */
  readonly authority: string;
  /**
   * Registers an authorization code that the token endpoint will redeem once. `claims` are merged
   * over a valid default set (issuer, audience, tenant, `oid`, `name`, `email`, `roles`).
   */
  issueCode(claims?: Readonly<Record<string, unknown>>): string;
  /** A signed id token, for the `idToken` sign-in path. */
  signIdToken(claims?: Readonly<Record<string, unknown>>): string;
  /** How many token requests the stub served (a request that lacked a valid code is not counted). */
  readonly redeemed: () => number;
  close(): Promise<void>;
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

/**
 * A local stand-in for the Entra v2 endpoints Better Auth calls (TST-006: tests never reach a real
 * Microsoft endpoint): the token endpoint and the JWKS document. The authorization endpoint is
 * not served; tests build the callback request themselves. Keys are generated per instance.
 */
export async function startEntraStub(options: EntraStubOptions): Promise<EntraStub> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomBytes(6).toString('hex');
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map<string, Record<string, unknown>>();
  let redeemed = 0;
  let authority = '';

  const sign = (claims: Readonly<Record<string, unknown>>): string => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: `${authority}/${options.tenantId}/v2.0`,
      aud: options.clientId,
      tid: options.tenantId,
      oid: `oid-${randomBytes(4).toString('hex')}`,
      sub: `sub-${randomBytes(4).toString('hex')}`,
      name: 'Ada Lovelace',
      email: 'ada@example.test',
      preferred_username: 'ada@example.test',
      roles: [],
      iat: now,
      nbf: now,
      exp: now + 3600,
      ...claims,
    };
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const body = b64url(JSON.stringify(payload));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${body}`);
    return `${header}.${body}.${b64url(signer.sign(privateKey))}`;
  };

  const readBody = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString();
  };
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'GET' && path === `/${options.tenantId}/discovery/v2.0/keys`) {
        json(res, 200, { keys: [jwk] });
        return;
      }
      if (req.method === 'POST' && path === `/${options.tenantId}/oauth2/v2.0/token`) {
        const form = new URLSearchParams(await readBody(req));
        const claims = codes.get(form.get('code') ?? '');
        if (!claims) {
          json(res, 400, { error: 'invalid_grant' });
          return;
        }
        codes.delete(form.get('code') ?? '');
        redeemed++;
        json(res, 200, {
          token_type: 'Bearer',
          access_token: 'stub-access-token',
          expires_in: 3600,
          scope: 'openid profile email',
          id_token: sign(claims),
        });
        return;
      }
      json(res, 404, { error: 'not_found' });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  authority = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    authority,
    issueCode: (claims = {}) => {
      const code = randomBytes(12).toString('hex');
      codes.set(code, { ...claims });
      return code;
    },
    signIdToken: sign,
    redeemed: () => redeemed,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
