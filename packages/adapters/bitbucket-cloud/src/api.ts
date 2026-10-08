/** Tolerant response schemas, paging and small caches (ADP-013: unknown fields are ignored). */
import {
  AdapterError,
  type DriverContext,
  type ProviderHttpClient,
  paginateLinks,
} from '@git-migrator/adapter-sdk';
import { z } from 'zod';
import { PROVIDER } from './config.ts';

export const obj = z.looseObject;

export const account = obj({
  type: z.string().optional(),
  uuid: z.string().optional(),
  account_id: z.string().optional(),
  nickname: z.string().optional(),
  display_name: z.string().optional(),
});
export type Account = z.infer<typeof account>;

export const groupRef = obj({ slug: z.string(), name: z.string().optional() });

export const project = obj({
  uuid: z.string(),
  key: z.string(),
  name: z.string().optional(),
});

export const repository = obj({
  uuid: z.string(),
  slug: z.string(),
  name: z.string(),
  full_name: z.string().optional(),
  description: z.string().nullish(),
  website: z.string().nullish(),
  is_private: z.boolean(),
  fork_policy: z.string().optional(),
  has_issues: z.boolean().optional(),
  has_wiki: z.boolean().optional(),
  size: z.number().nullish(),
  updated_on: z.string().nullish(),
  mainbranch: obj({ name: z.string().nullish() }).nullish(),
  project: project.optional(),
  links: obj({
    clone: z.array(obj({ name: z.string().optional(), href: z.string() })).optional(),
  }).optional(),
});
export type Repository = z.infer<typeof repository>;

export const envelope = obj({ values: z.array(z.unknown()), next: z.string().optional() });

/** Parses `value`; a mismatch is an `invalid` AdapterError naming the paths only, never values. */
export function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const paths = [...new Set(result.error.issues.map((i) => i.path.join('.') || '(root)'))]
    .slice(0, 5)
    .join(', ');
  throw new AdapterError({
    code: 'invalid',
    provider: PROVIDER,
    message: `Unexpected ${what} response shape at ${paths}`,
  });
}

export interface Fetched<T> {
  readonly items: T[];
  readonly rawResponseIds: string[];
}

export interface Req {
  readonly http: ProviderHttpClient;
  readonly ctx: Pick<DriverContext, 'pool' | 'signal'>;
}

/** Walks a `values`/`next` listing (all pages), parsing each item. */
export async function listAll<S extends z.ZodType>(
  r: Req,
  path: string,
  item: S,
  what: string,
  query: Record<string, string | number> = {},
  opts: { capture?: boolean } = {},
): Promise<Fetched<z.output<S>>> {
  const items: z.output<S>[] = [];
  const rawResponseIds: string[] = [];
  const pages = paginateLinks<{ values: unknown[]; next?: string }>({
    fetchPage: async (link) => {
      const res = await r.http.request({
        path: link ?? path,
        ...(link === undefined ? { query: { pagelen: 100, ...query } } : {}),
        pool: r.ctx.pool,
        signal: r.ctx.signal,
        capture: opts.capture ?? true,
      });
      if (res.rawResponseId !== undefined) rawResponseIds.push(res.rawResponseId);
      return parse(envelope, res.body, what);
    },
    next: (page) => page.next,
  });
  for await (const page of pages) {
    for (const v of page.values) items.push(parse(item, v, what));
  }
  return { items, rawResponseIds };
}

/** One JSON document. 404 gives `undefined` when `optional`. */
export async function getOne<S extends z.ZodType>(
  r: Req,
  path: string,
  schema: S,
  what: string,
  opts: { query?: Record<string, string | number>; optional?: boolean; capture?: boolean } = {},
): Promise<{ data: z.output<S> | undefined; rawResponseIds: string[] }> {
  try {
    const res = await r.http.request({
      path,
      ...(opts.query !== undefined ? { query: opts.query } : {}),
      pool: r.ctx.pool,
      signal: r.ctx.signal,
      capture: opts.capture ?? true,
    });
    return {
      data: parse(schema, res.body, what),
      rawResponseIds: res.rawResponseId === undefined ? [] : [res.rawResponseId],
    };
  } catch (error) {
    if (opts.optional === true && error instanceof AdapterError && error.code === 'not_found') {
      return { data: undefined, rawResponseIds: [] };
    }
    throw error;
  }
}

/** Single-flight cache with a TTL; failures are not cached. */
export class Memo {
  readonly #entries = new Map<string, { at: number; value: Promise<unknown> }>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(ttlMs: number, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.#entries.get(key);
    if (hit !== undefined && this.#now() - hit.at < this.#ttlMs) return hit.value as Promise<T>;
    const value = load();
    this.#entries.set(key, { at: this.#now(), value });
    value.catch(() => {
      if (this.#entries.get(key)?.value === value) this.#entries.delete(key);
    });
    return value;
  }
}

/** Percent-encodes one path segment (UUIDs carry braces, branch names carry slashes). */
export const enc = (value: string): string => encodeURIComponent(value);
