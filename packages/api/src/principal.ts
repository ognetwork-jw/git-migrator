import { API_KEY_PATTERN, type AuthService, verifyApiKey } from '@git-migrator/auth';
import type { Actor, Db } from '@git-migrator/db';

/** Who a request acts as (AUTH-020): an Actor reached through a session cookie or an API key. */
export interface Principal {
  readonly actor: Actor;
  readonly via: 'session' | 'api_key';
}

const BEARER = /^Bearer[ \t]+(\S+)$/i;

/** The key in an `Authorization: Bearer gm_...` header, or the raw token when it is not a key. */
export function bearerToken(headers: Headers): string | undefined {
  const header = headers.get('authorization');
  if (header === null) return undefined;
  return BEARER.exec(header.trim())?.[1] ?? '';
}

/**
 * Resolves a request to a Principal or `undefined` (the caller answers 401). An `Authorization`
 * header decides on its own: when it is present and is not a valid API key the request is
 * rejected, whatever cookies it carries. Otherwise the Better Auth session is looked up and
 * mapped to its Actor by `authUserId`. A disabled Actor is rejected on every request, so an
 * existing session stops working at once (AUTH-020, AUTH-005). Name and email come from the Actor,
 * never from `session.user`, which holds a synthetic address (ADR-0171).
 */
export async function resolvePrincipal(
  deps: { readonly auth: AuthService; readonly privileged: Db },
  headers: Headers,
): Promise<Principal | undefined> {
  const token = bearerToken(headers);
  if (token !== undefined) {
    if (!API_KEY_PATTERN.test(token)) return undefined;
    const verified = await verifyApiKey(deps.privileged, token);
    return verified.status === 'ok' ? { actor: verified.actor, via: 'api_key' } : undefined;
  }
  if (!headers.has('cookie')) return undefined;
  const session = await deps.auth.auth.api.getSession({ headers });
  const userId = session?.user.id;
  if (typeof userId !== 'string') return undefined;
  const actor = await deps.privileged.actor.findUnique({ where: { authUserId: userId } });
  if (!actor || actor.disabled) return undefined;
  return { actor, via: 'session' };
}
