/**
 * Invitation batches (AUTH-060, AUTH-061, ADR-0370): drafting from candidates, selecting and
 * deselecting, approval, and the read models of UI-029. Nothing here talks to the provider: the
 * web process has no provider access, so the seat preview, the sending and the revoking are job
 * steps (`invitations.batch`).
 */
import { createHash } from 'node:crypto';
import {
  advisoryXactLock,
  type Db,
  type DbHandle,
  invitationTargetLockKey,
  publishEventIn,
  routeMappingLockKey,
  supersedeParityChecks,
} from '@git-migrator/db';
import { normaliseEmail } from '@git-migrator/jobs';
import { exclusionPatterns } from '../mapping/expected-differences.ts';
import { markRouteAnalysesStale } from '../mapping/stale.ts';
import { ProblemError } from '../problem.ts';

export type Writer = Pick<DbHandle, 'privileged'>;

type Tx = Pick<
  Db,
  | 'invitation'
  | 'invitationBatch'
  | 'identity'
  | 'identityMapping'
  | 'group'
  | 'groupMapping'
  | 'route'
  | 'migration'
  | 'expectedDifference'
  | 'auditEvent'
  | '$executeRaw'
  | '$queryRaw'
>;

/** Items one batch may hold; a bigger migration drafts several batches. */
export const MAX_BATCH_ITEMS = 5000;
export const MAX_REASON = 500;
const BULK_ROWS = 2000;
/** Suggestions listed per sent item (AUTH-060 step 5.2). */
const MAX_SUGGESTIONS = 5;
/** New members read for the suggestions of one page. */
const SUGGESTION_POOL = 500;

/** Mapping states a person can be invited from: nobody has decided about them yet. */
/** Only an `unmapped` person is invited: a suggestion needs an operator first (AUTH-061). */
const INVITABLE = ['unmapped'] as const;
/** Entries that still hold the person and the address: the provider may have the invitation. */
const OUTSTANDING = ['selected', 'sent', 'unknown'] as const;

const invalid = (path: string, message: string): ProblemError =>
  new ProblemError('validation_failed', { errors: [{ path, message }] });
const conflict = (detail: string): ProblemError => new ProblemError('conflict', { detail });

function* chunks<T>(items: readonly T[], size = BULK_ROWS): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/**
 * Serializes invitation writes: the invitation lock of every target Endpoint involved (AUTH-061
 * holds per target organization, across the Routes that share it), in id order, then the Route
 * mapping lock (the same key the mapping service uses). The keys match the jobs' `lockScope`.
 */
async function lockScope(tx: Tx, targetEndpointIds: readonly string[], routeId: string) {
  await tx.$executeRaw`SELECT set_config('lock_timeout', '15000', true), set_config('statement_timeout', '60000', true)`;
  for (const target of [...new Set(targetEndpointIds)].sort()) {
    await advisoryXactLock(tx, invitationTargetLockKey(target));
  }
  await advisoryXactLock(tx, routeMappingLockKey(routeId));
}

/**
 * One lock order for every invitation write (ADR-0370): the target Endpoint locks, the Route
 * mapping lock, the batch row, the invitation row, the mapping row, Migration rows. Reads the
 * (immutable) Route of the batch and the Route's target first. `alsoTargets` names the
 * organizations of entries drafted before the Route moved to another target.
 */
async function lockedBatch(tx: Tx, batchId: string, alsoTargets: readonly string[] = []) {
  const head = await tx.invitationBatch.findUnique({
    where: { id: batchId },
    select: { routeId: true, route: { select: { targetEndpointId: true } } },
  });
  if (!head) throw new ProblemError('not_found');
  await lockScope(tx, [head.route.targetEndpointId, ...alsoTargets], head.routeId);
  return { ...(await lockBatch(tx, batchId)), targetEndpointId: head.route.targetEndpointId };
}

/**
 * Another outstanding item (selected, sent or unknown) for the person or the address in the same
 * target organization, on any Route, if any.
 */
async function holder(
  tx: Tx,
  targetEndpointId: string,
  item: { id: string; sourceIdentityId: string; email: string },
): Promise<{ routeId: string; batchId: string } | null> {
  return tx.invitation.findFirst({
    where: {
      targetEndpointId,
      id: { not: item.id },
      status: { in: [...OUTSTANDING] },
      OR: [
        { sourceIdentityId: item.sourceIdentityId },
        { emailNormalised: normaliseEmail(item.email) },
      ],
    },
    select: { routeId: true, batchId: true },
    orderBy: { id: 'asc' },
  });
}

const heldText = (h: { routeId: string; batchId: string }): string =>
  `the person or the address is held by an outstanding invitation (Route ${h.routeId}, batch ${h.batchId})`;

/** Locks the batch row (`FOR NO KEY UPDATE`, like the Run rows) and returns its facts. */
async function lockBatch(tx: Tx, batchId: string) {
  const rows = await tx.$queryRaw<
    { id: string; status: string; route_id: string; seat_preview: unknown }[]
  >`SELECT id, status::text AS status, route_id, seat_preview
      FROM app.invitation_batch WHERE id = ${batchId} FOR NO KEY UPDATE`;
  const row = rows[0];
  if (!row) throw new ProblemError('not_found');
  return { id: row.id, status: row.status, routeId: row.route_id, seatPreview: row.seat_preview };
}

async function audit(
  tx: Tx,
  actorId: string,
  action: string,
  subjectId: string,
  data: { [key: string]: string | number | boolean | null },
): Promise<void> {
  await tx.auditEvent.create({
    data: { actorId, action, subjectType: 'invitation_batch', subjectId, data },
  });
}

async function announce(tx: Tx, batchId: string, at: Date, staleMigrations = false): Promise<void> {
  const when = at.toISOString();
  await publishEventIn(tx, { type: 'invitation.updated', ids: { invitation: batchId }, at: when });
  if (staleMigrations) {
    await publishEventIn(tx, { type: 'migration.updated', ids: {}, at: when });
  }
}

// ---------------------------------------------------------------------------------------------
// Views

export interface IdentityRef {
  id: string;
  providerId: string;
  login: string | null;
  displayName: string | null;
  email: string | null;
}
const identityFields = {
  id: true,
  providerId: true,
  login: true,
  displayName: true,
  email: true,
} as const;

export interface SeatPreviewView {
  toInvite: number;
  seatsTotal: number | null;
  seatsFilled: number | null;
  /** `seatsFilled + toInvite` where both seats numbers are known. */
  projectedFilled: number | null;
}

export interface BatchView {
  id: string;
  routeId: string;
  status: 'draft' | 'approved' | 'sending' | 'sent' | 'partial';
  createdAt: string;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  nextAttemptAt: string | null;
  seatPreview: SeatPreviewView;
  /** Identifies the selected entries of a draft; approval 409s when it changed. */
  selectionToken: string;
  counts: Record<
    'selected' | 'deselected' | 'sent' | 'accepted' | 'failed' | 'expired' | 'unknown',
    number
  >;
}

export interface ItemView {
  id: string;
  status: 'selected' | 'deselected' | 'sent' | 'accepted' | 'failed' | 'expired' | 'unknown';
  email: string;
  teamSlugs: string[];
  source: IdentityRef;
  error: string | null;
  deselectReason: string | null;
  sentAt: string | null;
  /**
   * The provider's invitation id is recorded. Without it (an entry an operator resolved as
   * invited), a revoke looks the invitation up by address and releases the person on a miss.
   */
  providerIdKnown: boolean;
  /** The Identity Mapping of the person, for confirming a suggestion. */
  mappingId: string | null;
  /** New members that might be this invitee (AUTH-060 step 5.2); an operator confirms. */
  suggestions: IdentityRef[];
}

function previewOf(raw: unknown, selected: number): SeatPreviewView {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (x: unknown): number | null => (typeof x === 'number' ? x : null);
  const total = num(v.seatsTotal);
  const filled = num(v.seatsFilled);
  return {
    toInvite: selected,
    seatsTotal: total,
    seatsFilled: filled,
    projectedFilled: filled === null ? null : filled + selected,
  };
}

async function countsOf(
  db: Pick<Db, 'invitation'>,
  batchIds: readonly string[],
): Promise<Map<string, BatchView['counts']>> {
  const out = new Map<string, BatchView['counts']>();
  for (const id of batchIds) {
    out.set(id, {
      selected: 0,
      deselected: 0,
      sent: 0,
      accepted: 0,
      failed: 0,
      expired: 0,
      unknown: 0,
    });
  }
  if (batchIds.length === 0) return out;
  const groups = await db.invitation.groupBy({
    by: ['batchId', 'status'],
    where: { batchId: { in: [...batchIds] } },
    _count: { _all: true },
  });
  for (const g of groups) {
    const counts = out.get(g.batchId);
    if (counts) counts[g.status] = g._count._all;
  }
  return out;
}

interface BatchRow {
  id: string;
  routeId: string;
  status: BatchView['status'];
  createdAt: Date;
  approvedAt: Date | null;
  nextAttemptAt: Date | null;
  seatPreview: unknown;
  createdBy: { displayName: string };
  approvedBy: { displayName: string } | null;
}
const batchInclude = {
  createdBy: { select: { displayName: true } },
  approvedBy: { select: { displayName: true } },
} as const;

async function toBatchViews(db: Pick<Db, 'invitation'>, rows: BatchRow[]): Promise<BatchView[]> {
  const counts = await countsOf(
    db,
    rows.map((r) => r.id),
  );
  const drafts = rows.filter((r) => r.status === 'draft').map((r) => r.id);
  const tokens = new Map<string, string[]>();
  if (drafts.length > 0) {
    for (const row of await db.invitation.findMany({
      where: { batchId: { in: drafts }, status: 'selected' },
      select: { id: true, batchId: true },
      orderBy: { id: 'asc' },
    })) {
      tokens.set(row.batchId, [...(tokens.get(row.batchId) ?? []), row.id]);
    }
  }
  return rows.map((r) => {
    const c = counts.get(r.id) as BatchView['counts'];
    return {
      id: r.id,
      routeId: r.routeId,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdBy.displayName,
      approvedBy: r.approvedBy?.displayName ?? null,
      approvedAt: iso(r.approvedAt),
      nextAttemptAt: iso(r.nextAttemptAt),
      seatPreview: previewOf(r.seatPreview, c.selected),
      selectionToken: r.status === 'draft' ? selectionToken(tokens.get(r.id) ?? []) : '',
      counts: c,
    };
  });
}

export const selectionToken = (ids: readonly string[]): string =>
  createHash('sha256')
    .update([...ids].sort().join(','))
    .digest('hex')
    .slice(0, 32);

export async function listBatches(
  db: Db,
  options: { routeId?: string; status?: BatchView['status']; cursor?: string; limit: number },
): Promise<{ rows: BatchView[]; hasMore: boolean }> {
  const rows = (await db.invitationBatch.findMany({
    where: {
      ...(options.routeId ? { routeId: options.routeId } : {}),
      ...(options.status ? { status: options.status } : {}),
      ...(options.cursor ? { id: { lt: options.cursor } } : {}),
    },
    include: batchInclude,
    orderBy: { id: 'desc' },
    take: options.limit + 1,
  })) as unknown as BatchRow[];
  const page = rows.slice(0, options.limit);
  return { rows: await toBatchViews(db, page), hasMore: rows.length > options.limit };
}

async function batchView(db: Pick<Db, 'invitation' | 'invitationBatch'>, id: string) {
  const row = (await db.invitationBatch.findUnique({
    where: { id },
    include: batchInclude,
  })) as unknown as BatchRow | null;
  if (!row) throw new ProblemError('not_found');
  return (await toBatchViews(db, [row]))[0] as BatchView;
}

export const getBatchSummary = batchView;

export async function getBatch(
  db: Db,
  id: string,
  options: { status?: ItemView['status']; cursor?: string; limit: number },
): Promise<{ batch: BatchView; items: ItemView[]; hasMore: boolean }> {
  const batch = await batchView(db, id);
  const rows = await db.invitation.findMany({
    where: {
      batchId: id,
      ...(options.status ? { status: options.status } : {}),
      ...(options.cursor ? { id: { gt: options.cursor } } : {}),
    },
    include: { sourceIdentity: { select: identityFields } },
    orderBy: { id: 'asc' },
    take: options.limit + 1,
  });
  const page = rows.slice(0, options.limit);
  const mappings = new Map(
    (
      await db.identityMapping.findMany({
        where: {
          routeId: batch.routeId,
          sourceIdentityId: { in: page.map((r) => r.sourceIdentityId) },
        },
        select: { id: true, sourceIdentityId: true },
      })
    ).map((m) => [m.sourceIdentityId, m.id]),
  );
  const suggestions = await suggestionsFor(
    db,
    batch.routeId,
    page.filter((r) => r.status === 'sent'),
  );
  return {
    batch,
    hasMore: rows.length > options.limit,
    items: page.map((r) => ({
      id: r.id,
      status: r.status,
      email: r.email,
      teamSlugs: r.teamSlugs,
      source: r.sourceIdentity,
      error: r.error,
      deselectReason: r.deselectReason,
      sentAt: iso(r.sentAt),
      providerIdKnown: r.providerInvitationId !== null,
      mappingId: mappings.get(r.sourceIdentityId) ?? null,
      suggestions: suggestions.get(r.id) ?? [],
    })),
  };
}

/**
 * AUTH-060 step 5.2: members of the target that appeared after an invitation was sent and are not
 * confirmed for anyone yet are offered for it, an e-mail match first. Only an operator confirms.
 */
async function suggestionsFor(
  db: Db,
  routeId: string,
  sent: readonly { id: string; email: string; sentAt: Date | null }[],
): Promise<Map<string, IdentityRef[]>> {
  const out = new Map<string, IdentityRef[]>();
  if (sent.length === 0) return out;
  const route = await db.route.findUnique({
    where: { id: routeId },
    select: { targetEndpointId: true },
  });
  if (!route) return out;
  const earliest = sent.reduce(
    (min, i) => (i.sentAt && i.sentAt < min ? i.sentAt : min),
    sent[0]?.sentAt ?? new Date(0),
  );
  const taken = new Set(
    (
      await db.identityMapping.findMany({
        where: { routeId, status: 'confirmed', targetIdentityId: { not: null } },
        select: { targetIdentityId: true },
      })
    ).map((m) => m.targetIdentityId),
  );
  const fresh = (
    await db.identity.findMany({
      where: {
        endpointId: route.targetEndpointId,
        isMember: true,
        kind: 'user',
        createdAt: { gte: earliest },
      },
      select: { ...identityFields, createdAt: true },
      orderBy: { id: 'asc' },
      take: SUGGESTION_POOL,
    })
  ).filter((m) => !taken.has(m.id));
  for (const item of sent) {
    const email = item.email.toLowerCase();
    const mine = fresh
      .filter((m) => !item.sentAt || m.createdAt >= item.sentAt)
      .sort(
        (a, b) =>
          Number(b.email?.toLowerCase() === email) - Number(a.email?.toLowerCase() === email),
      )
      .slice(0, MAX_SUGGESTIONS)
      .map(({ createdAt: _created, ...ref }) => ref);
    out.set(item.id, mine);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Candidates

export interface CandidateView {
  identity: IdentityRef;
  /** Target team slugs the person would join (AUTH-060 step 1). */
  teamSlugs: string[];
}

interface RouteInfo {
  id: string;
  sourceEndpointId: string;
  targetEndpointId: string;
}

async function loadRoute(db: Pick<Db, 'route'>, routeId: string): Promise<RouteInfo> {
  const route = await db.route.findUnique({
    where: { id: routeId },
    select: { id: true, sourceEndpointId: true, targetEndpointId: true },
  });
  if (!route) throw new ProblemError('not_found');
  return route;
}

/** Target team slug per source Identity: confirmed teams by their slug, others by the planned one. */
async function teamSlugsByIdentity(db: Tx, route: RouteInfo): Promise<Map<string, string[]>> {
  const [groups, mappings] = await Promise.all([
    db.group.findMany({
      where: { endpointId: route.sourceEndpointId },
      select: { id: true, memberIds: true },
    }),
    db.groupMapping.findMany({
      where: { routeId: route.id, status: { not: 'excluded' } },
      select: {
        sourceGroupId: true,
        status: true,
        plannedSlug: true,
        targetGroup: { select: { slug: true } },
      },
    }),
  ]);
  const slugOf = new Map(
    mappings.map((m) => [
      m.sourceGroupId,
      m.status === 'confirmed' && m.targetGroup ? m.targetGroup.slug : m.plannedSlug,
    ]),
  );
  const out = new Map<string, Set<string>>();
  for (const g of groups) {
    const slug = slugOf.get(g.id);
    if (!slug) continue;
    for (const member of g.memberIds) {
      const set = out.get(member) ?? new Set<string>();
      set.add(slug);
      out.set(member, set);
    }
  }
  return new Map([...out].map(([id, set]) => [id, [...set].sort()]));
}

/**
 * Source Identities that can be invited: a known e-mail, a human, a mapping that is `unmapped`
 * (or none yet), and not in another open batch. This is the `invitationCandidates` of the route
 * index (ADR-0311) minus what a batch already holds.
 */
async function candidates(
  db: Tx,
  route: RouteInfo,
  filter?: { query?: string; ids?: readonly string[] },
): Promise<Array<IdentityRef & { teamSlugs: string[] }>> {
  const q = filter?.query?.trim();
  const identities = await db.identity.findMany({
    where: {
      endpointId: route.sourceEndpointId,
      kind: 'user',
      email: { not: null },
      ...(filter?.ids ? { id: { in: [...filter.ids] } } : {}),
      ...(q
        ? {
            OR: [
              { login: { contains: q, mode: 'insensitive' } },
              { displayName: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    select: identityFields,
    orderBy: { id: 'asc' },
  });
  if (identities.length === 0) return [];
  const [mappings, held, slugs] = await Promise.all([
    db.identityMapping.findMany({
      where: { routeId: route.id },
      select: { sourceIdentityId: true, status: true },
    }),
    // Outstanding items in the target organization, on every Route that targets it: selected (can
    // still be sent), sent or unknown (the provider may hold it).
    db.invitation.findMany({
      where: { targetEndpointId: route.targetEndpointId, status: { in: [...OUTSTANDING] } },
      select: { sourceIdentityId: true, emailNormalised: true },
    }),
    teamSlugsByIdentity(db, route),
  ]);
  const status = new Map(mappings.map((m) => [m.sourceIdentityId, m.status]));
  const heldIds = new Set(held.map((h) => h.sourceIdentityId));
  const heldAddresses = new Set(held.map((h) => h.emailNormalised));
  return identities
    .filter((i) => {
      if (!i.email?.trim() || heldIds.has(i.id) || heldAddresses.has(normaliseEmail(i.email))) {
        return false;
      }
      // No mapping row yet is not invitable either: inventory creates the row first.
      return status.get(i.id) === 'unmapped';
    })
    .map((i) => ({ ...i, teamSlugs: slugs.get(i.id) ?? [] }));
}

export async function listCandidates(
  db: Db,
  routeId: string,
  options: { query?: string; cursor?: string; limit: number },
): Promise<{ rows: CandidateView[]; hasMore: boolean }> {
  const route = await loadRoute(db, routeId);
  const all = await candidates(db, route, options.query ? { query: options.query } : undefined);
  const after = options.cursor ? all.filter((c) => c.id > (options.cursor as string)) : all;
  const page = after.slice(0, options.limit);
  return {
    rows: page.map(({ teamSlugs, ...identity }) => ({ identity, teamSlugs })),
    hasMore: after.length > options.limit,
  };
}

// ---------------------------------------------------------------------------------------------
// Commands

export interface Decision {
  readonly actorId: string;
  readonly now?: Date;
}

/** AUTH-060 step 1 and 2: a draft batch from candidates (all, or the ones named). */
export async function createBatch(
  db: Writer,
  routeId: string,
  body: { identityIds?: readonly string[] | undefined; all?: boolean | undefined },
  by: Decision,
): Promise<BatchView> {
  const ids = body.identityIds ? [...new Set(body.identityIds)] : undefined;
  if (!body.all && (!ids || ids.length === 0)) {
    throw invalid('identityIds', 'name the Identities to invite, or ask for all candidates');
  }
  if (body.all && ids && ids.length > 0) {
    throw invalid('all', 'give identityIds or all, not both');
  }
  const batchId = await db.privileged.$transaction(async (tx) => {
    const now = by.now ?? new Date();
    const head = await loadRoute(tx, routeId);
    await lockScope(tx, [head.targetEndpointId], routeId);
    const route = await loadRoute(tx, routeId);
    if (route.targetEndpointId !== head.targetEndpointId) {
      throw conflict('the Route changed its target meanwhile; try again');
    }
    const all = await candidates(tx, route, ids ? { ids } : undefined);
    // One invitation per address: two people sharing one are never in the same batch.
    const seen = new Set<string>();
    const duplicates: string[] = [];
    const found = all.filter((c) => {
      const key = normaliseEmail(c.email as string);
      if (seen.has(key)) {
        duplicates.push(c.id);
        return false;
      }
      seen.add(key);
      return true;
    });
    if (ids && duplicates.length > 0) {
      throw new ProblemError('validation_failed', {
        errors: duplicates.slice(0, 20).map((id) => ({
          path: `identityIds.${id}`,
          message: 'shares an e-mail address with another person in this batch',
        })),
      });
    }
    if (ids) {
      const ok = new Set(found.map((c) => c.id));
      const bad = ids.filter((id) => !ok.has(id));
      if (bad.length > 0) {
        const named = bad.slice(0, 20);
        const people = await tx.identity.findMany({
          where: { id: { in: named } },
          select: { id: true, email: true },
        });
        const emailOf = new Map(people.map((p) => [p.id, p.email]));
        const errors = [];
        for (const id of named) {
          const email = emailOf.get(id);
          // A person or address another batch holds (on this Route or another one with the same
          // target) is named with that batch, so the operator can find it.
          const held = email
            ? await holder(tx, route.targetEndpointId, { id: '', sourceIdentityId: id, email })
            : null;
          errors.push({
            path: `identityIds.${id}`,
            message: held
              ? heldText(held)
              : 'not an invitation candidate (no e-mail, already decided, or in another batch)',
          });
        }
        throw new ProblemError('validation_failed', { errors });
      }
    }
    if (found.length === 0) throw conflict('there are no invitation candidates');
    if (found.length > MAX_BATCH_ITEMS) {
      throw invalid('identityIds', `a batch holds at most ${MAX_BATCH_ITEMS} entries`);
    }
    const batch = await tx.invitationBatch.create({
      data: {
        routeId,
        createdById: by.actorId,
        seatPreview: {
          toInvite: found.length,
          seatsTotal: null,
          seatsFilled: null,
          seatsReadAt: null,
        },
      },
    });
    for (const part of chunks(found)) {
      await tx.invitation.createMany({
        data: part.map((c) => ({
          batchId: batch.id,
          sourceIdentityId: c.id,
          email: (c.email as string).trim(),
          teamSlugs: c.teamSlugs,
        })),
      });
    }
    await audit(tx, by.actorId, 'invitation-batch.create', batch.id, {
      routeId,
      items: found.length,
    });
    await announce(tx, batch.id, now);
    return batch.id;
  });
  return batchView(db.privileged, batchId);
}

/** The item with its mapping, for select and deselect. */
async function loadItem(tx: Tx, batchId: string, itemId: string) {
  const item = await tx.invitation.findUnique({
    where: { id: itemId },
    include: { sourceIdentity: { select: { id: true, providerId: true } } },
  });
  if (!item || item.batchId !== batchId) throw new ProblemError('not_found');
  return item;
}

async function setToInvite(tx: Tx, batchId: string): Promise<void> {
  const selected = await tx.invitation.count({ where: { batchId, status: 'selected' } });
  const batch = await tx.invitationBatch.findUniqueOrThrow({
    where: { id: batchId },
    select: { seatPreview: true },
  });
  const preview = (
    batch.seatPreview && typeof batch.seatPreview === 'object' ? batch.seatPreview : {}
  ) as Record<string, string | number | boolean | null>;
  await tx.invitationBatch.update({
    where: { id: batchId },
    data: { seatPreview: { ...preview, toInvite: selected } },
  });
}

/**
 * AUTH-060 step 3: removes an entry from the batch. The reason is required and an
 * `identity_excluded` Expected Difference (AUTH-050 step 4) is created for the person, linked to
 * the item, so they are not counted against parity. A person who is already decided (mapped,
 * excluded) needs no such difference, so none is created for them.
 */
export async function deselectItem(
  db: Writer,
  batchId: string,
  itemId: string,
  reason: string,
  by: Decision,
): Promise<ItemView['status']> {
  const text = reason.trim();
  if (text === '' || text.length > MAX_REASON) {
    throw invalid('reason', `a reason of 1 to ${MAX_REASON} characters is required`);
  }
  return db.privileged.$transaction(async (tx) => {
    const now = by.now ?? new Date();
    const batch = await lockedBatch(tx, batchId);
    if (batch.status !== 'draft')
      throw conflict('the batch is approved; its entries cannot change');
    const item = await loadItem(tx, batchId, itemId);
    if (item.status === 'deselected') return 'deselected' as const;
    if (item.status !== 'selected') throw conflict('only a selected entry can be deselected');
    const mapping = await tx.identityMapping.findFirst({
      where: { routeId: batch.routeId, sourceIdentityId: item.sourceIdentityId },
      select: { id: true, status: true },
    });
    await tx.invitation.update({
      where: { id: itemId },
      data: { status: 'deselected', deselectReason: text },
    });
    if (mapping && (INVITABLE as readonly string[]).includes(mapping.status)) {
      const data = exclusionPatterns(item.sourceIdentity.providerId).map((p) => ({
        routeId: batch.routeId,
        migrationId: null,
        identityMappingId: mapping.id,
        invitationId: itemId,
        facetKey: p.facetKey,
        path: p.path,
        reason: 'identity_excluded' as const,
        note: text,
        createdById: by.actorId,
      }));
      await tx.expectedDifference.createMany({ data });
      await supersedeParityChecks(tx, { routeId: batch.routeId });
    }
    await setToInvite(tx, batchId);
    await audit(tx, by.actorId, 'invitation.deselect', batchId, { itemId, reason: text });
    await announce(tx, batchId, now);
    return 'deselected' as const;
  });
}

/** Reselecting revokes the deselection's Expected Differences (AUTH-060 step 3). */
export async function selectItem(
  db: Writer,
  batchId: string,
  itemId: string,
  by: Decision,
): Promise<ItemView['status']> {
  return db.privileged.$transaction(async (tx) => {
    const now = by.now ?? new Date();
    const batch = await lockedBatch(tx, batchId);
    if (batch.status !== 'draft')
      throw conflict('the batch is approved; its entries cannot change');
    const item = await loadItem(tx, batchId, itemId);
    if (item.status === 'selected') return 'selected' as const;
    if (item.status !== 'deselected') throw conflict('only a deselected entry can be selected');
    const mapping = await tx.identityMapping.findFirst({
      where: { routeId: batch.routeId, sourceIdentityId: item.sourceIdentityId },
      select: { status: true },
    });
    if (!mapping || !(INVITABLE as readonly string[]).includes(mapping.status)) {
      throw conflict(`the person is ${mapping?.status ?? 'unmapped'} now and cannot be invited`);
    }
    if (item.targetEndpointId !== batch.targetEndpointId) {
      throw conflict('the Route moved to another target; draft a new batch');
    }
    const held = await holder(tx, batch.targetEndpointId, item);
    if (held) throw conflict(heldText(held));
    await tx.invitation.update({
      where: { id: itemId },
      data: { status: 'selected', deselectReason: null },
    });
    const revoked = await tx.expectedDifference.updateMany({
      where: { invitationId: itemId, reason: 'identity_excluded', revokedAt: null },
      data: { revokedAt: now },
    });
    if (revoked.count > 0) await supersedeParityChecks(tx, { routeId: batch.routeId });
    await setToInvite(tx, batchId);
    await audit(tx, by.actorId, 'invitation.select', batchId, { itemId });
    await announce(tx, batchId, now);
    return 'selected' as const;
  });
}

/**
 * AUTH-060 step 4: approval records the approver. Entries whose person was decided meanwhile
 * (mapped, excluded, already invited) are dropped from the batch with that reason, without an
 * exclusion. `expectedCount` is what the operator confirmed; a different final count is a 409 and
 * nothing changes. The caller enqueues the send step after this commits.
 */
export async function approveBatch(
  db: Writer,
  batchId: string,
  body: { expectedCount?: number | undefined; expectedToken: string },
  by: Decision,
): Promise<{ approved: number; dropped: number }> {
  return db.privileged.$transaction(async (tx) => {
    const now = by.now ?? new Date();
    const batch = await lockedBatch(tx, batchId);
    if (batch.status !== 'draft') throw conflict('the batch is already approved');
    const selected = await tx.invitation.findMany({
      where: { batchId, status: 'selected' },
      select: { id: true, sourceIdentityId: true, targetEndpointId: true },
    });
    // What the operator reviewed: the selected entries themselves, not only how many there are.
    if (body.expectedToken !== selectionToken(selected.map((s) => s.id))) {
      throw conflict('the batch changed since it was reviewed; review it again');
    }
    const mappings = await tx.identityMapping.findMany({
      where: {
        routeId: batch.routeId,
        sourceIdentityId: { in: selected.map((s) => s.sourceIdentityId) },
      },
      select: { sourceIdentityId: true, status: true },
    });
    const status = new Map(mappings.map((m) => [m.sourceIdentityId, m.status]));
    // A person who is not `unmapped` now (or has no mapping) is dropped, with the reason; so is an
    // entry drafted for the organization the Route targeted before it moved.
    const reasonOf = (s: (typeof selected)[number]): string | null => {
      if (s.targetEndpointId !== batch.targetEndpointId) return 'target changed';
      const st = status.get(s.sourceIdentityId);
      return st !== undefined && (INVITABLE as readonly string[]).includes(st)
        ? null
        : (st ?? 'mapping_missing');
    };
    const dropped = selected.filter((s) => reasonOf(s) !== null);
    const approved = selected.length - dropped.length;
    if (approved === 0) throw conflict('there is nothing to approve: no entry is selected');
    if (body.expectedCount !== undefined && body.expectedCount !== approved) {
      throw conflict(
        `the final count is ${approved}, not ${body.expectedCount}; review the batch again`,
      );
    }
    for (const item of dropped) {
      await tx.invitation.update({
        where: { id: item.id },
        data: {
          status: 'deselected',
          deselectReason: `no longer a candidate (${reasonOf(item)})`,
        },
      });
    }
    const preview = (
      batch.seatPreview && typeof batch.seatPreview === 'object' ? batch.seatPreview : {}
    ) as Record<string, string | number | boolean | null>;
    // The conditional update is the second guard against two approvals at once (the row lock is
    // the first): only a draft batch becomes approved, and only once.
    const moved = await tx.invitationBatch.updateMany({
      where: { id: batchId, status: 'draft' },
      data: {
        status: 'approved',
        approvedById: by.actorId,
        approvedAt: now,
        seatPreview: { ...preview, toInvite: approved },
      },
    });
    if (moved.count !== 1) throw conflict('the batch is already approved');
    await audit(tx, by.actorId, 'invitation-batch.approve', batchId, {
      approved,
      dropped: dropped.length,
    });
    await announce(tx, batchId, now);
    return { approved, dropped: dropped.length };
  });
}

/** Checks that an item can be revoked; the job does the provider call. */
export async function checkRevocable(db: Writer, batchId: string, itemId: string): Promise<void> {
  await db.privileged.$transaction(async (tx) => {
    const item = await loadItem(tx, batchId, itemId);
    if (item.status !== 'sent') throw conflict('only a sent invitation can be revoked');
  });
}

/** Written after the revoke step is queued, so a refused request leaves no trace of an action. */
export async function auditRevoke(
  db: Writer,
  batchId: string,
  itemId: string,
  by: Decision,
): Promise<void> {
  await db.privileged.$transaction(async (tx) => {
    await audit(tx, by.actorId, 'invitation.revoke', batchId, { itemId });
  });
}

/**
 * The two unique indexes are the last guard against a second outstanding invitation for a person
 * or an address (AUTH-061). A write that reaches one answers 409, not a server error.
 */
export async function asConflict<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth++) {
      const e = current as Record<string, unknown>;
      const text = `${String(e.constraint ?? '')} ${String(e.message ?? '')}`;
      if (
        (e.code === '23505' || e.dbErrorCode === '23505') &&
        text.includes('invitation_outstanding')
      ) {
        throw conflict('the person or the address is already in another outstanding invitation');
      }
      current = e.cause;
    }
    throw error;
  }
}

/**
 * An operator settles an `unknown` entry (the system could not rule out that the provider holds an
 * invitation, so the person and the address stayed held): `invited` makes it `sent` (provider id
 * unknown; the inventory correlation links the invitee later), `not_invited` frees the person.
 */
export async function resolveItem(
  db: Writer,
  batchId: string,
  itemId: string,
  outcome: 'invited' | 'not_invited',
  by: Decision,
): Promise<ItemView['status']> {
  return db.privileged.$transaction(async (tx) => {
    const now = by.now ?? new Date();
    // The entry's organization (fixed when it was drafted) is locked too, in case the Route moved.
    const target = await tx.invitation.findUnique({
      where: { id: itemId },
      select: { targetEndpointId: true },
    });
    const batch = await lockedBatch(tx, batchId, target ? [target.targetEndpointId] : []);
    const item = await loadItem(tx, batchId, itemId);
    if (item.status !== 'unknown')
      throw conflict('only an entry with an unknown outcome can be resolved');
    let staleNow = false;
    if (outcome === 'invited') {
      await tx.invitation.update({
        where: { id: itemId },
        data: { status: 'sent', sentAt: now, error: null },
      });
    } else {
      await tx.invitation.update({
        where: { id: itemId },
        data: { status: 'failed', error: 'resolved_not_invited' },
      });
      const moved = await tx.identityMapping.updateMany({
        where: {
          routeId: batch.routeId,
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
      if (moved.count > 0) staleNow = (await markRouteAnalysesStale(tx, batch.routeId)) > 0;
    }
    await audit(tx, by.actorId, 'invitation.resolve', batchId, { itemId, outcome });
    await announce(tx, batchId, now, staleNow);
    return outcome === 'invited' ? ('sent' as const) : ('failed' as const);
  });
}
