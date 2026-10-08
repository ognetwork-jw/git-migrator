import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUTH_ERROR_CODES } from './auth.ts';

const file = join(dirname(fileURLToPath(import.meta.url)), '../../../apps/web/messages/en.json');
const messages = JSON.parse(readFileSync(file, 'utf8')) as {
  auth: { error: Record<string, string> };
};

describe('sign-in denial messages (AUTH-010)', () => {
  it('[AUTH-010] every error code a denied sign-in can redirect with has an explanation in en.json', () => {
    for (const code of Object.values(AUTH_ERROR_CODES)) {
      expect(messages.auth.error[code], code).toMatch(/\S/);
    }
    expect(messages.auth.error.unknown).toMatch(/\S/);
  });

  it('[AUTH-010] the role-assignment denial tells the user an app role assignment is required', () => {
    expect(messages.auth.error[AUTH_ERROR_CODES.roleAssignmentRequired]).toMatch(/app role/i);
  });
});
