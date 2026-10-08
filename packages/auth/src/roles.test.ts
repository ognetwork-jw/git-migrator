import { describe, expect, it } from 'vitest';
import { methodHasMappings, outranks, type RoleMapping, resolveRole } from './roles.ts';

const MAPPINGS: readonly RoleMapping[] = [
  { method: 'entra', claim: 'roles', value: 'GitMigrator.Admin', role: 'admin' },
  { method: 'entra', claim: 'roles', value: 'GitMigrator.Operator', role: 'operator' },
  { method: 'entra', claim: 'roles', value: 'GitMigrator.Viewer', role: 'viewer' },
  { method: 'other', claim: 'groups', value: 'ops', role: 'admin' },
];

describe('role mapping (AUTH-010)', () => {
  it('[AUTH-010] maps a matching claim value to its role', () => {
    expect(resolveRole(MAPPINGS, 'entra', { roles: ['GitMigrator.Operator'] })).toBe('operator');
    expect(resolveRole(MAPPINGS, 'entra', { roles: ['GitMigrator.Viewer'] })).toBe('viewer');
  });

  it('[AUTH-010] the highest role wins when several mappings match', () => {
    const claims = { roles: ['GitMigrator.Viewer', 'GitMigrator.Admin', 'GitMigrator.Operator'] };
    expect(resolveRole(MAPPINGS, 'entra', claims)).toBe('admin');
    expect(
      resolveRole(MAPPINGS, 'entra', {
        roles: ['GitMigrator.Viewer', 'x', 'GitMigrator.Operator'],
      }),
    ).toBe('operator');
    expect(outranks('admin', 'operator')).toBe(true);
    expect(outranks('operator', 'viewer')).toBe(true);
    expect(outranks('viewer', 'viewer')).toBe(false);
  });

  it('[AUTH-010] no match gives no role, which means the sign-in is denied', () => {
    expect(resolveRole(MAPPINGS, 'entra', { roles: ['Something.Else'] })).toBeUndefined();
    expect(resolveRole(MAPPINGS, 'entra', {})).toBeUndefined();
    expect(resolveRole(MAPPINGS, 'entra', { roles: 42 })).toBeUndefined();
    expect(resolveRole([], 'entra', { roles: ['GitMigrator.Admin'] })).toBeUndefined();
  });

  it("[AUTH-010] values match exactly, including case, and only for the mapping name's method", () => {
    expect(resolveRole(MAPPINGS, 'entra', { roles: ['gitmigrator.admin'] })).toBeUndefined();
    expect(
      resolveRole(MAPPINGS, 'entra', { roles: ['GitMigrator.Administrator'] }),
    ).toBeUndefined();
    expect(resolveRole(MAPPINGS, 'entra', { groups: ['ops'] })).toBeUndefined();
    expect(resolveRole(MAPPINGS, 'other', { groups: ['ops'] })).toBe('admin');
  });

  it('[AUTH-010] a claim can be a single string, and other claims can be mapped', () => {
    expect(resolveRole(MAPPINGS, 'entra', { roles: 'GitMigrator.Admin' })).toBe('admin');
    expect(resolveRole(MAPPINGS, 'other', { groups: 'ops' })).toBe('admin');
  });

  it("[AUTH-010] reports which methods own their Actors' roles", () => {
    expect(methodHasMappings(MAPPINGS, 'entra')).toBe(true);
    expect(methodHasMappings(MAPPINGS, 'test')).toBe(false);
    expect(methodHasMappings([], 'entra')).toBe(false);
  });
});
