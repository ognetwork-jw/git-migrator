import type { ShellActor, ShellRole } from '../shell/navigation.ts';
import { ROLES } from '../shell/navigation.ts';

export const ME_PATH = '/api/v1/me';
/** The TanStack Query key of the signed-in Actor. */
export const ACTOR_QUERY_KEY = ['me'] as const;

export interface Actor extends ShellActor {
  readonly id: string;
  readonly email: string | null;
}

export type ActorResult =
  | { readonly kind: 'ok'; readonly actor: Actor }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'problem'; readonly code: string };

const isRole = (value: unknown): value is ShellRole => ROLES.some((role) => role === value);

function parseActor(body: unknown): Actor | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { id, displayName, email, role, disabled } = body as Record<string, unknown>;
  if (typeof id !== 'string' || typeof displayName !== 'string' || !isRole(role)) return undefined;
  return {
    id,
    displayName,
    email: typeof email === 'string' ? email : null,
    role,
    disabled: disabled === true,
  };
}

/** The `code` of an RFC 9457 problem body (API-011), or `internal_error` when it has none. */
export async function problemCodeOf(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const code = (body as { code?: unknown } | null)?.code;
    return typeof code === 'string' && /^[a-z_]+$/.test(code) ? code : 'internal_error';
  } catch {
    return 'internal_error';
  }
}

/**
 * Loads the signed-in Actor (`GET /api/v1/me`). Name, email and role come from the Actor, never
 * from the Better Auth session user (ADR-0171). A 401 means "sign in"; any other failure is a
 * problem code the shell renders from `problem.<code>`.
 */
export async function fetchActor(fetchImpl: typeof fetch = fetch): Promise<ActorResult> {
  let response: Response;
  try {
    response = await fetchImpl(ME_PATH, { headers: { accept: 'application/json' } });
  } catch {
    return { kind: 'problem', code: 'not_ready' };
  }
  if (response.status === 401) return { kind: 'unauthenticated' };
  if (!response.ok) return { kind: 'problem', code: await problemCodeOf(response) };
  try {
    const actor = parseActor(await response.json());
    if (actor !== undefined) return { kind: 'ok', actor };
  } catch {
    // Falls through to the problem below.
  }
  return { kind: 'problem', code: 'internal_error' };
}
