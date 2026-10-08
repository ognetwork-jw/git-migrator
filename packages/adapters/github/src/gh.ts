/**
 * Thin, typed access to the GitHub REST and GraphQL APIs on top of ProviderHttpClient. Reads can
 * record raw responses (`capture: true`); writes never retry (`retry: false`).
 */
import {
  AdapterError,
  type AdapterWarning,
  type FacetRead,
  type ProviderHttpClient,
  type ProviderResponse,
  paginateLinks,
  parseLinkHeader,
} from '@git-migrator/adapter-sdk';
import { PROVIDER } from './config.ts';

export type Json = Record<string, unknown>;

/** What a read collected: raw response ids, warnings and unreadable paths. */
export class Collector {
  readonly rawResponseIds: string[] = [];
  readonly warnings: AdapterWarning[] = [];
  readonly unreadable: string[] = [];
  readonly capabilities: NonNullable<FacetRead<unknown>['capabilities']> = {};

  warn(code: string, paths: string[], params: Record<string, unknown> = {}): void {
    this.warnings.push({ code, paths, params });
  }

  result<T>(data: T): FacetRead<T> {
    return {
      data,
      unreadable: this.unreadable,
      warnings: this.warnings,
      rawResponseIds: this.rawResponseIds,
      ...(Object.keys(this.capabilities).length > 0 ? { capabilities: this.capabilities } : {}),
    };
  }
}

export interface GhOptions {
  readonly pool?: 'background' | 'interactive';
  readonly signal?: AbortSignal;
  readonly collector?: Collector;
}

export type Query = Record<string, string | number | boolean | undefined>;

/** Encodes a ref or file path for a URL path, keeping `/`. */
export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export class Gh {
  constructor(
    readonly http: ProviderHttpClient,
    readonly options: GhOptions = {},
  ) {}

  /** Same client, with a collector for the raw response ids of one read. */
  collecting(collector: Collector): Gh {
    return new Gh(this.http, { ...this.options, collector });
  }

  #record(res: ProviderResponse): void {
    if (res.rawResponseId !== undefined)
      this.options.collector?.rawResponseIds.push(res.rawResponseId);
  }

  #base() {
    return {
      ...(this.options.pool ? { pool: this.options.pool } : {}),
      ...(this.options.signal ? { signal: this.options.signal } : {}),
    };
  }

  async get<T = Json>(path: string, query?: Query): Promise<T> {
    const res = await this.http.request<T>({
      ...this.#base(),
      method: 'GET',
      path,
      ...(query ? { query } : {}),
      capture: this.options.collector !== undefined,
    });
    this.#record(res);
    return res.body;
  }

  /** `null` on 404 (and 409, which GitHub uses for an empty repository). */
  async getOrNull<T = Json>(path: string, query?: Query): Promise<T | null> {
    try {
      return await this.get<T>(path, query);
    } catch (error) {
      if (
        error instanceof AdapterError &&
        (error.code === 'not_found' || error.code === 'conflict')
      ) {
        return null;
      }
      throw error;
    }
  }

  /** All items of a paginated list. `pick` extracts the array from an enveloped response. */
  async list<T = Json>(
    path: string,
    query: Query = {},
    pick: (body: unknown) => unknown = (b) => b,
    perPage = 100,
  ): Promise<T[]> {
    const items: T[] = [];
    const pages = paginateLinks<ProviderResponse>({
      fetchPage: async (link) => {
        const res = await this.http.request({
          ...this.#base(),
          method: 'GET',
          path: link ?? path,
          ...(link ? {} : { query: { per_page: perPage, ...query } }),
          capture: this.options.collector !== undefined,
        });
        this.#record(res);
        return res;
      },
      next: (res) => parseLinkHeader(res.headers.get('link')).next,
    });
    for await (const res of pages) {
      const body = pick(res.body);
      if (Array.isArray(body)) items.push(...(body as T[]));
    }
    return items;
  }

  /** One page of a list, with the next page number. */
  async page<T = Json>(
    path: string,
    page: number,
    query: Query = {},
    pick: (body: unknown) => unknown = (b) => b,
  ): Promise<{ items: T[]; next?: number }> {
    const res = await this.http.request({
      ...this.#base(),
      method: 'GET',
      path,
      query: { per_page: 100, ...query, page },
      capture: this.options.collector !== undefined,
    });
    this.#record(res);
    const body = pick(res.body);
    return {
      items: Array.isArray(body) ? (body as T[]) : [],
      ...(parseLinkHeader(res.headers.get('link')).next !== undefined ? { next: page + 1 } : {}),
    };
  }

  /** A write: never retried in process. */
  async send<T = Json>(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    json?: unknown,
  ): Promise<T> {
    const res = await this.http.request<T>({
      ...this.#base(),
      method,
      path,
      ...(json !== undefined ? { json } : {}),
      retry: false,
    });
    return res.body;
  }

  /** GraphQL. Errors in a 200 response become AdapterErrors. */
  async graphql<T = Json>(query: string, variables: Json, mutation = false): Promise<T> {
    const res = await this.http.request<{
      data?: T | null;
      errors?: { type?: string; message?: string }[];
    }>({
      ...this.#base(),
      method: 'POST',
      path: '/graphql',
      json: { query, variables },
      retry: !mutation,
      capture: this.options.collector !== undefined && !mutation,
    });
    this.#record(res);
    const errors = res.body?.errors;
    const noData = !res.body?.data;
    if (errors && errors.length > 0) {
      const first = errors[0] as { type?: string; message?: string };
      const type = String(first.type ?? '').toUpperCase();
      // An untyped error with no data is what a provider timeout looks like: a read may retry it.
      const code =
        type === 'FORBIDDEN'
          ? 'forbidden'
          : type === 'NOT_FOUND'
            ? 'not_found'
            : type === '' && noData && !mutation
              ? 'transient'
              : 'invalid';
      throw new AdapterError({
        code,
        provider: PROVIDER,
        message: `GraphQL ${type || 'error'}: ${String(first.message ?? '').slice(0, 300)}`,
        request: { method: 'POST', url: '/graphql', status: res.status },
      });
    }
    const data = res.body?.data;
    if (!data) {
      throw new AdapterError({
        code: mutation ? 'invalid' : 'transient',
        provider: PROVIDER,
        message: 'Empty GraphQL response',
      });
    }
    return data;
  }
}

export const repoPath = (owner: string, repo: string): string =>
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function obj(value: unknown): Json {
  return value !== null && typeof value === 'object' ? (value as Json) : {};
}
