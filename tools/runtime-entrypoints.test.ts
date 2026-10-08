import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * The image runs TypeScript with Node's strip-only type stripping (ADR-0290, ADR-0294). Vitest
 * transforms TypeScript, so syntax that only a transform can handle (parameter properties, enums,
 * namespaces) passes every other test. This imports each runtime entry point's whole module graph
 * in plain Node, as the container does, without starting anything (`main()` is guarded by
 * `import.meta.main`; `migrate.ts` runs on import, so its module `db-commands.ts` is imported).
 */
const ENTRY_POINTS = [
  'apps/web/src/web.ts',
  'apps/worker/src/worker.ts',
  'apps/worker/src/db-commands.ts',
];

describe('runtime entry points load under strip-only Node (DEP-002)', () => {
  it.each(ENTRY_POINTS)(
    '[DEP-002] %s and everything it imports is erasable TypeScript',
    (entry) => {
      const url = pathToFileURL(`${root}${entry}`).href;
      const result = spawnSync(
        process.execPath,
        [
          '--no-experimental-transform-types',
          '--input-type=module',
          '-e',
          `await import(${JSON.stringify(url)});`,
        ],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 90_000,
          env: { ...process.env, NODE_ENV: 'production' },
        },
      );
      expect(result.stderr).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|strip-only/);
      expect(result.status, result.stderr).toBe(0);
    },
    120_000,
  );
});
