import { apiRequest } from '../api/http.ts';

/**
 * The ZenStack RPC mount (`/api/model`, API-012). Reads of the configuration and Actor pages go
 * through it, and so do the allow-listed writes (NamingRule, WebhookAllowlistEntry). Overlay writes are not RPC: they go to `/api/v1/overlays` (ADR-0362). The
 * server enforces the policies; a refused call is a problem code like any other.
 *
 * Protocol (ZenStack RPC): `findMany` takes its arguments as JSON in `q`; `create` posts
 * `{data}`; `update` puts `{where, data}`; `delete` takes `{where}` in `q`. Each answer is `{data}`.
 */
export const MODEL_PATH = '/api/model';

export type Args = Readonly<Record<string, unknown>>;

export const findMany = <T>(model: string, args: Args = {}): Promise<T[]> =>
  apiRequest<{ data: T[] }>(
    `${MODEL_PATH}/${model}/findMany?q=${encodeURIComponent(JSON.stringify(args))}`,
  ).then((r) => r.data);

export const createRow = <T>(model: string, data: Args): Promise<T> =>
  apiRequest<{ data: T }>(`${MODEL_PATH}/${model}/create`, {
    method: 'POST',
    json: { data },
  }).then((r) => r.data);

export const updateRow = <T>(model: string, where: Args, data: Args): Promise<T> =>
  apiRequest<{ data: T }>(`${MODEL_PATH}/${model}/update`, {
    method: 'PUT',
    json: { where, data },
  }).then((r) => r.data);

export const deleteRow = (model: string, where: Args): Promise<unknown> =>
  apiRequest<{ data: unknown }>(
    `${MODEL_PATH}/${model}/delete?q=${encodeURIComponent(JSON.stringify({ where }))}`,
    { method: 'DELETE' },
  );
