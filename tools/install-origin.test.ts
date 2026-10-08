import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claimInstallOrigin, MARKER } from './install-origin.ts';

/** A fresh checkout root with an empty node_modules, removed by the caller. */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gm-origin-'));
  mkdirSync(join(root, 'node_modules'));
  return root;
}

describe('install origin guard', () => {
  it('[DEV-020] records the first origin and accepts repeat installs from it', () => {
    const root = tempRoot();
    try {
      claimInstallOrigin(root, 'container');
      expect(readFileSync(join(root, 'node_modules', MARKER), 'utf8').trim()).toBe('container');
      expect(() => claimInstallOrigin(root, 'container')).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('[DEV-020] refuses an install from the other origin with the fix in the message', () => {
    const root = tempRoot();
    try {
      claimInstallOrigin(root, 'host');
      expect(() => claimInstallOrigin(root, 'container')).toThrow(
        /installed by the host path; run `find \. -path \.\/\.worktrees -prune -o -name node_modules -prune -exec rm -rf \{\} \+`/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('[DEV-020] a second claim from the same origin finds the marker (EEXIST) and keeps it', () => {
    const root = tempRoot();
    try {
      claimInstallOrigin(root, 'host');
      expect(() => claimInstallOrigin(root, 'host')).not.toThrow();
      expect(readFileSync(join(root, 'node_modules', MARKER), 'utf8').trim()).toBe('host');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('[DEV-020] a claim from the other origin does not overwrite an existing marker', () => {
    const root = tempRoot();
    try {
      claimInstallOrigin(root, 'container');
      expect(() => claimInstallOrigin(root, 'host')).toThrow(/installed by the container path/);
      expect(readFileSync(join(root, 'node_modules', MARKER), 'utf8').trim()).toBe('container');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('[DEV-020] an empty marker is corrupt and refuses with its own message', () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'node_modules', MARKER), '');
      expect(() => claimInstallOrigin(root, 'host')).toThrow(
        /marker is corrupt; remove node_modules\/\.gm-install-origin and reinstall/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('[DEV-020] an unrecognised marker is corrupt, not a foreign origin', () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'node_modules', MARKER), 'partial-wri');
      expect(() => claimInstallOrigin(root, 'container')).toThrow(/marker is corrupt/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('[DEV-020] the temp file used for the atomic create is always removed', () => {
    const root = tempRoot();
    try {
      claimInstallOrigin(root, 'host');
      claimInstallOrigin(root, 'host');
      expect(readdirSync(join(root, 'node_modules')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
