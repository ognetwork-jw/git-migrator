import { resolve } from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const config: NextConfig = {
  // A self-contained server (`.next/standalone/apps/web/server.js`) for the single image (DEP-001).
  output: 'standalone',
  // The workspace root, so the standalone trace includes the sibling packages.
  outputFileTracingRoot: resolve(import.meta.dirname, '../..'),
  // Workspace packages ship TypeScript sources (ARC-011).
  transpilePackages: [
    '@git-migrator/api',
    '@git-migrator/auth',
    '@git-migrator/canonical',
    '@git-migrator/config',
    '@git-migrator/core',
    '@git-migrator/db',
    '@git-migrator/guidance',
    '@git-migrator/observability',
  ],
  // bullmq reads its SQL command files from disk next to its own modules; a bundle loses them.
  serverExternalPackages: ['bullmq'],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default withNextIntl(config);
