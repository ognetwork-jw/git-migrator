import { describe, expect, it } from 'vitest';
import { AdapterError } from './errors.ts';
import {
  collect,
  flattenPages,
  paginateCursor,
  paginateLinks,
  parseLinkHeader,
} from './pagination.ts';
import type { Page } from './types.ts';

async function drain<T>(iterable: AsyncIterable<T>): Promise<void> {
  for await (const _ of iterable) {
    // drain
  }
}

describe('pagination helpers', () => {
  it('[ADP-060] parses Link headers with several relations and quoted parameters', () => {
    const links = parseLinkHeader(
      '<https://h.test/r?page=2>; rel="next", <https://h.test/r?page=9>; rel="last"; title="x, y", <https://h.test/r?page=1>; rel="first prev"',
    );
    expect(links).toEqual({
      next: 'https://h.test/r?page=2',
      last: 'https://h.test/r?page=9',
      first: 'https://h.test/r?page=1',
      prev: 'https://h.test/r?page=1',
    });
    expect(parseLinkHeader(null)).toEqual({});
    expect(parseLinkHeader('garbage')).toEqual({});
  });

  it('[ADP-060] follows link-based pages until no next link', async () => {
    const pages: Record<string, { items: number[]; next?: string }> = {
      first: { items: [1, 2], next: 'p2' },
      p2: { items: [3], next: 'p3' },
      p3: { items: [4] },
    };
    const seen: (string | undefined)[] = [];
    const out: number[] = [];
    for await (const page of paginateLinks({
      fetchPage: async (link) => {
        seen.push(link);
        return pages[link ?? 'first'] as { items: number[]; next?: string };
      },
      next: (page) => page.next,
    })) {
      out.push(...page.items);
    }
    expect(out).toEqual([1, 2, 3, 4]);
    expect(seen).toEqual([undefined, 'p2', 'p3']);
  });

  it('[ADP-060] stops a looping link with an invalid AdapterError', async () => {
    const run = () => drain(paginateLinks({ fetchPage: async () => 1, next: () => 'same' }));
    await expect(run()).rejects.toBeInstanceOf(AdapterError);
    await expect(run()).rejects.toThrow(/repeated/);
  });

  it('[ADP-060] stops link pagination at maxPages', async () => {
    let n = 0;
    await expect(
      drain(paginateLinks({ fetchPage: async () => 1, next: () => `l${n++}`, maxPages: 3 })),
    ).rejects.toThrow(/within 3 pages/);
  });

  it('[ADP-060] follows cursors and flattens items', async () => {
    const data: Record<string, Page<string>> = {
      start: { items: ['a', 'b'], nextCursor: 'c1' },
      c1: { items: ['c'] },
    };
    const cursors: (string | undefined)[] = [];
    const items = await collect(
      flattenPages(
        paginateCursor({
          fetchPage: async (cursor) => {
            cursors.push(cursor);
            return data[cursor ?? 'start'] as Page<string>;
          },
        }),
      ),
    );
    expect(items).toEqual(['a', 'b', 'c']);
    expect(cursors).toEqual([undefined, 'c1']);
  });

  it('[ADP-060] stops a repeated or endless cursor', async () => {
    await expect(
      drain(paginateCursor({ fetchPage: async () => ({ items: [1], nextCursor: 'x' }) })),
    ).rejects.toThrow(/cursor repeated/);
    let n = 0;
    await expect(
      drain(
        paginateCursor({
          fetchPage: async () => ({ items: [1], nextCursor: `c${n++}` }),
          maxPages: 2,
        }),
      ),
    ).rejects.toThrow(/within 2 pages/);
  });

  it('[ADP-060] collect honours a limit', async () => {
    async function* numbers() {
      yield* [1, 2, 3, 4];
    }
    expect(await collect(numbers(), 2)).toEqual([1, 2]);
    expect(await collect(numbers(), 0)).toEqual([]);
    expect(await collect(numbers())).toEqual([1, 2, 3, 4]);
  });
});
