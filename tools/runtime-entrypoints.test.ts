import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
/** `CONFIG_EXIT_CODE` of packages/config (tools/ cannot import outside its rootDir). */
const CONFIG_EXIT_CODE = 78;

interface EntryPoint {
  readonly entry: string;
  /** Extra environment for the child. */
  readonly env?: Readonly<Record<string, string>>;
  /** The exit status that proves the module graph loaded and evaluation started. */
  readonly status: number;
  /** What the entry point writes on stderr once it runs. */
  readonly stderr?: RegExp;
}

/**
 * The image runs TypeScript with Node's strip-only type stripping (ADR-0290, ADR-0294). Vitest
 * transforms TypeScript, so syntax that only a transform can handle (parameter properties, enums,
 * namespaces) passes every other test. This imports each runtime entry point's whole module graph
 * in plain Node, as the container does. ES modules link every static import before any of them
 * runs, so an unsupported syntax error surfaces before the entry point does anything.
 *
 * `web.ts` and `worker.ts` guard `main()` with `import.meta.main`, so importing them starts
 * nothing. `migrate.ts` (the image's `migrate` command) and `db-cli.ts` (`pnpm db:*`) run on
 * import; they are pointed at a missing configuration file or given no command, so each stops at
 * its first check, before any database connection, with a known status.
 *
 * Not covered here: the `/app/dist/<command>.js` shims are plain JavaScript written by the
 * Dockerfile that import these same entry points (tools/deployment.test.ts checks their targets),
 * and modules loaded only by a dynamic `import()` (such as the Next.js standalone build web.ts
 * loads at start-up) are not part of the static graph.
 */
const ENTRY_POINTS: readonly EntryPoint[] = [
  { entry: 'apps/web/src/web.ts', status: 0 },
  { entry: 'apps/worker/src/worker.ts', status: 0 },
  {
    entry: 'apps/worker/src/migrate.ts',
    env: { GM_CONFIG_FILE: join(root, 'does-not-exist', 'gm-config.yaml') },
    status: CONFIG_EXIT_CODE,
    stderr: /GM_CONFIG_FILE/,
  },
  { entry: 'apps/worker/src/db-cli.ts', status: 64, stderr: /usage: db-cli/ },
];

describe('runtime entry points load under strip-only Node (DEP-002)', () => {
  it.each(ENTRY_POINTS.map((e) => [e.entry, e] as const))(
    '[DEP-002] %s and everything it imports is erasable TypeScript',
    (_name, { entry, env = {}, status, stderr }) => {
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
          env: { ...process.env, NODE_ENV: 'production', ...env },
        },
      );
      expect(result.stderr).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|strip-only/);
      expect(result.status, result.stderr).toBe(status);
      if (stderr) expect(result.stderr).toMatch(stderr);
    },
    120_000,
  );
});
