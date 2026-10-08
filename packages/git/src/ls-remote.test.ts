import { describe, expect, it } from 'vitest';
import { parseLsRemote } from './ls-remote.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(64);

describe('parseLsRemote', () => {
  it('[FAC-GIT-001] reads the HEAD symref and plain refs, sorted by name', () => {
    const out = `ref: refs/heads/trunk\tHEAD\n${A}\tHEAD\n${B}\trefs/heads/zeta\n${A}\trefs/heads/trunk\n`;
    expect(parseLsRemote(out)).toEqual({
      headSymref: 'refs/heads/trunk',
      refs: [
        { name: 'refs/heads/trunk', sha: A },
        { name: 'refs/heads/zeta', sha: B },
      ],
    });
  });

  it('[FAC-GIT-001] an annotated tag keeps the tag object as sha and the commit as peeled', () => {
    const out = `${A}\trefs/heads/main\n${B}\trefs/tags/v1\n${A}\trefs/tags/v1^{}\n${C}\trefs/tags/light\n`;
    expect(parseLsRemote(out).refs).toEqual([
      { name: 'refs/heads/main', sha: A },
      { name: 'refs/tags/light', sha: C },
      { name: 'refs/tags/v1', sha: B, peeled: A },
    ]);
  });

  it('[FAC-GIT-001] accepts sha-256 object ids, ignores noise and an empty repository has no refs', () => {
    expect(parseLsRemote(`${D}\trefs/heads/main\r\n`).refs).toEqual([
      { name: 'refs/heads/main', sha: D },
    ]);
    expect(parseLsRemote('')).toEqual({ refs: [] });
    expect(
      parseLsRemote(`garbage\nnot-a-sha\trefs/heads/x\n${A}\tnot-a-ref\n${A} refs/heads/y\n`),
    ).toEqual({ refs: [] });
  });

  it('[FAC-GIT-001] a peeled line without its tag object is ignored', () => {
    expect(parseLsRemote(`${A}\trefs/tags/orphan^{}\n`).refs).toEqual([]);
  });

  it('[FAC-GIT-001] no symref when the output has none', () => {
    expect(parseLsRemote(`${A}\trefs/heads/main\n`)).not.toHaveProperty('headSymref');
  });
});
