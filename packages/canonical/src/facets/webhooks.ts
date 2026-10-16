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

/** A hook as a reader sees it, before its key is derived. */
export type RawWebhook = Omit<Webhook, 'key'>;

/** One key that several raw hooks share. `targetUrlDisplay` is redacted (`<origin>/…`). */
export interface WebhookDuplicate {
  readonly key: string;
  readonly count: number;
  readonly targetUrlDisplay: string;
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * For readers: providers allow several hooks with one URL, a canonical document does not
 * (ADR-0088). Merges the hooks whose `webhookKey` is the same into one: events are united,
 * `active` and `hasSecret` hold if any hook has them, `verifyTls` only if all do, and the smallest
 * raw URL stands for the group, so the result does not depend on the input order. `hooks` is
 * sorted by key; `groups` keeps every raw hook of each key (in input order, first-seen keys first)
 * and `duplicates` lists each key with more than one hook, for the caller's
 * `webhooks.duplicate-url` warning. Throws `webhookKey`'s URL-free `Error` on an invalid URL.
 */
export function mergeWebhooksByKey<T extends RawWebhook>(
  raw: readonly T[],
): { hooks: Webhook[]; groups: Map<string, T[]>; duplicates: WebhookDuplicate[] } {
  const groups = new Map<string, T[]>();
  for (const h of raw) {
    const key = webhookKey(h.url);
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  const hooks: Webhook[] = [];
  const duplicates: WebhookDuplicate[] = [];
  for (const [key, list] of groups) {
    const url = list.map((h) => h.url).sort(byCodeUnit)[0] as string;
    hooks.push({
      key,
      url,
      events: [...new Set(list.flatMap((h) => h.events))].sort(byCodeUnit),
      active: list.some((h) => h.active),
      hasSecret: list.some((h) => h.hasSecret),
      verifyTls: list.every((h) => h.verifyTls),
    });
    if (list.length > 1) {
      duplicates.push({ key, count: list.length, targetUrlDisplay: redactWebhookUrl(url) });
    }
  }
  return { hooks: hooks.sort((a, b) => byCodeUnit(a.key, b.key)), groups, duplicates };
}
