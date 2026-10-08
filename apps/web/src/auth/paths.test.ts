import { AUTH_ERROR_CODES } from '@git-migrator/auth';
import { describe, expect, it } from 'vitest';
import messages from '../../messages/en.json' with { type: 'json' };
import { resolveAuthErrorCode, safeNextPath, signInHref } from './paths.ts';

const KNOWN = Object.keys(messages.auth.error);

describe('sign-in paths', () => {
  it('[UI-036] keeps a path on this site as the address to return to', () => {
    expect(safeNextPath('/repositories?status=ready')).toBe('/repositories?status=ready');
    expect(safeNextPath('/waves/w1')).toBe('/waves/w1');
  });

  it('[UI-036] falls back to the dashboard for anything that could leave the site', () => {
    for (const bad of [
      undefined,
      null,
      '',
      'https://evil.example/',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      '/ok\nSet-Cookie: x',
      'repositories',
    ]) {
      expect(safeNextPath(bad)).toBe('/');
    }
  });

  it('[UI-036] never returns to the sign-in flow itself', () => {
    for (const loop of [
      '/signin',
      '/signin?next=%2F',
      '/denied?required=admin',
      '/auth/error',
      '/api/v1/me',
    ]) {
      expect(safeNextPath(loop)).toBe('/');
    }
    expect(safeNextPath('/signing-off')).toBe('/signing-off');
    expect(safeNextPath('/apiary')).toBe('/apiary');
  });

  it('[UI-036] builds the sign-in address that returns to the page afterwards', () => {
    expect(signInHref('/repositories', '?status=ready')).toBe(
      '/signin?next=%2Frepositories%3Fstatus%3Dready',
    );
    expect(signInHref('/')).toBe('/signin');
    expect(signInHref('/denied')).toBe('/signin');
  });

  it('[UI-036] shows the text of a known auth error code and falls back for the rest', () => {
    expect(resolveAuthErrorCode('role_assignment_required', KNOWN)).toBe(
      'role_assignment_required',
    );
    expect(resolveAuthErrorCode('nope', KNOWN)).toBe('unknown');
    expect(resolveAuthErrorCode('title', KNOWN)).toBe('unknown');
    expect(resolveAuthErrorCode('a.b', KNOWN)).toBe('unknown');
    expect(resolveAuthErrorCode(undefined, KNOWN)).toBe('unknown');
  });

  it('[UI-036] has a text for every code the server redirects with', () => {
    for (const code of Object.values(AUTH_ERROR_CODES)) {
      expect(messages.auth.error).toHaveProperty(code);
    }
    expect(messages.auth.error).toHaveProperty('unknown');
  });
});
