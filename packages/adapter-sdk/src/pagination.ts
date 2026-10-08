/**
 * Pagination helpers (ADP-060): link-based and cursor-based. Neutral: the adapter says where the
 * next page is (a `next` link from the body or a `Link` header, or an opaque cursor).
 */
import { AdapterError } from './errors.ts';
import type { Page } from './types.ts';

export const DEFAULT_MAX_PAGES = 1000;
const MAX_LINK_HEADER_CHARS = 64 * 1024;

/** One pass over the header: `<url>` then `;`-separated params, entries split on `,` outside quotes. */
export function parseLinkHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === null || header === undefined) return out;
  const text =
    header.length > MAX_LINK_HEADER_CHARS ? header.slice(0, MAX_LINK_HEADER_CHARS) : header;
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('<', i);
    if (open < 0) break;
    const close = text.indexOf('>', open + 1);
    if (close < 0) break;
    const url = text.slice(open + 1, close);
    // Collect params up to the next comma that is outside quotes.
    let j = close + 1;
    let quoted = false;
    let param = '';
    const params: string[] = [];
    for (; j < text.length; j++) {
      const ch = text[j] as string;
      if (ch === '"') quoted = !quoted;
      if (!quoted && ch === ',') break;
      if (!quoted && ch === ';') {
        params.push(param);
        param = '';
      } else {
        param += ch;
      }
    }
    params.push(param);
    i = j + 1;
    for (const p of params) {
      const eq = p.indexOf('=');
      if (eq < 0 || p.slice(0, eq).trim().toLowerCase() !== 'rel') continue;
      const value = p
        .slice(eq + 1)
        .trim()
        .replace(/^"|"$/g, '');
      for (const name of value.split(/\s+/)) {
        const key = name.toLowerCase();
        if (key !== '' && !(key in out)) out[key] = url;
      }
    }
  }
  return out;
}

/** Normalises a link for loop detection: parsed as a URL, query parameters sorted, fragment dropped. */
function normaliseLink(link: string): string {
  try {
    const url = new URL(link, 'http://link.invalid');
    url.searchParams.sort();
    url.hash = '';
    return url.toString();
  } catch {
    return link;
  }
}

function tooMany(maxPages: number): AdapterError {
  return new AdapterError({
    code: 'invalid',
    provider: 'adapter-sdk',
    message: `Pagination did not end within ${maxPages} pages`,
  });
}

export interface LinkPaginationOptions<R> {
  /** Fetches one page: the first call gets `undefined`, later calls get the next link. */
  readonly fetchPage: (link: string | undefined) => Promise<R>;
  /** Extracts the next link from a page, or `undefined` on the last one. */
  readonly next: (page: R) => string | undefined;
  /** Default 1000. */
  readonly maxPages?: number;
  /** The URL of the first request, so a link back to it counts as a loop. */
  readonly firstUrl?: string;
}

/** Walks link-based pages, yielding each raw page. A repeated link stops with an error (a loop). */
export async function* paginateLinks<R>(options: LinkPaginationOptions<R>): AsyncGenerator<R> {
  const max = options.maxPages ?? DEFAULT_MAX_PAGES;
  const seen = new Set<string>(
    options.firstUrl === undefined ? [] : [normaliseLink(options.firstUrl)],
  );
  let link: string | undefined;
  for (let pages = 0; ; pages++) {
    if (pages >= max) throw tooMany(max);
    const page = await options.fetchPage(link);
    yield page;
    link = options.next(page);
    if (link === undefined) return;
    const key = normaliseLink(link);
    if (seen.has(key)) {
      throw new AdapterError({
        code: 'invalid',
        provider: 'adapter-sdk',
        message: 'Pagination link repeated',
      });
    }
    seen.add(key);
  }
}

export interface CursorPaginationOptions<T> {
  readonly fetchPage: (cursor: string | undefined) => Promise<Page<T>>;
  readonly maxPages?: number;
}

/** Walks cursor-based pages. A repeated cursor stops with an error (a loop). */
export async function* paginateCursor<T>(
  options: CursorPaginationOptions<T>,
): AsyncGenerator<Page<T>> {
  const max = options.maxPages ?? DEFAULT_MAX_PAGES;
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let pages = 0; ; pages++) {
    if (pages >= max) throw tooMany(max);
    const page = await options.fetchPage(cursor);
    yield page;
    if (page.nextCursor === undefined) return;
    if (seen.has(page.nextCursor)) {
      throw new AdapterError({
        code: 'invalid',
        provider: 'adapter-sdk',
        message: 'Pagination cursor repeated',
      });
    }
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

/** Flattens pages into items. */
export async function* flattenPages<T>(pages: AsyncIterable<Page<T>>): AsyncGenerator<T> {
  for await (const page of pages) yield* page.items;
}

/** Collects every item; `limit` stops early once reached. */
export async function collect<T>(
  items: AsyncIterable<T>,
  limit = Number.POSITIVE_INFINITY,
): Promise<T[]> {
  const out: T[] = [];
  if (limit <= 0) return out;
  for await (const item of items) {
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}
