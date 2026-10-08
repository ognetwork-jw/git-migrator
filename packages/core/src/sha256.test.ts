import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Bytes, sha256Hex } from './sha256.ts';

const ref = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

describe('[DOM-001] sha256 (content hash primitive)', () => {
  it('[DOM-001] matches the FIPS 180-4 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('[DOM-001] agrees with node:crypto for every length across padding boundaries', () => {
    for (let len = 0; len <= 200; len++) {
      const bytes = new Uint8Array(randomBytes(len));
      expect(sha256Hex(bytes)).toBe(ref(bytes));
    }
  });

  it('[DOM-001] encodes strings as UTF-8', () => {
    for (const s of ['é', 'é', '€', '😀', '日本語', 'a\u0000b']) {
      expect(sha256Hex(s)).toBe(ref(s));
    }
    expect(sha256Hex('é')).not.toBe(sha256Hex('é')); // no Unicode normalization
  });

  it('[DOM-001] returns 32 bytes and accepts raw bytes', () => {
    expect(sha256Bytes(new Uint8Array(0))).toHaveLength(32);
    expect(sha256Hex(new Uint8Array([97, 98, 99]))).toBe(sha256Hex('abc'));
  });
});
