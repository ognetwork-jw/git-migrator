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
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type InstallOrigin = 'host' | 'container';

export const MARKER = '.gm-install-origin';

const ORIGINS: readonly string[] = ['host', 'container'];

/** Command that clears this checkout's node_modules and skips other worktrees under .worktrees. */
export const CLEAR_COMMAND =
  'find . -path ./.worktrees -prune -o -name node_modules -prune -exec rm -rf {} +';

/** File-system calls the tests replace to simulate file systems without hard links. */
export interface ClaimIo {
  readonly link?: (existingPath: string, newPath: string) => void;
}

/**
 * Entries a fresh install may find before this script runs: pnpm creates `node_modules/.tmp`
 * before the root `preinstall`, and a concurrent claim leaves its temp file for a moment.
 */
function isScratch(name: string): boolean {
  return (
    name === '.tmp' || name === MARKER || (name.startsWith(`${MARKER}.`) && name.endsWith('.tmp'))
  );
}

/**
 * Records `origin` on first install and refuses when the other origin already owns the tree.
 *
 * The marker is created atomically with its content: write a private temp file, then hard-link it
 * to the marker name. `link` fails with EEXIST when a marker exists, and no reader ever sees an
 * empty marker. Where hard links are not supported (some bind mounts and network file systems)
 * the marker is created exclusively (`wx`) and written instead. On EEXIST the recorded origin is
 * read back. An empty or unrecognised marker is corrupt and refuses with its own message. A
 * populated node_modules without a marker (installed before the guard existed, or with
 * `--ignore-scripts`) may come from either origin, so it is refused rather than claimed.
 */
export function claimInstallOrigin(root: string, origin: InstallOrigin, io: ClaimIo = {}): void {
  const dir = join(root, 'node_modules');
  const marker = join(dir, MARKER);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(marker) && readdirSync(dir).some((name) => !isScratch(name))) {
    throw new Error(
      'node_modules has no install-origin marker, so either path may have installed it; run ' +
        `\`${CLEAR_COMMAND}\` and install again`,
    );
  }
  const temp = join(dir, `${MARKER}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let created: boolean;
  try {
    writeFileSync(temp, `${origin}\n`, { flag: 'wx' });
    created = createMarker(temp, marker, origin, io.link ?? linkSync);
  } finally {
    rmSync(temp, { force: true });
  }
  if (created) return;
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

/** Creates the marker; false when one already exists. */
function createMarker(
  temp: string,
  marker: string,
  origin: InstallOrigin,
  link: (existingPath: string, newPath: string) => void,
): boolean {
  try {
    link(temp, marker);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
  }
  let fd: number;
  try {
    fd = openSync(marker, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeSync(fd, `${origin}\n`);
  } catch (error) {
    // This process created the marker, so a half-written one is removed, not left as corrupt.
    closeSync(fd);
    rmSync(marker, { force: true });
    throw error;
  }
  closeSync(fd);
  return true;
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
