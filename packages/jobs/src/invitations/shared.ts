import type { Db } from '@git-migrator/db';
import {
  advisoryXactLock,
  invitationTargetLockKey,
  markAnalysesStale,
  publishEvent,
  routeMappingLockKey,
} from '@git-migrator/db';
import type { Logger } from '@git-migrator/observability';
import type pg from 'pg';
import type { EndpointConnector } from '../inventory/connector.ts';
import type { JobPayloads } from '../payloads.ts';

export type InvitationStep = JobPayloads['invitations.batch'];

/** Enqueues a step of an invitation batch after `delayMs` (the 24 h wait of AUTH-060 step 4). */
export type ScheduleInvitationStep = (step: InvitationStep, delayMs: number) => Promise<void>;

export interface InvitationDeps {
  /** The privileged client: the job is server code behind a queue (DOM-005). */
  readonly db: Db;
  /** The application pool, for the per-batch advisory lock and `NOTIFY`. */
  readonly appPool: pg.Pool;
  readonly connector: EndpointConnector;
  readonly schedule: ScheduleInvitationStep;
  readonly log: Logger;
  /** Test seam: the clock for `sentAt` and expiry. Defaults to the system clock. */
  readonly now?: () => Date;
  /** Test seams for the crash windows around the one irreversible call. */
  readonly hooks?: {
    readonly beforeProviderCall?: (invitationId: string) => Promise<void> | void;
    readonly afterProviderCall?: (invitationId: string) => Promise<void> | void;
  };
}

/** A transaction client, as far as the invitation code uses it. */
export type InvitationTx = Pick<
  Db,
  | 'invitation'
  | 'invitationBatch'
  | 'identityMapping'
  | 'identity'
  | 'migration'
  | 'group'
  | '$queryRaw'
  | '$executeRaw'
>;

/** After this long without any signal a sent invitation is reported as unresolved (never expired by guess). */
export const INVITATION_UNRESOLVED_AFTER_MS = 7 * 24 * 3600 * 1000;

/**
 * The address as the unique indexes compare it (the SQL guard trigger does the same with
 * `translate(btrim(email), 'A-Z', 'a-z')`): spaces trimmed at both ends, ASCII letters lower-cased,
 * nothing else changed.
 */
export const normaliseEmail = (email: string): string =>
  email.replace(/^ +| +$/g, '').replace(/[A-Z]/g, (c) => c.toLowerCase());

/** A finished batch with a failed or expired entry is `partial`. */
export async function settleBatch(
  tx: Pick<Db, 'invitation' | 'invitationBatch'>,
  batchId: string,
): Promise<void> {
  const bad = await tx.invitation.count({
    where: { batchId, status: { in: ['failed', 'expired', 'unknown'] } },
  });
  if (bad > 0) {
    await tx.invitationBatch.updateMany({
      where: { id: batchId, status: 'sent' },
      data: { status: 'partial' },
    });
  }
}

/**
 * The first locks of every invitation transaction: the target Endpoint's invitation lock (AUTH-061
 * holds per target organization, across the Routes that share it), then the Route mapping lock
 * (the key the mapping service uses). One lock order everywhere (ADR-0370): target Endpoint lock,
 * Route lock, batch row, invitation row, mapping row, Migration rows (id order, inside
 * `markAnalysesStale`).
 */
export async function lockScope(
  tx: Pick<Db, '$executeRaw'>,
  targetEndpointId: string,
  routeId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT set_config('lock_timeout', '15000', true), set_config('statement_timeout', '60000', true)`;
  await advisoryXactLock(tx, invitationTargetLockKey(targetEndpointId));
  await advisoryXactLock(tx, routeMappingLockKey(routeId));
}

export { invitationTargetLockKey };

/** Locks the batch row for the rest of the transaction. `FOR NO KEY UPDATE`, like the Run rows. */
export async function lockBatch(
  tx: Pick<Db, '$queryRaw'>,
  batchId: string,
): Promise<
  | {
      status: string;
      approvedById: string | null;
      approvedAt: Date | null;
      nextAttemptAt: Date | null;
      routeId: string;
    }
  | undefined
> {
  const rows = await tx.$queryRaw<
    {
      status: string;
      approved_by_id: string | null;
      approved_at: Date | null;
      next_attempt_at: Date | null;
      route_id: string;
    }[]
  >`SELECT status::text AS status, approved_by_id, approved_at, next_attempt_at, route_id
      FROM app.invitation_batch WHERE id = ${batchId} FOR NO KEY UPDATE`;
  const row = rows[0];
  return row
    ? {
        status: row.status,
        approvedById: row.approved_by_id,
        approvedAt: row.approved_at,
        nextAttemptAt: row.next_attempt_at,
        routeId: row.route_id,
      }
    : undefined;
}

/** What the mapping resolution changes when a mapping moves (AUTH-050 step 5, ADR-0310). */
export async function markRouteStale(
  tx: Pick<Db, 'migration' | '$queryRaw'>,
  routeId: string,
): Promise<number> {
  const marked = await markAnalysesStale(tx, { routeId });
  return marked.length;
}

export async function publishInvitationUpdated(
  deps: InvitationDeps,
  batchId: string,
  staleMigrations = false,
): Promise<void> {
  const at = (deps.now ?? (() => new Date()))().toISOString();
  await publishEvent(deps.appPool, {
    type: 'invitation.updated',
    ids: { invitation: batchId },
    at,
  });
  if (staleMigrations) {
    await publishEvent(deps.appPool, { type: 'migration.updated', ids: {}, at });
  }
}

/** The error text stored on an item: the adapter's code and HTTP status, never provider text. */
export function safeErrorText(error: unknown): string {
  const e = error as { code?: unknown; request?: { status?: unknown } } | null;
  const code = typeof e?.code === 'string' ? e.code.replace(/[^a-z_]/g, '').slice(0, 40) : 'error';
  const status = typeof e?.request?.status === 'number' ? ` (${e.request.status})` : '';
  return `${code || 'error'}${status}`;
}

/** Holds a per-batch session advisory lock while `body` runs; `undefined` when it is held elsewhere. */
export async function withBatchLock<T>(
  deps: Pick<InvitationDeps, 'appPool'>,
  key: string,
  body: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  let unlockFailed = false;
  const client = await deps.appPool.connect();
  try {
    const got = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok',
      [key],
    );
    if (!got.rows[0]?.ok) return { ran: false };
    try {
      return { ran: true, value: await body() };
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]).catch(() => {
        unlockFailed = true;
      });
    }
  } finally {
    client.release(unlockFailed);
  }
}

export type { Logger };

interface ItemRef {
  readonly id: string;
  readonly batchId: string;
  readonly routeId: string;
  readonly sourceIdentityId: string;
}

/**
 * A sent invitation was accepted by `targetId`: the item is `accepted` and the mapping
 * `confirmed` (method `invite`). A target another source already holds is never handed out again
 * (ADR-0320). Call inside a transaction that holds the Route lock.
 */
export async function linkAccepted(
  tx: InvitationTx,
  item: ItemRef,
  targetId: string,
  now: Date,
): Promise<{ ok: boolean; mapped: boolean }> {
  if (await targetTaken(tx, item, targetId)) return { ok: false, mapped: false };
  const done = await tx.invitation.updateMany({
    where: { id: item.id, status: 'sent' },
    data: { status: 'accepted' },
  });
  if (done.count === 0) return { ok: false, mapped: false };
  const moved = await tx.identityMapping.updateMany({
    where: {
      routeId: item.routeId,
      sourceIdentityId: item.sourceIdentityId,
      status: 'pending_invite',
    },
    data: {
      status: 'confirmed',
      targetIdentityId: targetId,
      method: 'invite',
      confidence: null,
      decidedAt: now,
    },
  });
  if (moved.count > 0) await markRouteStale(tx, item.routeId);
  return { ok: true, mapped: moved.count > 0 };
}

/**
 * A sent invitation ended without an acceptance (the provider reports it failed or expired, or an
 * operator revoked it): the item is `expired` with a code, the person is `unmapped` again and the
 * batch is `partial`. Call inside a transaction that holds the Route lock.
 */
export async function expireItem(
  tx: InvitationTx,
  item: ItemRef,
  error: string,
): Promise<{ ok: boolean; mapped: boolean }> {
  const done = await tx.invitation.updateMany({
    where: { id: item.id, status: 'sent' },
    data: { status: 'expired', error },
  });
  if (done.count === 0) return { ok: false, mapped: false };
  const moved = await tx.identityMapping.updateMany({
    where: {
      routeId: item.routeId,
      sourceIdentityId: item.sourceIdentityId,
      status: 'pending_invite',
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
  if (moved.count > 0) await markRouteStale(tx, item.routeId);
  await settleBatch(tx, item.batchId);
  return { ok: true, mapped: moved.count > 0 };
}

/** What the provider lists, as far as finding an invitation again needs it. */
export interface ProviderInvitationLists {
  readonly pending: readonly {
    providerInvitationId: string;
    email?: string;
    inviteeLogin?: string;
    createdAt?: Date;
  }[];
  readonly failed: readonly {
    providerInvitationId: string;
    email?: string;
    reason: string;
    createdAt?: Date;
  }[];
}

export type FoundInvitation =
  | {
      readonly kind: 'pending';
      readonly providerInvitationId: string;
      readonly inviteeLogin?: string;
    }
  | { readonly kind: 'failed'; readonly providerInvitationId: string; readonly reason: string };

/**
 * The invitation an entry without a recorded provider id may stand for (AUTH-061): a retried send
 * whose response was lost, or an entry an operator resolved as `invited`. Only an invitation for
 * the same normalised address counts that
 *
 * - the provider created at or after the entry's first attempt started (`since`, compared to the
 *   second, the provider's precision): an older one for the address is an earlier invitation,
 *   and taking it would tie the entry to an invitation that is not its own; and
 * - no other entry of the same target records.
 *
 * A pending one wins over a failed one. A clock skew can only make the lookup miss, which keeps
 * the entry held (`unknown` or `sent`), never frees it.
 */
export async function findOwnInvitation(
  db: Pick<Db, 'invitation'>,
  entry: {
    readonly id: string;
    readonly email: string;
    readonly targetEndpointId: string;
    readonly since: Date;
  },
  lists: ProviderInvitationLists,
): Promise<FoundInvitation | undefined> {
  const wanted = normaliseEmail(entry.email);
  const after = Math.floor(entry.since.getTime() / 1000) * 1000;
  const own = (p: { email?: string; createdAt?: Date }) =>
    p.email !== undefined &&
    normaliseEmail(p.email) === wanted &&
    p.createdAt !== undefined &&
    p.createdAt.getTime() >= after;
  const pending = lists.pending.filter(own);
  const failed = lists.failed.filter(own);
  const ids = [...pending, ...failed].map((p) => p.providerInvitationId);
  if (ids.length === 0) return undefined;
  const recorded = await db.invitation.findMany({
    where: {
      id: { not: entry.id },
      providerInvitationId: { in: ids },
      targetEndpointId: entry.targetEndpointId,
    },
    select: { providerInvitationId: true },
  });
  const taken = new Set(recorded.map((r) => r.providerInvitationId));
  const hit = pending.find((p) => !taken.has(p.providerInvitationId));
  if (hit) {
    return {
      kind: 'pending',
      providerInvitationId: hit.providerInvitationId,
      ...(hit.inviteeLogin ? { inviteeLogin: hit.inviteeLogin } : {}),
    };
  }
  const ended = failed.find((p) => !taken.has(p.providerInvitationId));
  return ended
    ? { kind: 'failed', providerInvitationId: ended.providerInvitationId, reason: ended.reason }
    : undefined;
}

/** The target is already confirmed for another source person on the Route (ADR-0320). */
export async function targetTaken(
  tx: Pick<Db, 'identityMapping'>,
  item: { readonly routeId: string; readonly sourceIdentityId: string },
  targetId: string,
): Promise<boolean> {
  const taken = await tx.identityMapping.findFirst({
    where: {
      routeId: item.routeId,
      status: 'confirmed',
      targetIdentityId: targetId,
      sourceIdentityId: { not: item.sourceIdentityId },
    },
    select: { id: true },
  });
  return taken !== null;
}
