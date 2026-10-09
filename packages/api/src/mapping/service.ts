import { type Db, type DbHandle, publishEventIn } from '@git-migrator/db';
import { invitationTargetLockKey } from '@git-migrator/jobs';
import { ProblemError } from '../problem.ts';
import { type CsvErrorCode, parseMappingCsv } from './csv.ts';
import { exclusionPatterns } from './expected-differences.ts';
import { type ResolvedRow, resolveRows } from './resolve.ts';
import { markRouteAnalysesStale } from './stale.ts';

/** Waits the Route lock and statements may take; tests shorten them. */
export const MAPPING_TIMEOUTS = { lockMs: 15_000, statementMs: 60_000 };

/**
 * Rows per bulk statement. PostgreSQL allows 65,535 bind parameters per statement; the widest
 * table written here has about 14 columns per row, so 2,000 rows stay under 30,000.
 */
const BULK_ROWS = 2000;

function* chunks<T>(items: readonly T[], size = BULK_ROWS): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/** Longest exclusion reason, in characters. */
export const MAX_REASON = 500;
/** Reason recorded for exclusions made by a CSV import (the file has no reason column). */
export const CSV_EXCLUSION_REASON = 'Excluded by CSV import';

/** What the mapping code uses of a client or a transaction client (both satisfy it). */
type Tx = Pick<
  Db,
  | 'identity'
  | 'identityMapping'
  | 'invitation'
  | 'group'
  | 'groupMapping'
  | 'route'
  | 'migration'
  | 'expectedDifference'
  | 'auditEvent'
  | '$executeRaw'
  | '$queryRaw'
>;

/** A JSON object as the audit log stores it. */
type AuditData = { [key: string]: string | number | boolean | null | AuditData };

export type Writer = Pick<DbHandle, 'privileged'>;

interface RouteInfo {
  readonly id: string;
  readonly sourceEndpointId: string;
  readonly targetEndpointId: string;
}

const invalid = (path: string, message: string): ProblemError =>
  new ProblemError('validation_failed', { errors: [{ path, message }] });

/** Serializes mapping writes of one Route, so uniqueness checks see committed state. */
async function lockRoute(tx: Tx, routeId: string): Promise<void> {
  const key = `identity-mapping:${routeId}`;
  // Bounded waits: a stuck writer must not hold requests forever.
  const lockMs = String(MAPPING_TIMEOUTS.lockMs);
  const statementMs = String(MAPPING_TIMEOUTS.statementMs);
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${lockMs}, true), set_config('statement_timeout', ${statementMs}, true)`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`;
}

async function loadRoute(tx: Tx, routeId: string): Promise<RouteInfo> {
  const route = await tx.route.findUnique({
    where: { id: routeId },
    select: { id: true, sourceEndpointId: true, targetEndpointId: true },
  });
  if (!route) throw new ProblemError('not_found');
  return route;
}

/** The human-readable note of an exclusion's Expected Differences; the link is `identityMappingId`. */
const exclusionNote = (reason: string): string => reason;

/** Revokes the `identity_excluded` Expected Differences an exclusion created (reselect/unmap). */
async function revokeExclusions(tx: Tx, mappingIds: readonly string[], now: Date): Promise<number> {
  if (mappingIds.length === 0) return 0;
  let count = 0;
  for (const part of chunks(mappingIds, 10_000)) {
    const result = await tx.expectedDifference.updateMany({
      where: {
        reason: 'identity_excluded',
        revokedAt: null,
        identityMappingId: { in: part },
      },
      data: { revokedAt: now },
    });
    count += result.count;
  }
  return count;
}

interface ExclusionRequest {
  readonly mappingId: string;
  /** Provider ids of the principals to cover: the source Identity and a former target. */
  readonly principalIds: readonly string[];
  readonly reason: string;
}

/**
 * Creates the Route-scoped `identity_excluded` Expected Differences of exclusions (AUTH-050 step
 * 4), linked to their mapping. They cover the source Identity's Provider id and, when the mapping
 * had a target, the target's, because a diff names the principal as its document does.
 */
async function createExclusions(
  tx: Tx,
  route: RouteInfo,
  requests: readonly ExclusionRequest[],
  actorId: string,
): Promise<void> {
  const data = requests.flatMap((request) =>
    [...new Set(request.principalIds)].flatMap((principalId) =>
      exclusionPatterns(principalId).map((p) => ({
        routeId: route.id,
        migrationId: null,
        identityMappingId: request.mappingId,
        facetKey: p.facetKey,
        path: p.path,
        reason: 'identity_excluded' as const,
        note: exclusionNote(request.reason),
        createdById: actorId,
      })),
    ),
  );
  for (const part of chunks(data)) await tx.expectedDifference.createMany({ data: part });
}

async function audit(
  tx: Tx,
  actorId: string,
  action: string,
  subjectType: string,
  subjectId: string,
  data: AuditData,
): Promise<void> {
  await tx.auditEvent.create({ data: { actorId, action, subjectType, subjectId, data } });
}

/** Marks the Route's Analyses stale and tells list views (JOB-060) when any changed. */
async function afterChange(tx: Tx, routeId: string): Promise<void> {
  const marked = await markRouteAnalysesStale(tx, routeId);
  if (marked > 0) {
    // No mapping topic exists (ADR-0270); the Migration lists are what changed. One event without
    // ids reaches `list:migrations` only, whatever the number of Migrations.
    await publishEventIn(tx, { type: 'migration.updated', ids: {}, at: new Date().toISOString() });
  }
}

// ---------------------------------------------------------------------------------------------
// Views

const identityFields = {
  id: true,
  providerId: true,
  login: true,
  displayName: true,
  email: true,
} as const;

export interface IdentityRef {
  id: string;
  providerId: string;
  login: string | null;
  displayName: string | null;
  email: string | null;
}

export interface IdentityMappingView {
  id: string;
  status: 'suggested' | 'confirmed' | 'excluded' | 'pending_invite' | 'unmapped';
  method: string | null;
  confidence: number | null;
  decidedAt: string | null;
  decidedBy: string | null;
  /** The reason of an exclusion, from its Expected Differences. */
  reason: string | null;
  source: IdentityRef;
  target: IdentityRef | null;
}

interface MappingRow {
  id: string;
  status: IdentityMappingView['status'];
  method: string | null;
  confidence: number | null;
  decidedAt: Date | null;
  decidedBy: { displayName: string } | null;
  sourceIdentity: IdentityRef;
  targetIdentity: IdentityRef | null;
}

const mappingInclude = {
  sourceIdentity: { select: identityFields },
  targetIdentity: { select: identityFields },
  decidedBy: { select: { displayName: true } },
} as const;

function toView(row: MappingRow, reason: string | null): IdentityMappingView {
  return {
    id: row.id,
    status: row.status,
    method: row.method,
    confidence: row.confidence,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decidedBy: row.decidedBy?.displayName ?? null,
    reason,
    source: row.sourceIdentity,
    target: row.targetIdentity,
  };
}

export interface ListIdentityOptions {
  readonly status?: IdentityMappingView['status'];
  readonly query?: string;
  readonly cursor?: string;
  readonly limit: number;
}

/** A page of the Route's Identity Mappings, ordered by id (a time-ordered uuid). */
export async function listIdentityMappings(
  db: Db,
  routeId: string,
  options: ListIdentityOptions,
): Promise<{ rows: IdentityMappingView[]; hasMore: boolean }> {
  await loadRoute(db, routeId);
  const q = options.query?.trim();
  const rows = (await db.identityMapping.findMany({
    where: {
      routeId,
      ...(options.status ? { status: options.status } : {}),
      ...(options.cursor ? { id: { gt: options.cursor } } : {}),
      ...(q
        ? {
            sourceIdentity: {
              OR: [
                { login: { contains: q, mode: 'insensitive' } },
                { displayName: { contains: q, mode: 'insensitive' } },
                { email: { contains: q, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    },
    include: mappingInclude,
    orderBy: { id: 'asc' },
    take: options.limit + 1,
  })) as unknown as MappingRow[];
  const page = rows.slice(0, options.limit);
  const excluded = page.filter((r) => r.status === 'excluded').map((r) => r.id);
  const reasons = new Map<string, string | null>();
  if (excluded.length > 0) {
    const eds = await db.expectedDifference.findMany({
      where: {
        routeId,
        reason: 'identity_excluded',
        revokedAt: null,
        identityMappingId: { in: excluded },
      },
      select: { identityMappingId: true, note: true },
    });
    for (const ed of eds) {
      if (ed.identityMappingId) reasons.set(ed.identityMappingId, ed.note);
    }
  }
  return {
    rows: page.map((r) => toView(r, reasons.get(r.id) ?? null)),
    hasMore: rows.length > options.limit,
  };
}

async function viewOf(tx: Tx, mappingId: string): Promise<IdentityMappingView> {
  const row = (await tx.identityMapping.findUniqueOrThrow({
    where: { id: mappingId },
    include: mappingInclude,
  })) as unknown as MappingRow;
  let reason: string | null = null;
  if (row.status === 'excluded') {
    const ed = await tx.expectedDifference.findFirst({
      where: {
        reason: 'identity_excluded',
        revokedAt: null,
        identityMappingId: mappingId,
      },
      select: { note: true },
    });
    reason = ed?.note ?? null;
  }
  return toView(row, reason);
}

// ---------------------------------------------------------------------------------------------
// Decisions

async function loadMapping(tx: Tx, route: RouteInfo, mappingId: string) {
  const mapping = await tx.identityMapping.findUnique({
    where: { id: mappingId },
    include: { sourceIdentity: { select: { providerId: true } } },
  });
  if (!mapping || mapping.routeId !== route.id) throw new ProblemError('not_found');
  return mapping;
}

export interface Decision {
  readonly actorId: string;
  readonly now?: Date;
}

/**
 * Confirming can change the person's invitation entries (accept them, or hold an in-flight one as
 * `unknown`), so it takes the invitation locks of their target organizations first: the lock order
 * of ADR-0370 is target Endpoint locks, then the Route lock. The Route's target and the entries'
 * targets are immutable or fixed at creation, so reading them before locking is safe.
 */
async function lockInvitationTargets(tx: Tx, routeId: string, mappingId: string): Promise<void> {
  const [route, mapping] = await Promise.all([
    tx.route.findUnique({ where: { id: routeId }, select: { targetEndpointId: true } }),
    tx.identityMapping.findUnique({ where: { id: mappingId }, select: { sourceIdentityId: true } }),
  ]);
  if (!route || !mapping) return;
  const entries = await tx.invitation.findMany({
    where: { routeId, sourceIdentityId: mapping.sourceIdentityId },
    select: { targetEndpointId: true },
    distinct: ['targetEndpointId'],
  });
  const targets = [...new Set([route.targetEndpointId, ...entries.map((e) => e.targetEndpointId)])];
  const lockMs = String(MAPPING_TIMEOUTS.lockMs);
  const statementMs = String(MAPPING_TIMEOUTS.statementMs);
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${lockMs}, true), set_config('statement_timeout', ${statementMs}, true)`;
  for (const target of targets.sort()) {
    const key = invitationTargetLockKey(target);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`;
  }
}

/** Confirms a mapping: the suggested target, or `targetIdentityId` chosen by the operator. */
export async function confirmIdentityMapping(
  db: Writer,
  routeId: string,
  mappingId: string,
  body: { targetIdentityId?: string | undefined },
  by: Decision,
): Promise<IdentityMappingView> {
  return db.privileged.$transaction(async (tx) => {
    const now = by.now ?? new Date();
    await lockInvitationTargets(tx, routeId, mappingId);
    await lockRoute(tx, routeId);
    const route = await loadRoute(tx, routeId);
    const mapping = await loadMapping(tx, route, mappingId);
    const targetId = body.targetIdentityId ?? mapping.targetIdentityId;
    if (!targetId) throw invalid('targetIdentityId', 'a target Identity is required');
    const target = await tx.identity.findUnique({
      where: { id: targetId },
      select: { id: true, endpointId: true },
    });
    if (!target || target.endpointId !== route.targetEndpointId) {
      throw invalid('targetIdentityId', 'not an Identity of the Route target');
    }
    const taken = await tx.identityMapping.findFirst({
      where: {
        routeId,
        status: 'confirmed',
        targetIdentityId: targetId,
        id: { not: mappingId },
      },
      select: { id: true },
    });
    if (taken) {
      throw new ProblemError('conflict', {
        detail: 'the target Identity is already confirmed for another source Identity',
      });
    }
    const unchangedTarget = mapping.targetIdentityId === targetId;
    // Nothing to change: no write, no audit event, no staleness, no event.
    if (mapping.status === 'confirmed' && unchangedTarget) return viewOf(tx, mappingId);
    if (mapping.status === 'pending_invite') {
      // Lock order (ADR-0370): batch rows, then invitation rows, then the mapping row.
      await tx.$queryRaw`SELECT b.id FROM app.invitation_batch b
        WHERE b.id IN (SELECT i.batch_id FROM app.invitation i
                        WHERE i.route_id = ${routeId} AND i.source_identity_id = ${mapping.sourceIdentityId})
        ORDER BY b.id FOR NO KEY UPDATE`;
      await tx.$queryRaw`SELECT id FROM app.invitation
        WHERE route_id = ${routeId} AND source_identity_id = ${mapping.sourceIdentityId}
        ORDER BY id FOR UPDATE`;
    }
    await tx.identityMapping.update({
      where: { id: mappingId },
      data: {
        status: 'confirmed',
        targetIdentityId: targetId,
        // Confirming the suggestion keeps how it was found; a chosen target is a manual decision.
        method: unchangedTarget && mapping.method ? mapping.method : 'manual',
        confidence: unchangedTarget ? mapping.confidence : null,
        decidedById: by.actorId,
        decidedAt: now,
      },
    });
    await revokeExclusions(tx, [mappingId], now);
    if (mapping.status === 'pending_invite') {
      // An operator linked the invitee (AUTH-060 step 5.2): the invitation was accepted.
      await tx.invitation.updateMany({
        where: {
          sourceIdentityId: mapping.sourceIdentityId,
          status: { in: ['sent', 'unknown'] },
          batch: { routeId },
        },
        data: { status: 'accepted' },
      });
      // An entry whose send started but was never recorded may still reach (or have reached) the
      // provider: it is not freed but becomes `unknown`, holding the address until an operator
      // resolves it (AUTH-061). The send job only works on `selected` entries, so it stops there.
      await tx.invitation.updateMany({
        where: {
          sourceIdentityId: mapping.sourceIdentityId,
          status: 'selected',
          sendStartedAt: { not: null },
          batch: { routeId },
        },
        data: { status: 'unknown', error: 'mapping_confirmed' },
      });
    }
    await audit(tx, by.actorId, 'identity-mapping.confirm', 'identity_mapping', mappingId, {
      status: { from: mapping.status, to: 'confirmed' },
      targetIdentityId: { from: mapping.targetIdentityId, to: targetId },
    });
    await afterChange(tx, routeId);
    return viewOf(tx, mappingId);
  });
}

/** Excludes the source Identity with a reason; creates its `identity_excluded` differences. */
export async function excludeIdentityMapping(
  db: Writer,
  routeId: string,
  mappingId: string,
  reason: string,
  by: Decision,
): Promise<IdentityMappingView> {
  const text = reason.trim();
  if (text === '' || text.length > MAX_REASON) {
    throw invalid('reason', `a reason of 1 to ${MAX_REASON} characters is required`);
  }
  return db.privileged.$transaction(async (tx) => {
    const now = by.now ?? new Date();
    await lockRoute(tx, routeId);
    const route = await loadRoute(tx, routeId);
    const mapping = await loadMapping(tx, route, mappingId);
    if (mapping.status === 'pending_invite') {
      // An invitation is out: revoke it in its batch first (AUTH-060), as `unmap` requires.
      throw new ProblemError('revoke_first', {
        detail: 'an invitation is pending for this Identity; revoke it in the invitation batch',
      });
    }
    if (mapping.status === 'excluded') {
      const current = await tx.expectedDifference.findFirst({
        where: { identityMappingId: mappingId, reason: 'identity_excluded', revokedAt: null },
        select: { note: true },
      });
      if (current?.note === exclusionNote(text)) return viewOf(tx, mappingId);
    }
    const previousTarget = mapping.targetIdentityId
      ? await tx.identity.findUnique({
          where: { id: mapping.targetIdentityId },
          select: { providerId: true },
        })
      : null;
    await tx.identityMapping.update({
      where: { id: mappingId },
      data: {
        status: 'excluded',
        targetIdentityId: null,
        method: 'manual',
        confidence: null,
        decidedById: by.actorId,
        decidedAt: now,
      },
    });
    await revokeExclusions(tx, [mappingId], now);
    await createExclusions(
      tx,
      route,
      [
        {
          mappingId,
          principalIds: [
            mapping.sourceIdentity.providerId,
            ...(previousTarget ? [previousTarget.providerId] : []),
          ],
          reason: text,
        },
      ],
      by.actorId,
    );
    await audit(tx, by.actorId, 'identity-mapping.exclude', 'identity_mapping', mappingId, {
      status: { from: mapping.status, to: 'excluded' },
      reason: text,
    });
    await afterChange(tx, routeId);
    return viewOf(tx, mappingId);
  });
}

/** Removes the decision: the mapping is `unmapped` again and the matching cascade may suggest. */
export async function unmapIdentityMapping(
  db: Writer,
  routeId: string,
  mappingId: string,
  by: Decision,
): Promise<IdentityMappingView> {
  return db.privileged.$transaction(async (tx) => {
    const now = by.now ?? new Date();
    await lockRoute(tx, routeId);
    const route = await loadRoute(tx, routeId);
    const mapping = await loadMapping(tx, route, mappingId);
    if (mapping.status === 'unmapped') return viewOf(tx, mappingId);
    if (mapping.status === 'pending_invite') {
      // Invitation correlation (AUTH-060 step 5) hangs on this status; revoking an invitation is
      // the invitation flow's decision, not a mapping one.
      throw new ProblemError('conflict', {
        detail: 'an invitation is pending for this Identity; revoke it in the invitation batch',
      });
    }
    await tx.identityMapping.update({
      where: { id: mappingId },
      data: {
        status: 'unmapped',
        targetIdentityId: null,
        method: null,
        confidence: null,
        decidedById: null,
        decidedAt: null,
      },
    });
    await revokeExclusions(tx, [mappingId], now);
    await audit(tx, by.actorId, 'identity-mapping.unmap', 'identity_mapping', mappingId, {
      status: { from: mapping.status, to: 'unmapped' },
    });
    await afterChange(tx, routeId);
    return viewOf(tx, mappingId);
  });
}

// ---------------------------------------------------------------------------------------------
// CSV import

export interface CsvReport {
  readonly dryRun: boolean;
  /** True when the file and every row are valid: an apply would go through. */
  readonly ok: boolean;
  fileErrors: CsvErrorCode[];
  rows: Array<Omit<ResolvedRow, 'plan'>>;
  readonly summary: {
    readonly total: number;
    readonly valid: number;
    readonly invalid: number;
    readonly mapped: number;
    readonly invited: number;
    readonly excluded: number;
    readonly unchanged: number;
    readonly replaced: number;
  };
}

function report(
  dryRun: boolean,
  fileErrors: readonly CsvErrorCode[],
  resolved: readonly ResolvedRow[],
): CsvReport {
  const count = (outcome: string) => resolved.filter((r) => r.outcome === outcome).length;
  const valid = resolved.filter((r) => r.ok).length;
  return {
    dryRun,
    ok: fileErrors.length === 0 && valid === resolved.length,
    fileErrors: [...fileErrors],
    rows: resolved.map(({ plan: _plan, ...row }) => row),
    summary: {
      total: resolved.length,
      valid,
      invalid: resolved.length - valid,
      mapped: count('mapped'),
      replaced: count('replaces_decision'),
      invited: count('invited'),
      excluded: count('excluded'),
      unchanged: count('unchanged'),
    },
  };
}

async function resolveCsv(tx: Tx, route: RouteInfo, text: string) {
  const parsed = parseMappingCsv(text);
  if (parsed.fileErrors.length > 0) {
    return {
      parsed,
      resolved: [] as ResolvedRow[],
      sources: [],
      targets: [],
      mappings: [],
    };
  }
  const [sources, targets, mappings] = await Promise.all([
    tx.identity.findMany({
      where: { endpointId: route.sourceEndpointId },
      select: { id: true, providerId: true, login: true, email: true, emailSource: true },
    }),
    tx.identity.findMany({
      where: { endpointId: route.targetEndpointId },
      select: { id: true, providerId: true, login: true, email: true },
    }),
    tx.identityMapping.findMany({
      where: { routeId: route.id },
      select: { id: true, sourceIdentityId: true, status: true, targetIdentityId: true },
    }),
  ]);
  return {
    parsed,
    resolved: resolveRows(parsed.rows, sources, targets, mappings),
    sources,
    targets,
    mappings,
  };
}

/** `?dryRun=true`: validates and reports per row, writes nothing. */
export async function dryRunCsv(db: Db, routeId: string, text: string): Promise<CsvReport> {
  const route = await loadRoute(db, routeId);
  const { parsed, resolved } = await resolveCsv(db, route, text);
  return report(true, parsed.fileErrors, resolved);
}

/**
 * Applies a CSV import. The file is validated in full first; one bad row rejects everything
 * (422 with the per-row report in `errors`), so a partial import cannot happen.
 */
export async function applyCsv(
  db: Writer,
  routeId: string,
  text: string,
  by: Decision,
): Promise<CsvReport> {
  return db.privileged.$transaction(async (tx) => {
    const now = by.now ?? new Date();
    await lockRoute(tx, routeId);
    const route = await loadRoute(tx, routeId);
    const ctx = await resolveCsv(tx, route, text);
    const { parsed, resolved } = ctx;
    const result = report(false, parsed.fileErrors, resolved);
    if (!result.ok) {
      const errors = [
        ...parsed.fileErrors.map((code) => ({ path: 'file', message: code })),
        ...resolved.flatMap((r) =>
          r.errors.map((code) => ({ path: `line ${r.line}`, message: code })),
        ),
      ].slice(0, 200);
      throw new ProblemError('validation_failed', { errors });
    }
    const providerOf = new Map<string, string>();
    for (const i of ctx.sources) providerOf.set(i.id, i.providerId);
    for (const i of ctx.targets) providerOf.set(i.id, i.providerId);
    const existingBySource = new Map(ctx.mappings.map((m) => [m.sourceIdentityId, m]));

    const audits: Array<{
      actorId: string;
      action: string;
      subjectType: string;
      subjectId: string;
      data: AuditData;
    }> = [];
    const exclusions: ExclusionRequest[] = [];
    const created: Array<{
      sourceIdentityId: string;
      status: 'confirmed' | 'excluded' | 'unmapped';
      targetIdentityId: string | null;
      action: string;
    }> = [];
    const touchedExisting: string[] = [];
    const emailUpdates: Array<{ id: string; email: string }> = [];
    const mappingUpdates: Array<{ id: string; status: string; targetIdentityId: string | null }> =
      [];
    for (const row of resolved) {
      const plan = row.plan;
      if (!plan || row.outcome === 'unchanged') continue;
      const existing = existingBySource.get(plan.sourceIdentityId);
      let status: 'confirmed' | 'excluded' | 'unmapped' | 'pending_invite';
      let targetIdentityId: string | null = null;
      if (plan.action === 'map') {
        status = 'confirmed';
        targetIdentityId = plan.targetIdentityId;
      } else if (plan.action === 'exclude') {
        status = 'excluded';
      } else {
        status = existing?.status === 'pending_invite' ? 'pending_invite' : 'unmapped';
        if (plan.setEmail !== null) {
          emailUpdates.push({ id: plan.sourceIdentityId, email: plan.setEmail });
        }
      }
      const principalIds = [
        providerOf.get(plan.sourceIdentityId) as string,
        ...(existing?.targetIdentityId
          ? [providerOf.get(existing.targetIdentityId) as string]
          : []),
      ];
      if (existing) {
        mappingUpdates.push({ id: existing.id, status, targetIdentityId });
        touchedExisting.push(existing.id);
        if (status === 'excluded') {
          exclusions.push({ mappingId: existing.id, principalIds, reason: CSV_EXCLUSION_REASON });
        }
        audits.push({
          actorId: by.actorId,
          action: `identity-mapping.import.${plan.action}`,
          subjectType: 'identity_mapping',
          subjectId: existing.id,
          data: { status: { from: existing.status, to: status } },
        });
      } else {
        created.push({
          sourceIdentityId: plan.sourceIdentityId,
          status: status as 'confirmed' | 'excluded' | 'unmapped',
          targetIdentityId,
          action: plan.action,
        });
      }
    }
    for (const part of chunks(emailUpdates, 5000)) {
      // One statement per chunk; every value is a bind parameter.
      await tx.$executeRaw`
        UPDATE "app"."identity" i
           SET "email" = v.email, "email_source" = 'csv', "updated_at" = now()
          FROM unnest(${part.map((u) => u.id)}::text[], ${part.map((u) => u.email)}::text[])
               AS v(id, email)
         WHERE i."id" = v.id`;
    }
    for (const part of chunks(mappingUpdates, 5000)) {
      await tx.$executeRaw`
        UPDATE "app"."identity_mapping" m
           SET "status" = v.status::"app"."mapping_status",
               "target_identity_id" = v.target,
               "method" = 'csv',
               "confidence" = NULL,
               "decided_by_id" = ${by.actorId},
               "decided_at" = ${now},
               "updated_at" = now()
          FROM unnest(${part.map((u) => u.id)}::text[], ${part.map((u) => u.status)}::text[],
                      ${part.map((u) => u.targetIdentityId)}::text[])
               AS v(id, status, target)
         WHERE m."id" = v.id`;
    }
    if (created.length > 0) {
      const rows = [];
      for (const part of chunks(created)) {
        rows.push(
          ...(await tx.identityMapping.createManyAndReturn({
            data: part.map((c) => ({
              routeId,
              sourceIdentityId: c.sourceIdentityId,
              status: c.status,
              targetIdentityId: c.targetIdentityId,
              method: 'csv',
              decidedById: by.actorId,
              decidedAt: now,
            })),
          })),
        );
      }
      const idOf = new Map(rows.map((r) => [r.sourceIdentityId, r.id]));
      for (const c of created) {
        const mappingId = idOf.get(c.sourceIdentityId) as string;
        if (c.status === 'excluded') {
          exclusions.push({
            mappingId,
            principalIds: [providerOf.get(c.sourceIdentityId) as string],
            reason: CSV_EXCLUSION_REASON,
          });
        }
        audits.push({
          actorId: by.actorId,
          action: `identity-mapping.import.${c.action}`,
          subjectType: 'identity_mapping',
          subjectId: mappingId,
          data: { status: { from: null, to: c.status } },
        });
      }
    }
    await revokeExclusions(tx, touchedExisting, now);
    await createExclusions(tx, route, exclusions, by.actorId);
    if (audits.length > 0) {
      for (const part of chunks(audits)) await tx.auditEvent.createMany({ data: part });
      await afterChange(tx, routeId);
    }
    return result;
  });
}

// ---------------------------------------------------------------------------------------------
// Group mappings

/** A team slug: lowercase letters, digits and single hyphens, 1 to 100 characters. */
export const TEAM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface GroupMappingView {
  id: string;
  status: IdentityMappingView['status'];
  plannedSlug: string;
  /** Another mapping of the Route plans the same slug, or an unrelated target team has it. */
  collision: boolean;
  sourceGroup: { id: string; slug: string; name: string; memberCount: number };
  targetGroup: { id: string; slug: string; name: string; memberCount: number } | null;
}

interface GroupRow {
  id: string;
  status: IdentityMappingView['status'];
  plannedSlug: string;
  targetGroupId: string | null;
  sourceGroup: { id: string; slug: string; name: string; memberIds: string[] };
  targetGroup: { id: string; slug: string; name: string; memberIds: string[] } | null;
}

const groupInclude = {
  sourceGroup: { select: { id: true, slug: true, name: true, memberIds: true } },
  targetGroup: { select: { id: true, slug: true, name: true, memberIds: true } },
} as const;

const groupRef = (g: { id: string; slug: string; name: string; memberIds: string[] }) => ({
  id: g.id,
  slug: g.slug,
  name: g.name,
  memberCount: g.memberIds.length,
});

/** All Group Mappings of the Route with collision flags (UI-028). */
export async function listGroupMappings(db: Tx, routeId: string): Promise<GroupMappingView[]> {
  const route = await loadRoute(db, routeId);
  const rows = (await db.groupMapping.findMany({
    where: { routeId },
    include: groupInclude,
    orderBy: { plannedSlug: 'asc' },
  })) as unknown as GroupRow[];
  const targetTeams = await db.group.findMany({
    where: { endpointId: route.targetEndpointId },
    select: { id: true, slug: true },
  });
  const planned = new Map<string, number>();
  for (const r of rows) {
    const k = r.plannedSlug.toLowerCase();
    planned.set(k, (planned.get(k) ?? 0) + 1);
  }
  const teamBySlug = new Map(targetTeams.map((t) => [t.slug.toLowerCase(), t.id]));
  return rows.map((r) => {
    const key = r.plannedSlug.toLowerCase();
    const existing = teamBySlug.get(key);
    return {
      id: r.id,
      status: r.status,
      plannedSlug: r.plannedSlug,
      collision:
        (planned.get(key) ?? 0) > 1 || (existing !== undefined && existing !== r.targetGroupId),
      sourceGroup: groupRef(r.sourceGroup),
      targetGroup: r.targetGroup ? groupRef(r.targetGroup) : null,
    };
  });
}

async function groupViewOf(tx: Tx, route: RouteInfo, mappingId: string): Promise<GroupMappingView> {
  const view = (await listGroupMappings(tx, route.id)).find((g) => g.id === mappingId);
  if (!view) throw new ProblemError('not_found');
  return view;
}

async function loadGroupMapping(tx: Tx, route: RouteInfo, mappingId: string) {
  const mapping = await tx.groupMapping.findUnique({ where: { id: mappingId } });
  if (!mapping || mapping.routeId !== route.id) throw new ProblemError('not_found');
  return mapping;
}

/** Confirms a Group Mapping against an existing target team (the suggestion, or the one chosen). */
export async function confirmGroupMapping(
  db: Writer,
  routeId: string,
  mappingId: string,
  body: { targetGroupId?: string | undefined },
  by: Decision,
): Promise<GroupMappingView> {
  return db.privileged.$transaction(async (tx) => {
    const now = by.now ?? new Date();
    await lockRoute(tx, routeId);
    const route = await loadRoute(tx, routeId);
    const mapping = await loadGroupMapping(tx, route, mappingId);
    const targetId = body.targetGroupId ?? mapping.targetGroupId;
    if (!targetId) throw invalid('targetGroupId', 'a target team is required');
    const target = await tx.group.findUnique({
      where: { id: targetId },
      select: { endpointId: true },
    });
    if (!target || target.endpointId !== route.targetEndpointId) {
      throw invalid('targetGroupId', 'not a team of the Route target');
    }
    if (mapping.status === 'confirmed' && mapping.targetGroupId === targetId) {
      return groupViewOf(tx, route, mappingId);
    }
    const taken = await tx.groupMapping.findFirst({
      where: { routeId, status: 'confirmed', targetGroupId: targetId, id: { not: mappingId } },
      select: { id: true },
    });
    if (taken) {
      throw new ProblemError('conflict', {
        detail: 'the target team is already confirmed for another source group',
      });
    }
    await tx.groupMapping.update({
      where: { id: mappingId },
      data: { status: 'confirmed', targetGroupId: targetId },
    });
    await audit(tx, by.actorId, 'group-mapping.confirm', 'group_mapping', mappingId, {
      status: { from: mapping.status, to: 'confirmed' },
    });
    await afterChange(tx, routeId);
    return groupViewOf(tx, route, mappingId);
  });
}

/**
 * Changes the planned slug. An existing target team with that slug makes the mapping
 * `suggested` (as in AUTH-050); otherwise the team is planned for creation (`unmapped`). A
 * confirmed mapping is already tied to a team, so renaming it is a conflict.
 */
export async function renameGroupMapping(
  db: Writer,
  routeId: string,
  mappingId: string,
  plannedSlug: string,
  by: Decision,
): Promise<GroupMappingView> {
  const slug = plannedSlug.trim();
  if (slug.length === 0 || slug.length > 100 || !TEAM_SLUG.test(slug)) {
    throw invalid(
      'plannedSlug',
      'lowercase letters, digits and single hyphens, 1 to 100 characters',
    );
  }
  return db.privileged.$transaction(async (tx) => {
    const now = by.now ?? new Date();
    await lockRoute(tx, routeId);
    const route = await loadRoute(tx, routeId);
    const mapping = await loadGroupMapping(tx, route, mappingId);
    if (mapping.status === 'confirmed') {
      throw new ProblemError('conflict', { detail: 'a confirmed Group Mapping cannot be renamed' });
    }
    if (mapping.plannedSlug === slug) return groupViewOf(tx, route, mappingId);
    const existing = await tx.group.findFirst({
      where: { endpointId: route.targetEndpointId, slug: { equals: slug, mode: 'insensitive' } },
      select: { id: true },
    });
    await tx.groupMapping.update({
      where: { id: mappingId },
      data: {
        plannedSlug: slug,
        targetGroupId: existing?.id ?? null,
        status: existing ? 'suggested' : 'unmapped',
      },
    });
    await audit(tx, by.actorId, 'group-mapping.rename', 'group_mapping', mappingId, {
      plannedSlug: { from: mapping.plannedSlug, to: slug },
    });
    await afterChange(tx, routeId);
    return groupViewOf(tx, route, mappingId);
  });
}

/** The Routes a mapping page can be opened for. */
export async function listRoutes(
  db: Db,
): Promise<Array<{ id: string; sourceEndpointId: string; targetEndpointId: string }>> {
  return db.route.findMany({
    where: { retiredAt: null },
    select: { id: true, sourceEndpointId: true, targetEndpointId: true },
    orderBy: { id: 'asc' },
  });
}

/** Target Identities a source Identity can be mapped to, filtered by text (for "change target"). */
export async function listTargetIdentities(
  db: Tx,
  routeId: string,
  query: string | undefined,
  limit: number,
): Promise<IdentityRef[]> {
  const route = await loadRoute(db, routeId);
  const q = query?.trim();
  return db.identity.findMany({
    where: {
      endpointId: route.targetEndpointId,
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
    orderBy: [{ login: 'asc' }, { id: 'asc' }],
    take: limit,
  });
}
