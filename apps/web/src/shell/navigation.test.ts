import { describe, expect, it } from 'vitest';
import messages from '../../messages/en.json' with { type: 'json' };
import {
  canOpen,
  capabilityForPath,
  deniedHref,
  itemForPath,
  NAV_SECTIONS,
  parseRequiredRole,
  type ShellActor,
  type ShellRole,
  visibleSections,
} from './navigation.ts';

const actorWith = (role: ShellRole, disabled = false): ShellActor => ({
  displayName: 'Test',
  role,
  disabled,
});

const hrefsFor = (actor: ShellActor | undefined) =>
  visibleSections(actor).flatMap((section) => section.items.map((item) => item.href));

describe('shell navigation', () => {
  it('[UI-010] lists the sidebar sections of the spec in order', () => {
    expect(NAV_SECTIONS.map((s) => s.id)).toEqual([
      'migration',
      'people',
      'configuration',
      'admin',
    ]);
    expect(NAV_SECTIONS.map((s) => s.items.map((i) => i.id))).toEqual([
      ['dashboard', 'repositories', 'waves', 'endpoints'],
      ['identities', 'teams', 'invitations'],
      ['naming', 'webhookAllowlist', 'overlays', 'capabilities'],
      ['actors', 'audit'],
    ]);
  });

  it('[UI-010] has a message for every section and item', () => {
    for (const section of NAV_SECTIONS) {
      expect(messages.nav.section).toHaveProperty(section.id);
      for (const item of section.items) expect(messages.nav.item).toHaveProperty(item.id);
    }
  });

  it('[UI-010] a viewer sees only what read access can use', () => {
    expect(hrefsFor(actorWith('viewer'))).toEqual([
      '/',
      '/repositories',
      '/waves',
      '/endpoints',
      '/config/capabilities',
      '/admin/audit',
    ]);
  });

  it('[UI-010] an operator also sees the People section but no administration', () => {
    const hrefs = hrefsFor(actorWith('operator'));
    expect(hrefs).toContain('/people/identities');
    expect(hrefs).toContain('/people/teams');
    expect(hrefs).toContain('/people/invitations');
    expect(hrefs).not.toContain('/config/naming');
    expect(hrefs).not.toContain('/admin/actors');
    expect(hrefs).toContain('/admin/audit');
  });

  it('[UI-010] an admin sees every item', () => {
    const all = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefsFor(actorWith('admin'))).toEqual(all);
  });

  it('[UI-010] empty sections are dropped, and nothing shows without an enabled Actor', () => {
    expect(visibleSections(undefined)).toEqual([]);
    expect(visibleSections(actorWith('admin', true))).toEqual([]);
    expect(visibleSections(actorWith('viewer')).map((s) => s.id)).toEqual([
      'migration',
      'configuration',
      'admin',
    ]);
  });

  it('[UI-010] matches a page to the longest nav href above it', () => {
    expect(itemForPath('/')?.id).toBe('dashboard');
    expect(itemForPath('/waves/w1')?.id).toBe('waves');
    expect(itemForPath('/people/invitations/b1')?.id).toBe('invitations');
    expect(itemForPath('/repositories/m1')?.id).toBe('repositories');
    expect(itemForPath('/wavesy')).toBeUndefined();
    expect(itemForPath('/runs/r1')).toBeUndefined();
  });

  it('[UI-010] pages outside the sidebar need read access only', () => {
    expect(capabilityForPath('/runs/r1')).toBe('read');
    expect(capabilityForPath('/admin/actors')).toBe('manageActors');
    expect(capabilityForPath('/config/naming')).toBe('manageRules');
    expect(canOpen(actorWith('viewer'), '/runs/r1')).toBe(true);
    expect(canOpen(actorWith('viewer'), '/admin/actors')).toBe(false);
    expect(canOpen(actorWith('operator'), '/people/identities')).toBe(true);
    expect(canOpen(actorWith('admin'), '/admin/actors')).toBe(true);
  });

  it('[UI-036] /denied names the role the page needs', () => {
    expect(deniedHref('/admin/actors')).toBe('/denied?required=admin');
    expect(deniedHref('/people/teams')).toBe('/denied?required=operator');
    expect(parseRequiredRole('admin')).toBe('admin');
    expect(parseRequiredRole('root')).toBeUndefined();
    expect(parseRequiredRole(null)).toBeUndefined();
  });
});
