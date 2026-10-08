/** GitHub's `page` / `per_page` pagination with `Link` headers. */

export interface PageRequest {
  page: number;
  perPage: number;
}

export interface Paged<T> {
  items: T[];
  link: string | null;
  total: number;
}

export function pageRequest(
  url: URL,
  defaults: { perPage?: number; max?: number } = {},
): PageRequest {
  const max = defaults.max ?? 100;
  const per = Number(url.searchParams.get('per_page'));
  const page = Number(url.searchParams.get('page'));
  return {
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    perPage: Number.isInteger(per) && per >= 1 ? Math.min(per, max) : (defaults.perPage ?? 30),
  };
}

/**
 * Slices `all` and builds the `Link` header with `next`, `prev`, `first` and `last` relations as
 * absolute URLs that keep every other query parameter. No header when everything fits one page.
 */
export function paginate<T>(
  all: T[],
  url: URL,
  defaults?: { perPage?: number; max?: number },
): Paged<T> {
  const { page, perPage } = pageRequest(url, defaults);
  const last = Math.max(1, Math.ceil(all.length / perPage));
  const items = all.slice((page - 1) * perPage, page * perPage);
  const href = (p: number) => {
    const u = new URL(url);
    u.searchParams.set('page', String(p));
    if (url.searchParams.has('per_page') || perPage !== (defaults?.perPage ?? 30))
      u.searchParams.set('per_page', String(perPage));
    return u.toString();
  };
  const rels: string[] = [];
  if (page < last) {
    rels.push(`<${href(page + 1)}>; rel="next"`);
    rels.push(`<${href(last)}>; rel="last"`);
  }
  if (page > 1) {
    rels.push(`<${href(page - 1)}>; rel="prev"`);
    rels.push(`<${href(1)}>; rel="first"`);
  }
  return { items, link: rels.length ? rels.join(', ') : null, total: all.length };
}
