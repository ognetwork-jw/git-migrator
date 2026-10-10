import { describe, expect, it } from 'vitest';
import { AUTH_POOL_MAX, createAuthPool } from './storage.ts';

describe('Better Auth pool (DATA-010)', () => {
  it('[DATA-010] the web process holds a Better Auth pool of 5 by default', async () => {
    expect(AUTH_POOL_MAX).toBe(5);
    // Creating a pg.Pool opens no connection, so no database is needed.
    const pool = createAuthPool('postgres://user@127.0.0.1:1/none');
    try {
      expect(pool.options.max).toBe(5);
      expect(pool.options.options).toBe('-c search_path=auth');
    } finally {
      await pool.end();
    }
  });
});
