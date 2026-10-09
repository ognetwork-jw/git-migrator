import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The file is read as text: importing it would pull the framework's global type augmentation
// (`process.env.NODE_ENV`) into the test type-check of every package.
const source = readFileSync(join(import.meta.dirname, '../next.config.ts'), 'utf8');

describe('Next.js configuration', () => {
  it('[DEP-001] builds a standalone server and keeps the queue library out of the bundle (ADR-0486)', () => {
    expect(source).toMatch(/output:\s*'standalone'/);
    // The library reads its SQL command files from disk; a bundle loses them and every enqueue
    // from the web process then fails with 503.
    expect(source).toMatch(/serverExternalPackages:\s*\[[^\]]*'bullmq'/);
  });
});
