import { Hono } from 'hono';
import { handle } from 'hono/vercel';
import { getApiRuntime } from '../../../src/server/api.ts';

/** The Hono app of API-001 runs on Node.js: it needs `pg` and the Better Auth server code. */
export const runtime = 'nodejs';
/** Never cached or prerendered: every request is authenticated. */
export const dynamic = 'force-dynamic';

/**
 * Hono's Next.js adapter takes an app, and the real one (database pool, Better Auth) is built on
 * the first request rather than when Next.js imports this module during `next build`.
 */
const gateway = new Hono();
gateway.all('*', (c) => getApiRuntime().app.fetch(c.req.raw));

const handler = handle(gateway);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
