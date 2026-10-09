import { AdapterError, type EndpointConnection } from '@git-migrator/adapter-sdk';
import {
  findOwnInvitation,
  type InvitationDeps,
  type InvitationTx,
  linkAccepted,
  lockBatch,
  lockScope,
  markRouteStale,
  normaliseEmail,
  type ProviderInvitationLists,
  publishInvitationUpdated,
  safeErrorText,
  targetTaken,
  withBatchLock,
} from './shared.ts';

const DAY_MS = 24 * 3600 * 1000;

/** Codes that mean the provider refused this entry for good (not that the outcome is unknown). */
const DEFINITIVE_REFUSALS: ReadonlySet<string> = new Set([
  'invalid',
  'forbidden',
  'conflict',
  'unsupported',
  'not_found',
  'blocked_by_provider',
]);

export interface SendResult {
  readonly skipped?: 'not-found' | 'not-approved' | 'not-due' | 'already-running';
  readonly sent: number;
  readonly failed: number;
  /** Items still `selected` when the run ended (a rate limit, or the run stopped early). */
  readonly remaining: number;
  /** The provider asked us to wait: the next attempt. */
  readonly retryAt?: Date;
  readonly batchStatus?: string;
}

export class InvitationInterruptedError extends Error {
  constructor() {
    super('Invitation sending interrupted by shutdown');
    this.name = 'InvitationInterruptedError';
  }
}

interface SendClaim {
  readonly kind: 'send';
  readonly invitationId: string;
  readonly email: string;
  readonly teamSlugs: string[];
  /** A previous attempt may have reached the provider before it was recorded. */
  readonly retried: boolean;
  /** When the first attempt started (`send_started_at`, kept across retries). */
  readonly startedAt: Date;
  /**
   * The error a retried entry keeps when its invitation cannot be found and it becomes `unknown`:
   * `unknown_outcome`, or `mapping_<status>` when the mapping changed under the retried claim.
   */
  readonly holdError: string;
  readonly sourceIdentityId: string;
  readonly routeId: string;
  readonly targetEndpointId: string;
  /** Claiming moved the mapping to `pending_invite`. */
  readonly stale: boolean;
}

type Claim =
  | { kind: 'stop'; reason: 'not-found' | 'not-approved' | 'not-due'; retryAt?: Date }
  | { kind: 'done'; status: string }
  | { kind: 'failed'; stale: boolean }
  | SendClaim;

/**
 * Sends the approved, non-deselected entries of one Invitation Batch (AUTH-060 step 4).
 *
 * AUTH-061 is enforced here, not only at the endpoint, and never relies on the provider refusing
 * a duplicate:
 *
 * - every iteration takes the Route mapping lock, re-reads the batch under a row lock and stops
 *   unless it is `approved` or `sending` with an approver and approval time; it sends only items
 *   that are `selected` in that batch;
 * - the claim moves the person's mapping from `unmapped` to `pending_invite` in the same
 *   transaction that stamps `send_started_at`. Anyone who is not `unmapped` is not invited, so a
 *   person cannot be invited from two items; the database also allows one outstanding item per
 *   person and per address on a Route (unique indexes) and repeats the approval check in triggers;
 * - the item leaves `selected` only together with the provider's invitation id, in one conditional
 *   update, so a retry never records twice;
 * - an item that carries `send_started_at` on a later run may have reached the provider without
 *   being recorded. That run never posts and never fails the item: it looks for its own invitation
 *   (`findOwnInvitation`: same address, created after the first attempt started, recorded on no
 *   other item) and for a target member with the address, and records what it finds; if it finds
 *   nothing the item becomes `unknown`, still outstanding, until an operator resolves it;
 * - one run per batch holds a session advisory lock, so a duplicate job does nothing.
 */
export async function runInvitationSend(
  deps: InvitationDeps,
  batchId: string,
  options: { readonly shutdown: AbortSignal },
): Promise<SendResult> {
  const lock = await withBatchLock(deps, `invitations:${batchId}`, () =>
    sendLoop(deps, batchId, options),
  );
  return lock.ran ? lock.value : { skipped: 'already-running', sent: 0, failed: 0, remaining: 0 };
}

async function sendLoop(
  deps: InvitationDeps,
  batchId: string,
  options: { readonly shutdown: AbortSignal },
): Promise<SendResult> {
  const { db, log } = deps;
  const now = deps.now ?? (() => new Date());
  let sent = 0;
  let failed = 0;
  let stale = false;
  let connection: EndpointConnection | undefined;
  let lists: ProviderInvitationLists | undefined;

  const remaining = () => db.invitation.count({ where: { batchId, status: 'selected' } });

  for (;;) {
    if (options.shutdown.aborted) throw new InvitationInterruptedError();
    const claim = await claimNext(deps, batchId);
    if (claim.kind === 'stop') {
      if (sent + failed > 0) await publishInvitationUpdated(deps, batchId, stale);
      if (claim.reason === 'not-due' && claim.retryAt) {
        // Woken early: wait for the rest of the delay instead of dropping the schedule.
        await deps.schedule(
          { step: 'send', batchId },
          Math.max(1000, claim.retryAt.getTime() - now().getTime()),
        );
      }
      return {
        skipped: claim.reason,
        sent,
        failed,
        remaining: await remaining(),
        ...(claim.retryAt ? { retryAt: claim.retryAt } : {}),
      };
    }
    if (claim.kind === 'done') {
      await publishInvitationUpdated(deps, batchId, stale);
      return { sent, failed, remaining: 0, batchStatus: claim.status };
    }
    if (claim.kind === 'failed') {
      failed++;
      stale ||= claim.stale;
      continue;
    }
    stale ||= claim.stale;

    connection ??= await deps.connector.connect(claim.targetEndpointId, {
      pool: 'interactive',
      signal: options.shutdown,
    });
    const writer = connection.invitations;
    if (!writer) {
      throw new AdapterError({
        code: 'unsupported',
        provider: 'invitations',
        message: 'The target adapter cannot send invitations',
      });
    }

    let providerInvitationId: string | undefined;
    let inviteeLogin: string | undefined;

    if (claim.retried) {
      // A lost response or a crash after the call: the invitation may exist already. The lookup is
      // not part of the `invite()` call below: if it fails, NOTHING is released (the claim, the
      // `send_started_at` stamp and the mapping stay), because the system still cannot rule out
      // that an invitation exists. Only a limit is waited out; any other fault is retried by the job.
      try {
        lists ??= { pending: await writer.listPending(), failed: await writer.listFailed() };
      } catch (error) {
        if (error instanceof AdapterError && error.code === 'rate_limited') {
          const retryAt =
            error.retryAt ?? new Date(now().getTime() + (error.retryAfterMs ?? DAY_MS));
          await db.invitationBatch.update({
            where: { id: batchId },
            data: { nextAttemptAt: retryAt },
          });
          await deps.schedule(
            { step: 'send', batchId },
            Math.max(0, retryAt.getTime() - now().getTime()),
          );
          await publishInvitationUpdated(deps, batchId, stale);
          return { sent, failed, remaining: await remaining(), retryAt };
        }
        throw error;
      }
      const hit = await findOwnInvitation(
        db,
        {
          id: claim.invitationId,
          email: claim.email,
          targetEndpointId: claim.targetEndpointId,
          since: claim.startedAt,
        },
        lists,
      );
      if (hit) {
        // A failed one is recorded too: the inventory then expires it from the provider's report.
        providerInvitationId = hit.providerInvitationId;
        inviteeLogin = hit.kind === 'pending' ? hit.inviteeLogin : undefined;
      } else {
        // Not pending, not failed: it may have been accepted already. A member with the invited
        // address (or the stored login) is the invitee: link, do not invite again.
        const linked = await linkUnrecorded(deps, batchId, claim);
        if (linked) {
          stale = true;
          sent++;
          continue;
        }
        // Never post again (AUTH-061), and never free the person or the address: the entry becomes
        // `unknown`, still outstanding, and the mapping is left as it is until an operator resolves
        // it.
        await markUnknown(deps, claim);
        log.warn({ batchId }, 'invitation outcome unknown; held until an operator resolves it');
        failed++;
        continue;
      }
    }
    try {
      if (providerInvitationId === undefined) {
        const teamIds = await teamIdsFor(deps, claim);
        await deps.hooks?.beforeProviderCall?.(claim.invitationId);
        const result = await writer.invite({ email: claim.email, teamIds });
        providerInvitationId = result.providerInvitationId;
        await deps.hooks?.afterProviderCall?.(claim.invitationId);
      }
    } catch (error) {
      if (error instanceof AdapterError && error.code === 'rate_limited') {
        // Nothing was sent (this claim was not a retry, so no earlier attempt can have reached the
        // provider). The entry goes back to waiting (and the person to `unmapped`, still held by
        // the selected entry); the step runs again after the wait (AUTH-060 step 4).
        const retryAt = error.retryAt ?? new Date(now().getTime() + (error.retryAfterMs ?? DAY_MS));
        await releaseClaim(deps, claim, { status: 'selected', error: null, clearStarted: true });
        await db.invitationBatch.update({
          where: { id: batchId },
          data: { nextAttemptAt: retryAt },
        });
        await deps.schedule(
          { step: 'send', batchId },
          Math.max(0, retryAt.getTime() - now().getTime()),
        );
        log.info({ batchId, retryAt }, 'invitation sending waits for the provider limit');
        await publishInvitationUpdated(deps, batchId, true);
        return { sent, failed, remaining: await remaining(), retryAt };
      }
      if (error instanceof AdapterError && DEFINITIVE_REFUSALS.has(error.code)) {
        // The provider refused this entry. It stays failed and can go into a new batch.
        await releaseClaim(deps, claim, { status: 'failed', error: safeErrorText(error) });
        failed++;
        stale = true;
        continue;
      }
      // Unknown outcome (a timeout, a transient fault, bad credentials): nothing is recorded, the
      // item keeps `sendStartedAt`, and the retry looks for the invitation before anything else.
      throw error;
    }

    const recorded = await recordSent(deps, batchId, claim, providerInvitationId, inviteeLogin);
    if (recorded) sent++;
    if (sent > 0 && sent % 10 === 0) await publishInvitationUpdated(deps, batchId, stale);
  }
}

/** Re-reads the batch under the Route lock and claims the next `selected` item (or finishes it). */
async function claimNext(deps: InvitationDeps, batchId: string): Promise<Claim> {
  const now = deps.now ?? (() => new Date());
  const head = await deps.db.invitationBatch.findUnique({
    where: { id: batchId },
    select: { routeId: true, route: { select: { targetEndpointId: true } } },
  });
  if (!head) return { kind: 'stop', reason: 'not-found' };
  return deps.db.$transaction(async (raw): Promise<Claim> => {
    const tx = raw as unknown as InvitationTx;
    await lockScope(tx, head.route.targetEndpointId, head.routeId);
    const batch = await lockBatch(tx, batchId);
    if (!batch) return { kind: 'stop', reason: 'not-found' };
    // AUTH-061: nothing is sent outside an approved batch.
    const approved =
      (batch.status === 'approved' || batch.status === 'sending') &&
      batch.approvedById !== null &&
      batch.approvedAt !== null;
    if (!approved) return { kind: 'stop', reason: 'not-approved' };
    const at = now();
    if (batch.nextAttemptAt && batch.nextAttemptAt.getTime() > at.getTime()) {
      return { kind: 'stop', reason: 'not-due', retryAt: batch.nextAttemptAt };
    }
    if (batch.status === 'approved' || batch.nextAttemptAt) {
      await tx.invitationBatch.update({
        where: { id: batchId },
        data: { status: 'sending', nextAttemptAt: null },
      });
    }
    const item = await tx.invitation.findFirst({
      where: { batchId, status: 'selected' },
      orderBy: { id: 'asc' },
    });
    if (!item) {
      const bad = await tx.invitation.count({
        where: { batchId, status: { in: ['failed', 'expired', 'unknown'] } },
      });
      const status = bad > 0 ? 'partial' : 'sent';
      await tx.invitationBatch.update({ where: { id: batchId }, data: { status } });
      return { kind: 'done', status };
    }
    const retried = item.sendStartedAt !== null;
    if (item.targetEndpointId !== head.route.targetEndpointId) {
      // The Route moved to another target after the entry was drafted. The entry belongs to the
      // organization it was drafted for: it is never sent elsewhere. Nothing was sent yet: it fails.
      // An earlier attempt may have reached the old organization: it stays held (`unknown`) for an
      // operator to resolve.
      await tx.invitation.update({
        where: { id: item.id },
        data: retried
          ? { status: 'unknown', error: 'target_changed' }
          : { status: 'failed', error: 'target_changed' },
      });
      return { kind: 'failed', stale: false };
    }
    const mapping = await tx.identityMapping.findFirst({
      where: { routeId: batch.routeId, sourceIdentityId: item.sourceIdentityId },
      select: { id: true, status: true },
    });
    /** Moves an `unmapped` person to `pending_invite` (a conditional update). */
    const hold = async (): Promise<boolean> => {
      if (mapping?.status !== 'unmapped') return false;
      const claimed = await tx.identityMapping.updateMany({
        where: { id: mapping.id, status: 'unmapped' },
        data: {
          status: 'pending_invite',
          targetIdentityId: null,
          method: 'invite',
          confidence: null,
          decidedAt: at,
        },
      });
      return claimed.count === 1;
    };
    const moved = await hold();
    let holdError = 'unknown_outcome';
    if (retried) {
      // An earlier attempt may have reached the provider, so this entry never fails here, whatever
      // happened to the mapping meanwhile: the lookup records what it finds, and an entry it cannot
      // account for becomes `unknown` (still outstanding). It is never posted again, and its first
      // `send_started_at` is kept (the lookup compares the provider's creation time with it).
      if (!moved && mapping?.status !== 'pending_invite') {
        holdError = `mapping_${mapping?.status ?? 'missing'}`;
      }
    } else {
      // Only an `unmapped` person is invited. Nothing was sent for this entry yet, so anyone else
      // fails it without holding anything.
      if (!moved) {
        const reason =
          mapping === null
            ? 'mapping_missing'
            : mapping.status === 'unmapped'
              ? 'mapping_changed'
              : `mapping_${mapping.status}`;
        await tx.invitation.update({
          where: { id: item.id },
          data: { status: 'failed', error: reason },
        });
        return { kind: 'failed', stale: false };
      }
      await tx.invitation.update({ where: { id: item.id }, data: { sendStartedAt: at } });
    }
    // A mapping that moved to `pending_invite` resolves differently (FAC-006, ADR-0310).
    const stale = moved ? (await markRouteStale(tx, batch.routeId)) > 0 : false;
    return {
      kind: 'send',
      invitationId: item.id,
      email: item.email,
      teamSlugs: item.teamSlugs,
      retried,
      startedAt: item.sendStartedAt ?? at,
      holdError,
      sourceIdentityId: item.sourceIdentityId,
      routeId: batch.routeId,
      targetEndpointId: head.route.targetEndpointId,
      stale,
    };
  });
}

/** Gives a claim back: the item ends as given and the mapping returns to `unmapped`. */
async function releaseClaim(
  deps: InvitationDeps,
  claim: SendClaim,
  to: { status: 'failed' | 'selected'; error: string | null; clearStarted?: boolean },
): Promise<void> {
  await deps.db.$transaction(async (raw) => {
    const tx = raw as unknown as InvitationTx;
    await lockScope(tx, claim.targetEndpointId, claim.routeId);
    await tx.invitation.updateMany({
      where: { id: claim.invitationId, status: 'selected' },
      data: {
        status: to.status,
        error: to.error,
        ...(to.clearStarted ? { sendStartedAt: null } : {}),
      },
    });
    const moved = await tx.identityMapping.updateMany({
      where: {
        routeId: claim.routeId,
        sourceIdentityId: claim.sourceIdentityId,
        status: 'pending_invite',
        method: 'invite',
      },
      data: {
        status: 'unmapped',
        targetIdentityId: null,
        method: null,
        confidence: null,
        decidedAt: null,
        decidedById: null,
      },
    });
    if (moved.count > 0) await markRouteStale(tx, claim.routeId);
  });
}

/** Provider ids of the target teams that exist now; slugs without a team are left out (AUTH-060). */
async function teamIdsFor(deps: InvitationDeps, claim: SendClaim): Promise<string[]> {
  if (claim.teamSlugs.length === 0) return [];
  const groups = await deps.db.group.findMany({
    where: { endpointId: claim.targetEndpointId, slug: { in: claim.teamSlugs } },
    select: { providerId: true },
    orderBy: { providerId: 'asc' },
  });
  return groups.map((g) => g.providerId);
}

/** Records the provider's invitation id. The mapping already is `pending_invite` (the claim). */
async function recordSent(
  deps: InvitationDeps,
  batchId: string,
  claim: SendClaim,
  providerInvitationId: string,
  inviteeLogin: string | undefined,
): Promise<boolean> {
  const now = deps.now ?? (() => new Date());
  return deps.db.$transaction(async (raw) => {
    const tx = raw as unknown as InvitationTx;
    await lockScope(tx, claim.targetEndpointId, claim.routeId);
    await lockBatch(tx, batchId);
    const updated = await tx.invitation.updateMany({
      where: { id: claim.invitationId, status: 'selected' },
      data: {
        status: 'sent',
        providerInvitationId,
        sentAt: now(),
        error: null,
        ...(inviteeLogin ? { inviteeLogin } : {}),
      },
    });
    return updated.count > 0;
  });
}

/**
 * The entry may have reached the provider and been accepted already: a target member with the
 * stored login, or the only member with the invited address, is the invitee. The entry is recorded
 * as sent (provider id unknown) and linked, so nothing is sent again.
 */
async function linkUnrecorded(
  deps: InvitationDeps,
  batchId: string,
  claim: SendClaim,
): Promise<boolean> {
  const now = deps.now ?? (() => new Date());
  return deps.db.$transaction(async (raw) => {
    const tx = raw as unknown as InvitationTx;
    await lockScope(tx, claim.targetEndpointId, claim.routeId);
    await lockBatch(tx, batchId);
    const members = await tx.identity.findMany({
      where: { endpointId: claim.targetEndpointId, isMember: true },
      select: { id: true, login: true, email: true },
    });
    const wanted = normaliseEmail(claim.email);
    const byEmail = members.filter((m) => m.email && normaliseEmail(m.email) === wanted);
    const target = byEmail.length === 1 ? byEmail[0] : undefined;
    if (!target) return false;
    // A member another person already holds is never handed out again (ADR-0320). The entry then
    // stays unaccounted for and becomes `unknown`, never `sent` without an invitation id.
    if (await targetTaken(tx, claim, target.id)) return false;
    const at = now();
    const recorded = await tx.invitation.updateMany({
      where: { id: claim.invitationId, status: 'selected' },
      data: { status: 'sent', sentAt: at, error: null },
    });
    if (recorded.count === 0) return false;
    const item = await tx.invitation.findUniqueOrThrow({
      where: { id: claim.invitationId },
      select: { batchId: true },
    });
    const linked = await linkAccepted(
      tx,
      {
        id: claim.invitationId,
        batchId: item.batchId,
        routeId: claim.routeId,
        sourceIdentityId: claim.sourceIdentityId,
      },
      target.id,
      at,
    );
    // Checked above under the same lock; anything else is a bug, and rolls the record back.
    if (!linked.ok) throw new Error('an unrecorded invitation could not be linked');
    return true;
  });
}

/** The outcome cannot be known: the entry is `unknown`, outstanding, and the mapping is left alone. */
async function markUnknown(deps: InvitationDeps, claim: SendClaim): Promise<void> {
  await deps.db.$transaction(async (raw) => {
    const tx = raw as unknown as InvitationTx;
    await lockScope(tx, claim.targetEndpointId, claim.routeId);
    await tx.invitation.updateMany({
      where: { id: claim.invitationId, status: 'selected' },
      data: { status: 'unknown', error: claim.holdError },
    });
  });
}
