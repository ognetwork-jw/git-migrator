import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRow, deleteRow, findMany, updateRow } from './rpc.ts';

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Records the requests a helper makes and answers each with `body`. */
function recording(body: unknown) {
  const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) => reply(body));
  vi.stubGlobal('fetch', fetchImpl);
  return fetchImpl;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[API-012] ZenStack RPC client', () => {
  it('[API-012] findMany sends its arguments as JSON in q and unwraps the data', async () => {
    const fetchImpl = recording({ data: [{ id: 'a' }] });
    const rows = await findMany<{ id: string }>('namingRule', { where: { routeId: 'r1' } });
    expect(rows).toEqual([{ id: 'a' }]);
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]), 'http://localhost');
    expect(url.pathname).toBe('/api/model/namingRule/findMany');
    expect(JSON.parse(url.searchParams.get('q') ?? '')).toEqual({ where: { routeId: 'r1' } });
  });

  it('[API-012] create posts {data}, update puts {where, data} and delete takes {where} in q', async () => {
    const fetchImpl = recording({ data: { id: 'x' } });
    await createRow('namingRule', { routeId: 'r1', facetKey: 'webhooks' });
    await updateRow('namingRule', { id: 'x' }, { enabled: false });
    await deleteRow('namingRule', { id: 'x' });

    const [createPath, createInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(createPath).toBe('/api/model/namingRule/create');
    expect(createInit.method).toBe('POST');
    expect(JSON.parse(String(createInit.body))).toEqual({
      data: { routeId: 'r1', facetKey: 'webhooks' },
    });

    const [updatePath, updateInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(updatePath).toBe('/api/model/namingRule/update');
    expect(updateInit.method).toBe('PUT');
    expect(JSON.parse(String(updateInit.body))).toEqual({
      where: { id: 'x' },
      data: { enabled: false },
    });

    const [deletePath, deleteInit] = fetchImpl.mock.calls[2] as unknown as [string, RequestInit];
    expect(deletePath.startsWith('/api/model/namingRule/delete?q=')).toBe(true);
    expect(deleteInit.method).toBe('DELETE');
    expect(JSON.parse(decodeURIComponent(deletePath.split('q=')[1] ?? ''))).toEqual({
      where: { id: 'x' },
    });
  });

  it('[API-012] a refused write rejects with the problem code, so the page can say why', async () => {
    recording({ code: 'forbidden' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply({ code: 'forbidden' }, 403)),
    );
    await expect(createRow('namingRule', { routeId: 'r1' })).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });
});
