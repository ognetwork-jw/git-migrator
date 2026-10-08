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

/**
 * The collection key of a hook: `<origin>#<first 16 hex of sha256(new URL(url).href)>`. The key
 * identifies the hook in field paths without exposing the path or query of the URL, which often
 * carry the credential. Hooks with the same normalized URL share a key. Throws on an invalid URL.
 */
export function webhookKey(url: string): string {
  const u = new URL(url);
  return `${u.origin}#${sha256Hex(u.href).slice(0, 16)}`;
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
