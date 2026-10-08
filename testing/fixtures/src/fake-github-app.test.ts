import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('fake GitHub App key fixture', () => {
  it('[DEV-030] is a throwaway 2048-bit RSA private key', () => {
    const pem = readFileSync(join(fixtureDir, 'fake-github-app.pem'), 'utf8');
    const key = createPrivateKey(pem);
    expect(key.asymmetricKeyType).toBe('rsa');
    expect(key.asymmetricKeyDetails?.modulusLength).toBe(2048);
  });
});
