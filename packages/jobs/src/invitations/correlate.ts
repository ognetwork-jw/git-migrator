import type { EndpointConnection } from '@git-migrator/adapter-sdk';
import { DEFAULT_ROUTE_POLICIES, resolveRoutePolicies } from '@git-migrator/core';
import type { Db } from '@git-migrator/db';
import { publishEvent } from '@git-migrator/db';
import type { Logger } from '@git-migrator/observability';
import type pg from 'pg';
import {
  expireItem,
  findOwnInvitation,
  INVITATION_UNRESOLVED_AFTER_MS,
  type InvitationTx,
  linkAccepted,
  lockBatch,
  lockScope,
  normaliseEmail,
  type ScheduleInvitationStep,
} from './shared.ts';

export interface CorrelateDeps {
  readonly db: Db;
  readonly appPool: pg.Pool;
  readonly log: Logger;
  readonly now: () => Date;
  /** Wakes the send job of an approved batch that is waiting (a lost enqueue, a restart). */
  readonly schedule?: ScheduleInvitationStep;
}

export interface CorrelateResult {
  readonly accepted: number;
  readonly expired: number;
  /** Sent invitations with no signal for a week (reported, not changed). */
  readonly unresolved: number;
  /** Approved batches whose send step was scheduled again. */
  readonly resumed: number;
}

type RouteRow = Awaited<ReturnType<Db['route']['findMany']>>[number];

/**
 * Acceptance correlation at each inventory of the target Endpoint (AUTH-060 step 5), after the
 * Identities of that Endpoint are up to date:
 *
 * 1. A sent invitation that is no longer pending and whose invitee login (recorded while the
 *    provider still reported it) is a member now is `accepted`; its mapping becomes `confirmed`,
 *    method `invite`, with the target Identity. Where the provider never reports a login (invitations
 *    by e-mail), a member Identity whose e-mail equals the invited one counts the same, but only
 *    under the Route's `identityMatch.autoConfirmEmail` policy (ADR-0370).
 * 2. Otherwise nothing is guessed: new members that match no mapping are offered as suggestions on
 *    the batch (read side), and an operator confirms.
 * 3. An invitation the provider lists as failed (which includes the ones that expired) is
 *    `expired` with a code; its mapping returns to `unmapped`. Nothing else expires an
 *    invitation: one that is simply gone and unexplained after a week stays `sent` and is
 *    reported as `unresolved` (ADR-0371).
 *
 * An entry without a provider id (resolved as `invited` by an operator) is first matched to its own
 * invitation by address (`findOwnInvitation`); with no match it goes through step 1 and the
 * unresolved report like any invitation that is gone.
 *
 * It also schedules the send step of approved batches again (lost enqueue, restart).
 */
export async function correlateInvitations(
  deps: CorrelateDeps,
  connection: EndpointConnection,
  routes: readonly RouteRow[],
  endpointId: string,
): Promise<CorrelateResult> {
  const { db } = deps;
  const own = routes.filter((r) => r.targetEndpointId === endpointId);
  let accepted = 0;
  let expired = 0;
  let unresolved = 0;
  let resumed = 0;

  // Every `sent` entry whose invitation lives in this organization, whatever the Route's target is
  // now (the entry's target is fixed when it is created).
  const open = await db.invitation.findMany({
    where: { status: 'sent', targetEndpointId: endpointId },
    include: { batch: { select: { id: true, routeId: true } } },
    orderBy: { id: 'asc' },
  });
  const writer = connection.invitations;
  if (open.length > 0 && writer) {
    const [pending, failed, members] = await Promise.all([
      writer.listPending(),
      writer.listFailed(),
      db.identity.findMany({
        where: { endpointId, isMember: true },
        select: { id: true, login: true, email: true },
      }),
    ]);
    const pendingById = new Map(pending.map((p) => [p.providerInvitationId, p]));
    const failedById = new Map(failed.map((f) => [f.providerInvitationId, f]));
    const byLogin = new Map(members.flatMap((m) => (m.login ? [[m.login.toLowerCase(), m]] : [])));
    const byEmail = new Map<string, typeof members>();
    for (const m of members) {
      if (!m.email) continue;
      const key = normaliseEmail(m.email);
      byEmail.set(key, [...(byEmail.get(key) ?? []), m]);
    }
    const autoConfirm = new Map(
      routes.map((r) => {
        try {
          return [r.id, resolveRoutePolicies(r.policies).identityMatch.autoConfirmEmail] as const;
        } catch {
          return [r.id, DEFAULT_ROUTE_POLICIES.identityMatch.autoConfirmEmail] as const;
        }
      }),
    );
    const touched = new Set<string>();
    const staleRoutes = new Set<string>();
    const now = deps.now();

    for (const item of open) {
      const ref = {
        id: item.id,
        batchId: item.batch.id,
        routeId: item.batch.routeId,
        sourceIdentityId: item.sourceIdentityId,
      };
      let providerId = item.providerInvitationId;
      const since = item.sendStartedAt ?? item.sentAt;
      if (!providerId && since) {
        // An entry an operator resolved as `invited` carries no provider id (ADR-0370): its own
        // invitation is found by address, created after its first attempt, recorded nowhere else.
        const own = await findOwnInvitation(
          db,
          { id: item.id, email: item.email, targetEndpointId: endpointId, since },
          { pending, failed },
        );
        if (own) {
          const login = own.kind === 'pending' ? own.inviteeLogin : undefined;
          const stored = await db.invitation.updateMany({
            where: { id: item.id, status: 'sent', providerInvitationId: null },
            data: {
              providerInvitationId: own.providerInvitationId,
              ...(login ? { inviteeLogin: login } : {}),
            },
          });
          if (stored.count === 1) {
            providerId = own.providerInvitationId;
            touched.add(ref.batchId);
          }
        }
      }
      const failure = providerId ? failedById.get(providerId) : undefined;
      const stillPending = providerId ? pendingById.get(providerId) : undefined;
      // A failed invitation can still be listed as pending: the failure wins.
      if (stillPending && !failure) {
        if (stillPending.inviteeLogin && stillPending.inviteeLogin !== item.inviteeLogin) {
          await db.invitation.update({
            where: { id: item.id },
            data: { inviteeLogin: stillPending.inviteeLogin },
          });
        }
        continue;
      }
      if (failure) {
        // Only the provider's own report expires an invitation (AUTH-060 step 5.3): never a guess.
        const expiredNow = await db.$transaction(async (raw) => {
          const tx = raw as unknown as InvitationTx;
          await lockScope(tx, endpointId, ref.routeId);
          await lockBatch(tx, ref.batchId);
          return expireItem(
            tx,
            ref,
            /expir/i.test(failure.reason) ? 'failed:expired' : 'failed:other',
          );
        });
        if (expiredNow.ok) {
          expired++;
          touched.add(ref.batchId);
          if (expiredNow.mapped) staleRoutes.add(ref.routeId);
        }
        continue;
      }
      // Gone from the pending list without a failure record: accepted, withdrawn elsewhere, or not
      // visible to us. Link only when the invitee can be named.
      const byLoginHit = item.inviteeLogin
        ? byLogin.get(item.inviteeLogin.toLowerCase())
        : undefined;
      const hits = byEmail.get(normaliseEmail(item.email)) ?? [];
      const byEmailHit =
        !byLoginHit &&
        (autoConfirm.get(ref.routeId) ?? DEFAULT_ROUTE_POLICIES.identityMatch.autoConfirmEmail) &&
        hits.length === 1
          ? hits[0]
          : undefined;
      const target = byLoginHit ?? byEmailHit;
      if (target) {
        const linked = await db.$transaction(async (raw) => {
          const tx = raw as unknown as InvitationTx;
          await lockScope(tx, endpointId, ref.routeId);
          await lockBatch(tx, ref.batchId);
          return linkAccepted(tx, ref, target.id, now);
        });
        if (linked.ok) {
          accepted++;
          touched.add(ref.batchId);
          if (linked.mapped) staleRoutes.add(ref.routeId);
        }
        continue;
      }
      // No signal for a week: say so, and change nothing (an accepted invitation must never be
      // called expired). The operator resolves it by confirming a suggestion or by revoking.
      const sentAt = item.sentAt?.getTime() ?? 0;
      if (sentAt > 0 && sentAt + INVITATION_UNRESOLVED_AFTER_MS <= now.getTime()) {
        if (item.error !== 'unresolved') {
          await db.invitation.update({ where: { id: item.id }, data: { error: 'unresolved' } });
          touched.add(ref.batchId);
        }
        unresolved++;
        deps.log.warn({ batchId: ref.batchId }, 'invitation.unresolved');
      }
    }
    const at = now.toISOString();
    for (const batchId of touched) {
      await publishEvent(deps.appPool, {
        type: 'invitation.updated',
        ids: { invitation: batchId },
        at,
      });
    }
    if (staleRoutes.size > 0) {
      await publishEvent(deps.appPool, { type: 'migration.updated', ids: {}, at });
    }
  }

  if (deps.schedule) {
    const waiting = await db.invitationBatch.findMany({
      where: {
        routeId: { in: own.map((r) => r.id) },
        status: { in: ['approved', 'sending'] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: deps.now() } }],
      },
      select: { id: true },
    });
    for (const batch of waiting) {
      await deps.schedule({ step: 'send', batchId: batch.id }, 0);
      resumed++;
    }
  }
  return { accepted, expired, unresolved, resumed };
}
