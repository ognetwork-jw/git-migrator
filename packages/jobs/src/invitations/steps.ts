import { databaseNow } from '../db-clock.ts';
import {
  expireItem,
  findOwnInvitation,
  type InvitationDeps,
  type InvitationTx,
  linkAccepted,
  lockBatch,
  lockScope,
  normaliseEmail,
  publishInvitationUpdated,
  withBatchLock,
} from './shared.ts';

/** What the seat preview stores in `InvitationBatch.seatPreview` (AUTH-060 step 2). */
export type SeatPreview = {
  readonly toInvite: number;
  readonly seatsTotal: number | null;
  readonly seatsFilled: number | null;
  /** When the seats were read; null while they are unknown. */
  readonly seatsReadAt: string | null;
};

const asPreview = (value: unknown): SeatPreview => {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const num = (x: unknown): number | null => (typeof x === 'number' ? x : null);
  return {
    toInvite: num(v.toInvite) ?? 0,
    seatsTotal: num(v.seatsTotal),
    seatsFilled: num(v.seatsFilled),
    seatsReadAt: typeof v.seatsReadAt === 'string' ? v.seatsReadAt : null,
  };
};

/**
 * Reads the organization's seats where the credential can read them (AUTH-060 step 2) and stores
 * them in the batch's preview. A provider that does not tell (no plan permission, no seat limit)
 * leaves the seats `null`, which the UI shows as "unknown".
 */
export async function runSeatPreview(
  deps: InvitationDeps,
  batchId: string,
  options: { readonly shutdown: AbortSignal },
): Promise<{ read: boolean }> {
  const { db } = deps;
  const batch = await db.invitationBatch.findUnique({
    where: { id: batchId },
    select: { route: { select: { targetEndpointId: true } } },
  });
  if (!batch) return { read: false };
  let info: { total?: number; filled?: number } | undefined;
  try {
    const connection = await deps.connector.connect(batch.route.targetEndpointId, {
      pool: 'interactive',
      signal: options.shutdown,
    });
    info = await connection.org?.seatInfo();
  } catch (error) {
    // The preview is advice; a provider fault leaves it "unknown" and must not fail the batch.
    deps.log.warn(
      { batchId, errorClass: (error as Error | null)?.name },
      'seat preview unavailable',
    );
    return { read: false };
  }
  const at = deps.now ? deps.now() : await databaseNow(db);
  await db.$transaction(async (raw) => {
    const tx = raw as unknown as InvitationTx;
    if (!(await lockBatch(tx, batchId))) return;
    const current = await tx.invitationBatch.findUniqueOrThrow({
      where: { id: batchId },
      select: { seatPreview: true },
    });
    const preview = asPreview(current.seatPreview);
    const next: SeatPreview = {
      toInvite: preview.toInvite,
      seatsTotal: info?.total ?? null,
      seatsFilled: info?.filled ?? null,
      seatsReadAt:
        info?.total !== undefined || info?.filled !== undefined ? at.toISOString() : null,
    };
    await tx.invitationBatch.update({ where: { id: batchId }, data: { seatPreview: next } });
  });
  await publishInvitationUpdated(deps, batchId);
  return { read: info !== undefined };
}

export interface RevokeResult {
  readonly skipped?: 'not-found' | 'not-sent' | 'already-running';
  /** The provider removed a pending invitation. */
  readonly cancelled: boolean;
}

/**
 * Withdraws one sent invitation (the revoke flow that `unmap` points to, ADR-0320). The item
 * becomes `expired` with the reason `revoked`, and the mapping goes back to `unmapped`, so the
 * person is a candidate again. An invitation the provider no longer has (`cancelled: false`) is
 * released the same way, because the operator decided it: this is also the way out of a
 * `pending_invite` that no inventory can resolve.
 */
export async function runInvitationRevoke(
  deps: InvitationDeps,
  batchId: string,
  invitationId: string,
  options: { readonly shutdown: AbortSignal },
): Promise<RevokeResult> {
  // Its own lock: a revoke only touches a `sent` entry, so it never waits for the send step.
  const lock = await withBatchLock(deps, `invitations-revoke:${invitationId}`, async () => {
    const { db } = deps;
    const item = await db.invitation.findFirst({
      where: { id: invitationId, batchId, status: 'sent' },
      select: {
        providerInvitationId: true,
        sourceIdentityId: true,
        email: true,
        sendStartedAt: true,
        sentAt: true,
        targetEndpointId: true,
        batch: { select: { routeId: true } },
      },
    });
    if (!item) return { skipped: 'not-sent', cancelled: false } as const;
    // The organization the invitation was sent to (fixed on the entry), even if the Route moved.
    const targetEndpointId = item.targetEndpointId;
    const connection = await deps.connector.connect(targetEndpointId, {
      pool: 'interactive',
      signal: options.shutdown,
    });
    const writer = connection.invitations;
    if (!writer) return { skipped: 'not-sent', cancelled: false } as const;
    let providerId = item.providerInvitationId;
    const since = item.sendStartedAt ?? item.sentAt;
    if (!providerId && since) {
      // An entry an operator resolved as `invited` has no provider id: find its own pending
      // invitation by address (created after its first attempt, recorded on no other entry).
      const own = await findOwnInvitation(
        db,
        { id: invitationId, email: item.email, targetEndpointId, since },
        { pending: await writer.listPending(), failed: [] },
      );
      providerId = own?.providerInvitationId ?? null;
    }
    // Nothing found to cancel: the same member check as an invitation the provider no longer has.
    const { cancelled } = providerId ? await writer.cancel(providerId) : { cancelled: false };
    const full = await db.invitation.findUniqueOrThrow({
      where: { id: invitationId },
      select: { email: true, inviteeLogin: true },
    });
    const stale = await db.$transaction(async (raw) => {
      const tx = raw as unknown as InvitationTx;
      await lockScope(tx, targetEndpointId, item.batch.routeId);
      await lockBatch(tx, batchId);
      const ref = {
        id: invitationId,
        batchId,
        routeId: item.batch.routeId,
        sourceIdentityId: item.sourceIdentityId,
      };
      if (providerId && !item.providerInvitationId) {
        await tx.invitation.updateMany({
          where: { id: invitationId, status: 'sent', providerInvitationId: null },
          data: { providerInvitationId: providerId },
        });
      }
      if (cancelled) return (await expireItem(tx, ref, 'revoked')).mapped;
      // The provider no longer had it. If the invitee is a member, it was accepted: link, do not
      // release (an accepted invitation must not look withdrawn).
      const members = await tx.identity.findMany({
        where: { endpointId: targetEndpointId, isMember: true },
        select: { id: true, login: true, email: true },
      });
      const wanted = normaliseEmail(full.email);
      const byLogin = full.inviteeLogin
        ? members.find((m) => m.login?.toLowerCase() === full.inviteeLogin?.toLowerCase())
        : undefined;
      const byEmail = members.filter((m) => m.email && normaliseEmail(m.email) === wanted);
      const target = byLogin ?? (byEmail.length === 1 ? byEmail[0] : undefined);
      if (target) {
        const linked = await linkAccepted(tx, ref, target.id, (deps.now ?? (() => new Date()))());
        if (linked.ok) return linked.mapped;
      }
      return (await expireItem(tx, ref, 'revoked_not_found')).mapped;
    });
    await publishInvitationUpdated(deps, batchId, stale);
    return { cancelled } as const;
  });
  return lock.ran ? lock.value : { skipped: 'already-running', cancelled: false };
}
