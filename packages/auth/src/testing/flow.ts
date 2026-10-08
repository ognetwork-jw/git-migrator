import type { AuthService } from '../auth.ts';
import { AUTH_BASE_PATH } from '../auth.ts';
import type { EntraStub } from './entra-stub.ts';

/** Collects `Set-Cookie` headers into a `Cookie` request header value. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /;\s*max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  has(namePart: string): boolean {
    return [...this.cookies.keys()].some((k) => k.includes(namePart));
  }
}

export interface FlowResult {
  readonly status: number;
  /** Where the callback redirected (the callback URL on success, the error page on failure). */
  readonly location: string | null;
  /** The `error` query parameter of the redirect, if any. */
  readonly error: string | null;
  readonly jar: CookieJar;
  readonly response: Response;
}

/**
 * Drives the authorization-code flow against `service.handle` with the Entra stub standing in for
 * Microsoft: starts the sign-in, then calls the callback with a code the stub will redeem.
 */
export async function signInWithEntra(
  service: AuthService,
  stub: EntraStub,
  origin: string,
  claims: Readonly<Record<string, unknown>> = {},
  jar: CookieJar = new CookieJar(),
): Promise<FlowResult> {
  const start = await service.handle(
    new Request(`${origin}${AUTH_BASE_PATH}/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ provider: 'microsoft', callbackURL: '/' }),
    }),
  );
  jar.absorb(start);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get('state') ?? '';
  const code = stub.issueCode(claims);
  const callback = await service.handle(
    new Request(
      `${origin}${AUTH_BASE_PATH}/callback/microsoft?code=${code}&state=${encodeURIComponent(state)}`,
      { headers: { cookie: jar.header() } },
    ),
  );
  jar.absorb(callback);
  const location = callback.headers.get('location');
  const error = location ? new URL(location, origin).searchParams.get('error') : null;
  return { status: callback.status, location, error, jar, response: callback };
}
