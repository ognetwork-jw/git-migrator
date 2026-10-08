/**
 * Keeps one checkout's node_modules from being installed by two origins (DEV-020, ADR-0068).
 *
 * The host path and the dev container both install into the same bind-mounted checkout when run
 * from the same clone. Host and container binaries differ, so mixing them breaks. Each install
 * records its origin in `node_modules/.gm-install-origin`. A later install from the other origin
 * refuses with the fix. Origin is `container` when GM_INSTALL_ORIGIN is `container` (set in the
 * dev image), otherwise `host`. Runs as the root `preinstall` script.
 */
import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type InstallOrigin = 'host' | 'container';

export const MARKER = '.gm-install-origin';

const ORIGINS: readonly string[] = ['host', 'container'];

/** Command that clears this checkout's node_modules and skips other worktrees under .worktrees. */
export const CLEAR_COMMAND =
  'find . -path ./.worktrees -prune -o -name node_modules -prune -exec rm -rf {} +';

/**
 * Records `origin` on first install and refuses when the other origin already owns the tree.
 *
 * The marker is created atomically with its content: write a private temp file, then hard-link it
 * to the marker name. `link` fails with EEXIST when a marker exists, and no reader ever sees an
 * empty marker. On EEXIST the recorded origin is read back. An empty or unrecognised marker is
 * corrupt and refuses with its own message.
 */
export function claimInstallOrigin(root: string, origin: InstallOrigin): void {
  const dir = join(root, 'node_modules');
  const marker = join(dir, MARKER);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `${MARKER}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temp, `${origin}\n`, { flag: 'wx' });
  try {
    linkSync(temp, marker);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    rmSync(temp, { force: true });
  }
  const recorded = readFileSync(marker, 'utf8').trim();
  if (!ORIGINS.includes(recorded)) {
    throw new Error(
      `the install-origin marker is corrupt; remove node_modules/${MARKER} and reinstall`,
    );
  }
  if (recorded !== origin) {
    throw new Error(
      `this checkout's node_modules were installed by the ${recorded} path; run ` +
        `\`${CLEAR_COMMAND}\` or use a separate clone`,
    );
  }
}

if (import.meta.main) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const origin: InstallOrigin =
    process.env.GM_INSTALL_ORIGIN === 'container' ? 'container' : 'host';
  try {
    claimInstallOrigin(root, origin);
  } catch (error) {
    console.error(`install refused: ${(error as Error).message}`);
    process.exit(1);
  }
}
