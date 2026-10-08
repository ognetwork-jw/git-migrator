import type { Role } from './roles.ts';
import { outranks } from './roles.ts';

/**
 * The AUTH-020 capability table as names. Custom `/api/v1` handlers check these through `can`
 * (AUTH-021); ZenStack policies in the ZModel express the same rules for RPC.
 */
export const CAPABILITY_MIN_ROLE = {
  /** Read everything except API key hashes and raw response bodies; the audit log. */
  read: 'viewer',
  readAuditLog: 'viewer',
  readRawResponses: 'operator',
  /** Analyze, run, resync, verify, rollback, source read-only, cancel runs. */
  operate: 'operator',
  markComplete: 'operator',
  manageTasks: 'operator',
  manageWaves: 'operator',
  decideMappings: 'operator',
  manageInvitations: 'operator',
  /** Naming rules, webhook allowlist, overlays. */
  manageRules: 'admin',
  /** Actors, service Actors, API keys. */
  manageActors: 'admin',
} as const satisfies Record<string, Role>;

export type Capability = keyof typeof CAPABILITY_MIN_ROLE;

/** The slice of an Actor that authorization needs. */
export interface Authorizable {
  readonly role: Role;
  readonly disabled: boolean;
}

/** True when an enabled `actor` holds `capability` (AUTH-020, AUTH-021). */
export function can(actor: Authorizable | undefined, capability: Capability): boolean {
  if (!actor || actor.disabled) return false;
  const needed = CAPABILITY_MIN_ROLE[capability];
  return actor.role === needed || outranks(actor.role, needed);
}
