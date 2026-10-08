import { z } from '@hono/zod-openapi';

/** API-011: list endpoints use cursor pagination, `limit` at most 200. */
export const MAX_PAGE_LIMIT = 200;
export const DEFAULT_PAGE_LIMIT = 50;

export const PageQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});

export type PageQuery = z.infer<typeof PageQuerySchema>;

/** The response envelope of a list endpoint: `nextCursor` is `null` on the last page. */
export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

/**
 * Splits `rows` fetched with `take: limit + 1` into a page. `cursorOf` names the cursor of the last
 * item kept; a row beyond `limit` proves there is a next page.
 */
export function toPage<T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (item: T) => string,
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last !== undefined ? cursorOf(last) : null,
  };
}
