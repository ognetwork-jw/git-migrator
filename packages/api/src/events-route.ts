import { can } from '@git-migrator/auth';
import { LIST_TOPICS, MAX_TOPICS, parseTopicList } from '@git-migrator/core';
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { EventHub } from './events.ts';
import type { Principal } from './principal.ts';
import { ProblemError, ProblemSchema, problemResponse } from './problem.ts';

const problemContent = { 'application/problem+json': { schema: ProblemSchema } };

export const eventsRoute = createRoute({
  method: 'get',
  path: '/events',
  summary: 'Server-sent events for the topics a client shows (JOB-060)',
  description: [
    'Events carry identifiers only; a client refetches what changed, so permissions are enforced on the refetch.',
    `Topics: \`migration:<id>\`, \`run:<id>\`, \`task:<id>\`, \`endpoint:<id>\`, \`invitation:<id>\`, \`quota\` and ${LIST_TOPICS.map((t) => `\`${t}\``).join(', ')}.`,
    'A comment and a `heartbeat` event arrive every 15 seconds. A `resync` event means events may have been missed.',
  ].join(' '),
  security: [{ bearerAuth: [] }, { sessionCookie: [] }],
  request: {
    query: z.object({
      topics: z.string().openapi({
        description: `Comma separated, 1 to ${MAX_TOPICS} topics.`,
        example: 'migration:abc,run:def,list:migrations,quota',
      }),
    }),
  },
  responses: {
    200: {
      description: 'An event stream',
      content: { 'text/event-stream': { schema: z.string() } },
    },
    401: { description: 'Problem', content: problemContent },
    403: { description: 'Problem', content: problemContent },
    422: { description: 'Problem', content: problemContent },
    429: { description: 'Problem', content: problemContent },
  },
});

/** Headers of an SSE response. `no-transform` and `x-accel-buffering` keep proxies from buffering it. */
export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
} as const;

/**
 * The handler. Every role reads everything (AUTH-020), so the `read` capability decides; the
 * topic kinds are validated rather than looked up, and the events carry no data to protect.
 */
export function eventsHandler(hub: EventHub) {
  return (c: Context<{ Variables: { principal: Principal } }>): Response => {
    if (!can(c.get('principal').actor, 'read')) {
      throw new ProblemError('forbidden', { detail: 'requires the read capability' });
    }
    const parsed = parseTopicList(new URL(c.req.url).searchParams.get('topics') ?? undefined);
    if (!parsed.ok) {
      throw new ProblemError('validation_failed', {
        errors: [{ path: 'topics', message: parsed.reason }],
      });
    }
    const body = hub.stream({
      topics: parsed.topics,
      owner: c.get('principal').actor.id,
      signal: c.req.raw.signal,
    });
    if (!body) return problemResponse('too_many_streams', { headers: { 'retry-after': '5' } });
    return new Response(body, { status: 200, headers: SSE_HEADERS });
  };
}
