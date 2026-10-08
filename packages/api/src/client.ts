import { hc } from 'hono/client';
import type { AppType } from './app.ts';

export type { AppType } from './app.ts';

/** The typed client of the custom endpoints (API-003): `createApiClient(origin).api.v1.me.$get()`. */
export const createApiClient = (baseUrl: string, options?: Parameters<typeof hc>[1]) =>
  hc<AppType>(baseUrl, options);
