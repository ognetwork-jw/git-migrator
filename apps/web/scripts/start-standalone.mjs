/**
 * Starts the Next.js standalone server that `next build` writes (`output: 'standalone'`).
 *
 * `next start` refuses to run a standalone build, and the standalone folder does not contain the
 * static assets. This script copies them in (what the Next.js docs describe), maps HOST and PORT
 * onto the HOSTNAME and PORT the server reads, and runs `server.js`. The runtime image (T-090)
 * does the same copy at build time and runs `server.js` directly, so this file is for local runs
 * and the visual regression suite.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const appDir = join(import.meta.dirname, '..');
const standaloneDir = join(appDir, '.next', 'standalone', 'apps', 'web');
const server = join(standaloneDir, 'server.js');

if (!existsSync(server)) {
  console.error('No standalone build found. Run `pnpm --filter @git-migrator/web build` first.');
  process.exit(1);
}

cpSync(join(appDir, '.next', 'static'), join(standaloneDir, '.next', 'static'), {
  recursive: true,
});
if (existsSync(join(appDir, 'public'))) {
  cpSync(join(appDir, 'public'), join(standaloneDir, 'public'), { recursive: true });
}

const child = spawn(process.execPath, [server], {
  stdio: 'inherit',
  cwd: standaloneDir,
  env: {
    ...process.env,
    HOSTNAME: process.env.HOST ?? '127.0.0.1',
    PORT: process.env.PORT ?? '3000',
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
