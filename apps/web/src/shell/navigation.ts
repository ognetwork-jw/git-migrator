import { CAPABILITY_MIN_ROLE, type Capability, can } from '@git-migrator/auth/capabilities';

/** The in-app roles, lowest first (AUTH-010). */
export const ROLES = ['viewer', 'operator', 'admin'] as const;
export type ShellRole = (typeof ROLES)[number];

/** The slice of the Actor (`GET /api/v1/me`) the shell needs. */
export interface ShellActor {
  readonly displayName: string;
  readonly role: ShellRole;
  readonly disabled: boolean;
}

export interface NavItem {
  /** The key under `nav.item.` in `messages/en.json`; also the icon key. */
  readonly id: string;
  readonly href: string;
  /** What the item's page is for. The Actor must hold it (AUTH-020) or the item is hidden. */
  readonly capability: Capability;
}

export interface NavSection {
  /** The key under `nav.section.` in `messages/en.json`. */
  readonly id: string;
  readonly items: readonly NavItem[];
}

/** The sidebar of UI-010. Which role sees which item is decided in ADR-0300. */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: 'migration',
    items: [
      { id: 'dashboard', href: '/', capability: 'read' },
      { id: 'repositories', href: '/repositories', capability: 'read' },
      { id: 'waves', href: '/waves', capability: 'read' },
      { id: 'endpoints', href: '/endpoints', capability: 'read' },
    ],
  },
  {
    id: 'people',
    items: [
      { id: 'identities', href: '/people/identities', capability: 'decideMappings' },
      { id: 'teams', href: '/people/teams', capability: 'decideMappings' },
      { id: 'invitations', href: '/people/invitations', capability: 'manageInvitations' },
    ],
  },
  {
    id: 'configuration',
    items: [
      { id: 'naming', href: '/config/naming', capability: 'manageRules' },
      { id: 'webhookAllowlist', href: '/config/webhook-allowlist', capability: 'manageRules' },
      { id: 'overlays', href: '/config/overlays', capability: 'manageRules' },
      { id: 'capabilities', href: '/config/capabilities', capability: 'read' },
    ],
  },
  {
    id: 'admin',
    items: [
      { id: 'actors', href: '/admin/actors', capability: 'manageActors' },
      { id: 'audit', href: '/admin/audit', capability: 'readAuditLog' },
    ],
  },
];

const ALL_ITEMS: readonly NavItem[] = NAV_SECTIONS.flatMap((section) => section.items);

/** The sections an Actor sees: items its role cannot use are hidden, empty sections too (UI-010). */
export function visibleSections(actor: ShellActor | undefined): readonly NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => can(actor, item.capability)),
  })).filter((section) => section.items.length > 0);
}

/** True when `pathname` is `href` or below it (`/waves/w1` belongs to `/waves`). */
const isUnder = (pathname: string, href: string): boolean =>
  href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);

/** The nav item whose page `pathname` is, so the menu can highlight it. */
export function itemForPath(pathname: string): NavItem | undefined {
  let best: NavItem | undefined;
  for (const item of ALL_ITEMS) {
    if (!isUnder(pathname, item.href)) continue;
    if (best === undefined || item.href.length > best.href.length) best = item;
  }
  return best;
}

/**
 * The capability a page needs. The server enforces it too (AUTH-021); this only decides whether the
 * page is worth showing. Pages that are not in the sidebar (details, Runs) need `read`.
 */
export function capabilityForPath(pathname: string): Capability {
  return itemForPath(pathname)?.capability ?? 'read';
}

/** True when the Actor may open `pathname`. */
export function canOpen(actor: ShellActor | undefined, pathname: string): boolean {
  return can(actor, capabilityForPath(pathname));
}

/** The lowest role that holds `capability` (for the `/denied` explanation). */
export function minRoleFor(capability: Capability): ShellRole {
  return CAPABILITY_MIN_ROLE[capability];
}

/** `/denied` carries the role a page needs as `?required=`; anything else is ignored. */
export function parseRequiredRole(value: string | null | undefined): ShellRole | undefined {
  return ROLES.find((role) => role === value);
}

/** The `/denied` address for an Actor that opened `pathname` without the role for it. */
export function deniedHref(pathname: string): string {
  return `/denied?required=${minRoleFor(capabilityForPath(pathname))}`;
}
