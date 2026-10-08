import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, PageQuerySchema, toPage } from './pagination.ts';
import { PROBLEM_BASE, PROBLEMS, problemBody, problemResponse } from './problem.ts';

describe('[API-011] cursor pagination', () => {
  it('[API-011] limit defaults to 50 and is at most 200', () => {
    expect(PageQuerySchema.parse({})).toEqual({ limit: DEFAULT_PAGE_LIMIT });
    expect(PageQuerySchema.parse({ limit: '200', cursor: 'abc' })).toEqual({
      limit: MAX_PAGE_LIMIT,
      cursor: 'abc',
    });
    for (const limit of ['0', '201', '-1', '1.5', 'x']) {
      expect(PageQuerySchema.safeParse({ limit }).success, limit).toBe(false);
    }
    expect(PageQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
  });

  it('[API-011] a row beyond the limit proves a next page, whose cursor is the last kept item', () => {
    const rows = [1, 2, 3];
    expect(toPage(rows, 2, (n) => `c${n}`)).toEqual({ items: [1, 2], nextCursor: 'c2' });
    expect(toPage(rows, 3, (n) => `c${n}`)).toEqual({ items: [1, 2, 3], nextCursor: null });
    expect(toPage([], 5, String)).toEqual({ items: [], nextCursor: null });
  });
});

describe('[API-011] problem documents', () => {
  it('[API-011] every problem has a type URI under the reserved .invalid host and a matching status', async () => {
    for (const [code, { status, title }] of Object.entries(PROBLEMS)) {
      const body = problemBody(code as keyof typeof PROBLEMS, { detail: 'd' });
      expect(body).toMatchObject({
        type: `${PROBLEM_BASE}${code}`,
        status,
        title,
        code,
        detail: 'd',
      });
      expect(new URL(body.type).hostname).toBe('git-migrator.invalid');
      const res = problemResponse(code as keyof typeof PROBLEMS);
      expect(res.status).toBe(status);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
    }
  });
});
