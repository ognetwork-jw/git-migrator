import { applyFields, applyQuery, applySort, QueryError } from './query.ts';

/** An out-of-range page: the real API answers 404 (the OpenAPI document is silent, ADR-0060). */
export class PageNotFoundError extends Error {}

export interface PageOptions {
  /** Used when the request has no `pagelen`. Bitbucket documents 10. */
  defaultPagelen: number;
  /** Largest `pagelen` the endpoint serves; larger requests are clamped (never an error). */
  maxPagelen: number;
}

export const DEFAULT_PAGE_OPTIONS: PageOptions = { defaultPagelen: 10, maxPagelen: 100 };

export interface Page {
  size: number;
  page: number;
  pagelen: number;
  next?: string;
  previous?: string;
  values: unknown[];
}

/**
 * Builds a Bitbucket paginated envelope: `size`, `page`, `pagelen`, `values` and absolute `next`
 * and `previous` links that preserve every other query parameter. Also applies `q` and `sort`.
 */
export function paginate(
  requestUrl: string,
  items: unknown[],
  opts: PageOptions,
  {
    filterable = false,
    envelope = 'full',
  }: { filterable?: boolean; envelope?: 'full' | 'minimal' } = {},
): Page {
  const url = new URL(requestUrl);
  const q = url.searchParams.get('q') ?? undefined;
  const sort = url.searchParams.get('sort') ?? undefined;
  let rows = items;
  if (filterable) {
    rows = applySort(applyQuery(rows, q), sort);
  }
  const rawLen = Number(url.searchParams.get('pagelen') ?? opts.defaultPagelen);
  if (!Number.isInteger(rawLen) || rawLen < 1)
    throw new QueryError('pagelen must be a positive integer');
  const pagelen = Math.min(rawLen, opts.maxPagelen);
  const rawPage = Number(url.searchParams.get('page') ?? 1);
  if (!Number.isInteger(rawPage) || rawPage < 1)
    throw new QueryError('page must be a positive integer');
  const start = (rawPage - 1) * pagelen;
  if (rawPage > 1 && start >= rows.length) throw new PageNotFoundError(`Invalid page ${rawPage}`);
  const values = rows.slice(start, start + pagelen);
  const link = (page: number) => {
    const u = new URL(requestUrl);
    u.searchParams.set('page', String(page));
    u.searchParams.set('pagelen', String(pagelen));
    return u.toString();
  };
  if (envelope === 'minimal') {
    // Some closed schemas (webhook lists) carry only values, pagelen and next.
    const min: Pick<Page, 'pagelen' | 'next' | 'values'> = { values, pagelen };
    if (start + pagelen < rows.length) min.next = link(rawPage + 1);
    return min as Page;
  }
  const out: Page = { size: rows.length, page: rawPage, pagelen, values };
  if (start + pagelen < rows.length) out.next = link(rawPage + 1);
  if (rawPage > 1) out.previous = link(rawPage - 1);
  return out;
}

export function narrow(requestUrl: string, body: unknown): unknown {
  return applyFields(body, new URL(requestUrl).searchParams.get('fields') ?? undefined);
}
