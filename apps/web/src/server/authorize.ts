import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { type ActorResult, fetchActor } from '../api/actor.ts';
import { signInHref } from '../auth/paths.ts';
import { canOpen, deniedHref } from '../shell/navigation.ts';
import { getApiRuntime } from './api.ts';

export type PageAccess =
  | { readonly kind: 'allow' }
  | { readonly kind: 'redirect'; readonly to: string }
  | { readonly kind: 'problem'; readonly code: string };

/**
 * What a visitor may do with `pathname`, given the Actor the API resolved for the request
 * (ADR-0321). The capability is the one the page's sidebar item names (ADR-0300).
 */
export function accessFor(result: ActorResult, pathname: string): PageAccess {
  if (result.kind === 'unauthenticated') return { kind: 'redirect', to: signInHref(pathname) };
  if (result.kind === 'problem') return { kind: 'problem', code: result.code };
  return canOpen(result.actor, pathname)
    ? { kind: 'allow' }
    : { kind: 'redirect', to: deniedHref(pathname) };
}

/** Request headers that carry the caller's identity to the API. Nothing else is forwarded. */
const FORWARDED = ['cookie', 'authorization'] as const;

/**
 * Server-side gate of a page (AUTH-021, ADR-0321): resolves the Actor through the API in process,
 * with the caller's own credentials, and redirects to sign-in or `/denied` before the page
 * renders. The browser-side redirect of the shell only improves the experience.
 */
export async function authorizePage(pathname: string): Promise<void> {
  const incoming = await headers();
  const forwarded: Record<string, string> = {};
  for (const name of FORWARDED) {
    const value = incoming.get(name);
    if (value !== null) forwarded[name] = value;
  }
  const result = await fetchActor(async (input, init) =>
    getApiRuntime().app.request(String(input), {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), ...forwarded },
    }),
  );
  const access = accessFor(result, pathname);
  if (access.kind === 'redirect') redirect(access.to);
  // The API could not answer: do not render a gated page without knowing who is asking.
  if (access.kind === 'problem') throw new Error(`authorization unavailable: ${access.code}`);
}
