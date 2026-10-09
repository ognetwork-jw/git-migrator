import { describe, expect, it } from 'vitest';
import type { ShellActor } from '../shell/navigation.ts';
import { canOpen, capabilityForPath, deniedHref, itemForPath } from '../shell/navigation.ts';

const actor = (role: ShellActor['role']): ShellActor => ({
  displayName: 'Test',
  role,
  disabled: false,
});

describe('configuration and admin pages (UI-030 to UI-035)', () => {
  it('[UI-030] [UI-031] [UI-032] the rule pages need the rules capability, so only an admin opens them', () => {
    for (const path of ['/config/naming', '/config/webhook-allowlist', '/config/overlays']) {
      expect(capabilityForPath(path)).toBe('manageRules');
      expect(canOpen(actor('operator'), path)).toBe(false);
      expect(canOpen(actor('admin'), path)).toBe(true);
      expect(deniedHref(path)).toBe('/denied?required=admin');
    }
  });

  it('[UI-033] the capability matrix needs read, so every role opens it', () => {
    expect(itemForPath('/config/capabilities')?.id).toBe('capabilities');
    expect(canOpen(actor('viewer'), '/config/capabilities')).toBe(true);
  });

  it('[UI-034] the Actors page needs the Actor capability (admin)', () => {
    expect(capabilityForPath('/admin/actors')).toBe('manageActors');
    expect(canOpen(actor('operator'), '/admin/actors')).toBe(false);
    expect(canOpen(actor('admin'), '/admin/actors')).toBe(true);
  });

  it('[UI-035] the audit log is for every role', () => {
    expect(capabilityForPath('/admin/audit')).toBe('readAuditLog');
    expect(canOpen(actor('viewer'), '/admin/audit')).toBe(true);
  });
});
