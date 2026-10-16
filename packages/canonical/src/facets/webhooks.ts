/** webhooks (FAC-WEB). The element schema is shared with org-webhooks. */
import { sha256Hex } from '@git-migrator/core';
import { z } from 'zod';
import { declareFacet, nonEmpty } from '../common.ts';

export const CANONICAL_EVENTS = [
  'push',
  'cr.opened',
  'cr.updated',
  'cr.merged',
  'cr.declined',
  'cr.comment',
  'cr.approved',
  'cr.changes_requested',
  'build.status',
  'repo.updated',
  'repo.fork',
  'issue.any',
] as const;
/**
 * An absolute http(s) URL without userinfo. Query strings are allowed: real hooks carry
 * parameters such as `?token=`. The value may contain credentials, including in the path
 * (ADR-0088), so it must be redacted wherever it is logged, diffed or reported.
 */
export function webhookUrlProblem(value: string): string | undefined {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return 'must be an absolute http(s) URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'must be an http(s) URL';
  if (u.username !== '' || u.password !== '') return 'must not contain credentials (userinfo)';
  return undefined;
}
export const webhookUrlSchema = nonEmpty.superRefine((v, ctx) => {
  const problem = webhookUrlProblem(v);
  if (problem !== undefined) ctx.addIssue({ code: 'custom', message: `url ${problem}` });
});

/** `%xx` escapes: an unreserved character is decoded, any other escape gets upper-case hex. */
function normalizeEscapes(text: string): string {
  return text.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => {
    const c = String.fromCharCode(Number.parseInt(hex, 16));
    return /^[A-Za-z0-9._~-]$/.test(c) ? c : `%${hex.toUpperCase()}`;
  });
}

/**
 * The collection key of a hook: `<origin>#<first 16 hex of sha256(normalized URL)>`. The key
 * identifies the hook in field paths without exposing the path or query of the URL, which often
 * carry the credential. Hooks with the same normalized URL share a key. The normalized URL is the
 * WHATWG form (lower-case scheme and host, default port removed, dot segments resolved) without
 * the fragment (never sent to the receiver) or an empty `?`, with escapes of unreserved characters
 * decoded and other escapes in upper-case hex (RFC 3986 section 6.2.2). Not normalized: a trailing
 * `.` in the host, the order of query parameters, and `+` against `%20`, which receivers may read
 * differently. Throws an `Error` that carries neither the URL nor a cause on an invalid URL.
 */
export function webhookKey(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // The parser's TypeError carries the raw URL (`input`), which may hold the credential.
    throw new Error('webhookKey: not a valid URL');
  }
  u.hash = '';
  if (u.search === '') u.search = '';
  return `${u.origin}#${sha256Hex(normalizeEscapes(u.href)).slice(0, 16)}`;
}

/** `<origin>/…`: safe to log, diff or show. Returns `<invalid url>` for anything unparsable. */
export function redactWebhookUrl(url: string): string {
  try {
    return `${new URL(url).origin}/…`;
  } catch {
    return '<invalid url>';
  }
}

export type CanonicalEvent = (typeof CANONICAL_EVENTS)[number];

export type Webhook = {
  // key: key (derived from url, see webhookKey)
  key: string;
  url: string;
  events: CanonicalEvent[]; // sorted set
  active: boolean;
  hasSecret: boolean; // secret value is unreadable
  verifyTls: boolean;
};
export type Webhooks = { hooks: Webhook[] };

export const webhookSchema: z.ZodType<Webhook> = z
  .strictObject({
    key: nonEmpty,
    url: webhookUrlSchema,
    events: z.array(z.enum(CANONICAL_EVENTS)),
    active: z.boolean(),
    hasSecret: z.boolean(),
    verifyTls: z.boolean(),
  })
  .refine(
    (h) => {
      try {
        return h.key === webhookKey(h.url);
      } catch {
        return false;
      }
    },
    { message: 'key must equal webhookKey(url)', path: ['key'] },
  );

export const webhooksSchema: z.ZodType<Webhooks> = z.strictObject({
  hooks: z.array(webhookSchema),
});

export const webhooksFacet = declareFacet({
  key: 'webhooks',
  scope: 'repository',
  schema: webhooksSchema,
  collections: [{ path: '/hooks', key: 'key' }],
  sets: ['/hooks/events'],
});
