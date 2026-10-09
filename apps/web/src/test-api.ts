import { vi } from 'vitest';

/**
 * Test helpers for pages that call `/api/v1` and the ZenStack RPC mount (`/api/model`). Responses are
 * mocked; no request leaves the test (TST-006). Used only by tests.
 */

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const problem = (status: number, code: string) =>
  new Response(
    JSON.stringify({
      type: `https://git-migrator.invalid/problems/${code}`,
      title: code,
      status,
      code,
    }),
    {
      status,
      headers: { 'content-type': 'application/problem+json' },
    },
  );

export interface Call {
  readonly url: URL;
  readonly init?: RequestInit;
}

/** A handler returns a response for the calls it knows, or `undefined` to fall through. */
export type Handler = (url: URL, init?: RequestInit) => Response | undefined;

/** Parses the JSON body of a recorded call. */
export const bodyOf = (call: Call | undefined): Record<string, unknown> =>
  JSON.parse(String(call?.init?.body ?? 'null')) as Record<string, unknown>;

/** The RPC model and operation of a `/api/model/<model>/<op>` path. */
export const rpcOf = (url: URL) => {
  const parts = url.pathname.split('/');
  return parts[1] === 'api' && parts[2] === 'model' && parts[3] && parts[4]
    ? { model: parts[3], op: parts[4] }
    : undefined;
};

/**
 * Stubs `fetch`. `rows` answers `findMany` per RPC model; `create`, `update` and `delete` echo their
 * data back, so tests can see what the page sent. Anything else goes to `handler`, then 404.
 */
export function mockApi(
  handler: Handler,
  rows: Readonly<Record<string, readonly unknown[]>> = {},
): { readonly calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      calls.push({ url, ...(init ? { init } : {}) });
      const rpc = rpcOf(url);
      if (rpc) {
        if (rpc.op === 'findMany') return json({ data: rows[rpc.model] ?? [] });
        const sent = bodyOf({ url, ...(init ? { init } : {}) }) as { data?: object };
        if (rpc.op === 'create') return json({ data: { id: 'new-id', ...sent.data } }, 201);
        if (rpc.op === 'update') return json({ data: { id: 'updated', ...sent.data } });
        if (rpc.op === 'delete') return json({ data: { id: 'deleted' } });
      }
      return handler(url, init) ?? json({ code: 'not_found' }, 404);
    }),
  );
  return { calls };
}

export const callsTo = (calls: readonly Call[], method: string, path: string) =>
  calls.filter((c) => c.init?.method === method && c.url.pathname === path);
