import type { Actor, Db } from '@git-migrator/db';
import type { Role } from './roles.ts';

export interface EntraActorInput {
  /** `auth.user.id` of the Better Auth user (AUTH-005). */
  readonly authUserId: string;
  readonly displayName: string;
  /** The real address from the claims; `null` when the token carries none (ADR-0171). */
  readonly email: string | null;
  /** The role the mapping resolved (AUTH-010). */
  readonly role: Role;
}

export type ProvisionResult =
  | { readonly status: 'ok'; readonly actor: Actor; readonly created: boolean }
  | { readonly status: 'disabled'; readonly actor: Actor };

/** Audit actions written by the sign-in sync (AUTH-022; `actorId` null means the system). */
export const AUDIT_ACTOR_CREATED = 'actor.created_by_sign_in';
export const AUDIT_ACTOR_ROLE_CHANGED = 'actor.role_changed_by_sign_in';

/**
 * AUTH-005 for a method that has role mappings: creates the `human` Actor on the first sign-in and
 * updates `displayName`, `email` and `role` on every later one (the provider is the source of
 * truth, AUTH-010). A disabled Actor is returned unchanged with status `disabled`. Linking is by
 * `authUserId` only: an Actor that was merely seeded with the same email is never taken over by a
 * provider identity (ADR-0171). Creation and role changes write an AuditEvent with a null
 * `actorId` (the system) in the same transaction as the Actor write. Uses the privileged client.
 * `Actor.email` is not unique, so a recycled address never blocks the sync (ADR-0171).
 */
export async function provisionMappedActor(
  db: Db,
  input: EntraActorInput,
): Promise<ProvisionResult> {
  try {
    return await provisionOnce(db, input);
  } catch (error) {
    // Two first sign-ins of the same user can race on the unique `authUserId`; the loser retries
    // once and then finds the winner's row.
    const raced = await db.actor.findUnique({ where: { authUserId: input.authUserId } });
    if (!raced) throw error;
    return provisionOnce(db, input);
  }
}

function provisionOnce(db: Db, input: EntraActorInput): Promise<ProvisionResult> {
  return db.$transaction(async (tx) => {
    const existing = await tx.actor.findUnique({ where: { authUserId: input.authUserId } });
    if (!existing) {
      const actor = await tx.actor.create({
        data: {
          kind: 'human',
          authUserId: input.authUserId,
          displayName: input.displayName,
          email: input.email,
          role: input.role,
          lastSeenAt: new Date(),
        },
      });
      await tx.auditEvent.create({
        data: {
          action: AUDIT_ACTOR_CREATED,
          subjectType: 'actor',
          subjectId: actor.id,
          data: { role: input.role },
        },
      });
      return { status: 'ok', actor, created: true } as const;
    }
    if (existing.disabled) return { status: 'disabled', actor: existing } as const;
    const actor = await tx.actor.update({
      where: { id: existing.id },
      data: {
        displayName: input.displayName,
        email: input.email,
        role: input.role,
        lastSeenAt: new Date(),
      },
    });
    if (existing.role !== input.role) {
      await tx.auditEvent.create({
        data: {
          action: AUDIT_ACTOR_ROLE_CHANGED,
          subjectType: 'actor',
          subjectId: actor.id,
          data: { oldRole: existing.role, newRole: input.role },
        },
      });
    }
    return { status: 'ok', actor, created: false } as const;
  });
}

/**
 * AUTH-012: the Actor behind a test sign-in. Looked up by `authUserId`; the first sign-in links the
 * seeded Actor with the same email that has no `authUserId` yet (ADR-0121 item 9). The role is
 * never touched: test sign-in is exempt from mapping and keeps the seeded role. Returns
 * `undefined` when no Actor exists (the sign-in is then denied).
 */
export async function linkTestActor(
  db: Db,
  input: { authUserId: string; email: string },
): Promise<ProvisionResult | undefined> {
  const linked = await db.actor.findUnique({ where: { authUserId: input.authUserId } });
  let actor = linked;
  if (!actor) {
    const candidate = await db.actor.findFirst({
      where: { kind: 'human', authUserId: null, email: input.email.toLowerCase() },
      orderBy: { createdAt: 'asc' },
    });
    if (!candidate) return undefined;
    // `authUserId: null` in the filter keeps two concurrent first sign-ins from both linking.
    const result = await db.actor.updateMany({
      where: { id: candidate.id, authUserId: null },
      data: { authUserId: input.authUserId },
    });
    actor = await db.actor.findUnique({ where: { id: candidate.id } });
    if (result.count === 0 && actor?.authUserId !== input.authUserId) return undefined;
  }
  if (!actor) return undefined;
  if (actor.disabled) return { status: 'disabled', actor };
  actor = await db.actor.update({ where: { id: actor.id }, data: { lastSeenAt: new Date() } });
  return { status: 'ok', actor, created: false };
}
