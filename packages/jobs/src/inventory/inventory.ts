import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import {
  AdapterError,
  type EndpointConnection,
  type GroupRecord,
  type IdentityRecord,
  type NamespaceRecord,
  type Page,
  type RepositoryRecord,
} from '@git-migrator/adapter-sdk';
import type { Config } from '@git-migrator/config';
import {
  DEFAULT_ROUTE_POLICIES,
  type LifecycleEvent,
  type LifecycleState,
  type MigrationStatus,
  resolveRoutePolicies,
  transition,
} from '@git-migrator/core';
import { type Db, markAnalysesStale, type StaleScope } from '@git-migrator/db';
import type { Logger } from '@git-migrator/observability';
import type { ProviderRegistry } from '@git-migrator/registry';
import type pg from 'pg';
import type { JobHandlers } from '../runtime.ts';
import type { EndpointConnector } from './connector.ts';
import {
  demoteDuplicateConfirmations,
  indexTargets,
  type MappingFields,
  matchGroup,
  matchIdentity,
  outcomeFields,
  REMATCHABLE_STATUSES,
  sameMapping,
} from './matching.ts';

/** Sources matched between two yields to the event loop. */
const YIELD_EVERY = 500;

/** Rows per `createMany` statement. */
const CHUNK = 500;

export interface InventoryDeps {
  /** The privileged client: inventory is server code behind a job (DOM-005). */
  readonly db: Db;
  /** The application pool, for the per-Endpoint advisory lock. */
  readonly appPool: pg.Pool;
  readonly connector: EndpointConnector;
  readonly registry: Pick<ProviderRegistry, 'adapter'>;
  readonly config: Pick<Config, 'sizeClass'>;
  readonly log: Logger;
  /** Test seam. */
  readonly now?: () => Date;
  /** Test seam: runs between a read and the guarded write that follows it. */
  readonly hooks?: {
    readonly beforeTransitionWrite?: (migrationId: string) => Promise<void>;
    readonly beforeMappingWrite?: (mappingId: string) => Promise<void>;
  };
}

export interface InventoryRunOptions {
  /** Aborted at shutdown (`JobContext.shutdown`). */
  readonly shutdown: AbortSignal;
  readonly log?: Logger;
}

export interface InventoryResult {
  readonly skipped?: 'endpoint-retired' | 'already-running';
  /**
   * The provider listed no Namespaces or no Repositories although some are present in the
   * database. Nothing was marked missing (ADR-0280).
   */
  readonly suspicious?: true;
  readonly namespaces: number;
  readonly repositories: number;
  readonly identities: number;
  readonly groups: number;
  readonly createdMigrations: number;
  readonly missing: number;
  readonly reappeared: number;
  readonly staleMigrations: number;
  readonly mappingsChanged: number;
}

const EMPTY: InventoryResult = {
  namespaces: 0,
  repositories: 0,
  identities: 0,
  groups: 0,
  createdMigrations: 0,
  missing: 0,
  reappeared: 0,
  staleMigrations: 0,
  mappingsChanged: 0,
};

/**
 * Thrown when the process starts shutting down mid-pass. The job fails and BullMQ retries it; a
 * pass that was cut short never marks anything missing (JOB-030 needs a complete pass).
 */
export class InventoryInterruptedError extends Error {
  constructor() {
    super('Inventory interrupted by shutdown');
    this.name = 'InventoryInterruptedError';
  }
}

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const sameTime = (a: Date | null | undefined, b: Date | null | undefined): boolean =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);

/** Pages through a listing; `cursor` is opaque (ADP-010). */
async function collect<T>(
  list: (cursor?: string) => Promise<Page<T>>,
  checkpoint: () => void,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    checkpoint();
    const page = await list(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
    // A provider that hands back a cursor it already gave would loop for ever.
    if (cursor !== undefined && seen.has(cursor)) {
      throw new AdapterError({
        code: 'invalid',
        provider: 'inventory',
        message: 'A listing returned a cursor it had already returned',
      });
    }
    if (cursor !== undefined) seen.add(cursor);
  } while (cursor !== undefined);
  return items;
}

type RouteRow = Awaited<ReturnType<Db['route']['findMany']>>[number];

/**
 * One inventory pass over an Endpoint (JOB-030, DOM-014, AUTH-050 step 2). Every write is an upsert
 * by `(endpointId, providerId)` or a create guarded by a unique key, so running it again changes
 * nothing and a crash half-way is repaired by the next pass.
 */
export async function runInventory(
  deps: InventoryDeps,
  endpointId: string,
  options: InventoryRunOptions,
): Promise<InventoryResult> {
  const { db } = deps;
  const log = options.log ?? deps.log;
  const now = deps.now ?? (() => new Date());
  const checkpoint = (): void => {
    if (options.shutdown.aborted) throw new InventoryInterruptedError();
  };

  const endpoint = await db.endpoint.findUnique({ where: { id: endpointId } });
  if (endpoint?.status !== 'active') {
    log.warn({ endpointId }, 'inventory skipped: Endpoint is not active');
    return { ...EMPTY, skipped: 'endpoint-retired' };
  }

  const providerType = endpoint.providerType;

  // One pass per Endpoint at a time: a scheduled run and a manual refresh must not interleave.
  let unlockFailed = false;
  const lock = await deps.appPool.connect();
  try {
    const got = await lock.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok',
      [`inventory:${endpointId}`],
    );
    if (!got.rows[0]?.ok) {
      log.info({ endpointId }, 'inventory skipped: another pass is running');
      return { ...EMPTY, skipped: 'already-running' };
    }
    try {
      return await pass();
    } finally {
      // A session lock that cannot be released must not go back to the pool with the connection:
      // destroying the connection drops the lock.
      await lock
        .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`inventory:${endpointId}`])
        .catch(() => {
          unlockFailed = true;
        });
    }
  } finally {
    lock.release(unlockFailed);
  }

  async function pass(): Promise<InventoryResult> {
    const startedAt = now();
    const routes = await db.route.findMany({
      where: {
        retiredAt: null,
        OR: [{ sourceEndpointId: endpointId }, { targetEndpointId: endpointId }],
      },
      orderBy: { id: 'asc' },
    });
    // DOM-014: the endpoint-scope Migration exists for every Route, even if the provider is down.
    let createdMigrations = await ensureEndpointMigrations(routes);

    checkpoint();
    const connection = await deps.connector.connect(endpointId, {
      pool: 'background',
      signal: options.shutdown,
    });
    const adapter = deps.registry.adapter(providerType);
    const holdsRepositories = new Set(
      adapter.namespaceLevels.filter((l) => l.holdsRepositories).map((l) => l.kind),
    );

    const presentBefore = await db.repository.count({ where: { endpointId, presence: 'present' } });
    const namespaceRecords = await collect(
      (c) => connection.inventory.listNamespaces(c),
      checkpoint,
    );
    const namespaceIds = await upsertNamespaces(namespaceRecords);
    await resolveTargetNamespaces(routes, namespaceRecords, namespaceIds);

    const repositoryRecords = await listRepositories(
      connection,
      namespaceRecords.filter((n) => holdsRepositories.has(n.kind)),
    );
    const repositories = await upsertRepositories(repositoryRecords, namespaceIds, startedAt);

    // JOB-030: only a complete pass may mark anything missing. An empty listing of an Endpoint
    // that has present Repositories looks like a provider fault (a revoked grant, an outage that
    // answers 200), not a deletion of everything, so it marks nothing (ADR-0280).
    checkpoint();
    const suspicious =
      (namespaceRecords.length === 0 || repositoryRecords.length === 0) && presentBefore > 0;
    if (suspicious) {
      log.warn(
        { endpointId, namespaces: namespaceRecords.length, presentBefore },
        'inventory listed no namespaces or repositories; nothing marked missing',
      );
    }
    const missing = suspicious
      ? 0
      : await markMissing(new Set(repositoryRecords.map((r) => r.providerId)));
    createdMigrations += await ensureRepositoryMigrations(routes);
    if (!suspicious) await reconcileMissing();

    const identityRecords = await collect(
      (c) => connection.inventory.listIdentities(c),
      checkpoint,
    );
    const identityIds = await upsertIdentities(identityRecords);
    const groupRecords = await collect((c) => connection.inventory.listGroups(c), checkpoint);
    await upsertGroups(groupRecords, identityIds);

    checkpoint();
    const mappingsChanged = await mapRoutes(routes);

    const staleMigrations = repositories.stale;
    log.info(
      {
        endpointId,
        namespaces: namespaceRecords.length,
        repositories: repositoryRecords.length,
        identities: identityRecords.length,
        groups: groupRecords.length,
        createdMigrations,
        missing,
        reappeared: repositories.reappeared,
        staleMigrations,
        mappingsChanged,
      },
      'inventory complete',
    );
    return {
      namespaces: namespaceRecords.length,
      repositories: repositoryRecords.length,
      identities: identityRecords.length,
      groups: groupRecords.length,
      createdMigrations,
      missing,
      reappeared: repositories.reappeared,
      staleMigrations,
      mappingsChanged,
      ...(suspicious ? { suspicious: true as const } : {}),
    };
  }

  /** DOM-014: one endpoint-scope Migration per Route (a partial unique index backs it). */
  async function ensureEndpointMigrations(routeRows: readonly RouteRow[]): Promise<number> {
    let created = 0;
    for (const route of routeRows) {
      const existing = await db.migration.findFirst({
        where: { routeId: route.id, scope: 'endpoint' },
        select: { id: true },
      });
      if (existing) continue;
      try {
        await db.migration.create({ data: { scope: 'endpoint', routeId: route.id } });
        created++;
      } catch (error) {
        // A concurrent pass on the Route's other Endpoint created it first.
        const again = await db.migration.findFirst({
          where: { routeId: route.id, scope: 'endpoint' },
          select: { id: true },
        });
        if (!again) throw error;
      }
    }
    return created;
  }

  async function upsertNamespaces(
    records: readonly NamespaceRecord[],
  ): Promise<Map<string, string>> {
    const existing = new Map(
      (await db.namespace.findMany({ where: { endpointId } })).map((n) => [n.providerId, n]),
    );
    const fresh = records.filter((r) => !existing.has(r.providerId));
    for (const batch of chunks(fresh)) {
      await db.namespace.createMany({
        data: batch.map((r) => ({
          endpointId,
          providerId: r.providerId,
          kind: r.kind,
          slug: r.slug,
          key: r.key ?? null,
          name: r.name,
        })),
        skipDuplicates: true,
      });
    }
    for (const r of records) {
      checkpoint();
      const row = existing.get(r.providerId);
      if (!row) continue;
      const key = r.key ?? null;
      if (row.kind !== r.kind || row.slug !== r.slug || row.key !== key || row.name !== r.name) {
        await db.namespace.update({
          where: { id: row.id },
          data: { kind: r.kind, slug: r.slug, key, name: r.name },
        });
      }
    }
    const all = await db.namespace.findMany({ where: { endpointId } });
    const ids = new Map(all.map((n) => [n.providerId, n.id]));
    // Parents second: a parent may be listed after its child.
    const current = new Map(all.map((n) => [n.providerId, n.parentId]));
    for (const r of records) {
      checkpoint();
      const parentId =
        r.parentProviderId === undefined ? null : (ids.get(r.parentProviderId) ?? null);
      const id = ids.get(r.providerId);
      if (id && current.get(r.providerId) !== parentId) {
        await db.namespace.update({ where: { id }, data: { parentId } });
      }
    }
    return ids;
  }

  /**
   * `Route.targetNamespaceId` is resolved from the target inventory: the top-level namespace whose
   * slug or key equals the Route's `targetNamespacePath`. It is resolved again when the stored id
   * is no longer one of this Endpoint's namespaces, and an unresolved or ambiguous path is warned
   * about, never guessed.
   */
  async function resolveTargetNamespaces(
    routeRows: readonly RouteRow[],
    records: readonly NamespaceRecord[],
    ids: ReadonlyMap<string, string>,
  ): Promise<void> {
    const known = new Set(ids.values());
    for (const route of routeRows) {
      if (route.targetEndpointId !== endpointId) continue;
      if (route.targetNamespaceId && known.has(route.targetNamespaceId)) continue;
      const wanted = route.targetNamespacePath.toLowerCase();
      const matches = records.filter(
        (r) => r.slug.toLowerCase() === wanted || r.key?.toLowerCase() === wanted,
      );
      const topLevel = matches.filter((r) => r.parentProviderId === undefined);
      const candidates = topLevel.length > 0 ? topLevel : matches;
      const only = candidates.length === 1 ? candidates[0] : undefined;
      const id = only && ids.get(only.providerId);
      if (id) {
        await db.route.update({ where: { id: route.id }, data: { targetNamespaceId: id } });
      } else {
        log.warn(
          { routeId: route.id, path: route.targetNamespacePath, candidates: candidates.length },
          candidates.length === 0
            ? 'target namespace of the Route was not found'
            : 'target namespace of the Route is ambiguous',
        );
      }
    }
  }

  async function listRepositories(
    connection: EndpointConnection,
    namespaces: readonly NamespaceRecord[],
  ): Promise<RepositoryRecord[]> {
    const byProviderId = new Map<string, RepositoryRecord>();
    for (const ns of namespaces) {
      const ref = { providerId: ns.providerId, slug: ns.slug };
      const items = await collect((c) => connection.inventory.listRepositories(ref, c), checkpoint);
      for (const item of items) byProviderId.set(item.providerId, item);
    }
    return [...byProviderId.values()];
  }

  async function upsertRepositories(
    records: readonly RepositoryRecord[],
    namespaceIds: ReadonlyMap<string, string>,
    seenAt: Date,
  ): Promise<{ stale: number; reappeared: number }> {
    const threshold = BigInt(deps.config.sizeClass.largeThresholdBytes);
    const existing = new Map(
      (await db.repository.findMany({ where: { endpointId } })).map((r) => [r.providerId, r]),
    );
    const sizeClassOf = (size: bigint | null, lfs: bigint | null): 'standard' | 'large' => {
      // JOB-015: unknown size falls back to the last known LFS bytes.
      const basis = size ?? lfs;
      return basis !== null && basis > threshold ? 'large' : 'standard';
    };
    const namespaceOf = (r: RepositoryRecord): string | undefined =>
      namespaceIds.get(r.namespace.providerId);

    const fresh: RepositoryRecord[] = [];
    const staleRepositoryIds: string[] = [];
    const unchangedIds: string[] = [];
    let reappeared = 0;
    for (const r of records) {
      checkpoint();
      const namespaceId = namespaceOf(r);
      if (!namespaceId) {
        log.warn(
          { endpointId, repository: r.providerId },
          'repository in unknown namespace skipped',
        );
        continue;
      }
      const row = existing.get(r.providerId);
      if (!row) {
        fresh.push(r);
        continue;
      }
      // An unknown size keeps the last known one (a Run may have measured the mirror).
      const size = r.sizeBytes !== undefined ? BigInt(r.sizeBytes) : row.sizeBytes;
      const data = {
        namespaceId,
        slug: r.slug,
        name: r.name,
        fullPath: r.fullPath,
        isPrivate: r.isPrivate,
        sizeBytes: size,
        sizeClass: sizeClassOf(size, row.lfsBytes),
        presence: 'present' as const,
        defaultBranch: r.defaultBranch ?? null,
        providerUpdatedAt: r.providerUpdatedAt ?? row.providerUpdatedAt,
      };
      // JOB-030: a changed provider timestamp makes Analyses stale; a rename does too, because the
      // planned target name derives from the path.
      if (!sameTime(row.providerUpdatedAt, data.providerUpdatedAt) || row.fullPath !== r.fullPath) {
        staleRepositoryIds.push(row.id);
      }
      if (row.presence === 'missing') reappeared++;
      const changed =
        row.namespaceId !== data.namespaceId ||
        row.slug !== data.slug ||
        row.name !== data.name ||
        row.fullPath !== data.fullPath ||
        row.isPrivate !== data.isPrivate ||
        row.sizeBytes !== data.sizeBytes ||
        row.sizeClass !== data.sizeClass ||
        row.presence !== data.presence ||
        row.defaultBranch !== data.defaultBranch ||
        !sameTime(row.providerUpdatedAt, data.providerUpdatedAt);
      if (changed) {
        await db.repository.update({
          where: { id: row.id },
          data: { ...data, lastInventoriedAt: seenAt },
        });
      } else {
        unchangedIds.push(row.id);
      }
    }
    // Rows that did not change only get their "seen" stamp, in a few statements.
    for (const batch of chunks(unchangedIds)) {
      await db.repository.updateMany({
        where: { id: { in: batch } },
        data: { lastInventoriedAt: seenAt },
      });
    }
    for (const batch of chunks(fresh)) {
      await db.repository.createMany({
        data: batch.map((r) => {
          const size = r.sizeBytes !== undefined ? BigInt(r.sizeBytes) : null;
          return {
            endpointId,
            namespaceId: namespaceOf(r) as string,
            providerId: r.providerId,
            slug: r.slug,
            name: r.name,
            fullPath: r.fullPath,
            isPrivate: r.isPrivate,
            sizeBytes: size,
            sizeClass: sizeClassOf(size, null),
            defaultBranch: r.defaultBranch ?? null,
            providerUpdatedAt: r.providerUpdatedAt ?? null,
            lastInventoriedAt: seenAt,
          };
        }),
        skipDuplicates: true,
      });
    }
    return {
      stale: await markStale({ sourceRepositoryIds: staleRepositoryIds }),
      reappeared,
    };
  }

  /** Marks Analyses stale (LIF-021): a still-fresh one becomes stale now (ADR-0310). */
  function markStale(scope: StaleScope): Promise<number> {
    return markAnalysesStale(db, scope, now());
  }

  /**
   * Repositories not seen in this complete pass go `missing` (JOB-030). Ones that reappear were
   * set `present` by `upsertRepositories`.
   */
  async function markMissing(seen: ReadonlySet<string>): Promise<number> {
    const rows = await db.repository.findMany({
      where: { endpointId, presence: 'present' },
      select: { id: true, providerId: true },
    });
    const gone = rows.filter((r) => !seen.has(r.providerId));
    for (const batch of chunks(gone.map((r) => r.id))) {
      await db.repository.updateMany({
        where: { id: { in: batch } },
        data: { presence: 'missing' },
      });
    }
    return gone.length;
  }

  /** DOM-014: a repository-scope Migration for every present source Repository on each Route. */
  async function ensureRepositoryMigrations(routeRows: readonly RouteRow[]): Promise<number> {
    let created = 0;
    const sourceRoutes = routeRows.filter((r) => r.sourceEndpointId === endpointId);
    if (sourceRoutes.length === 0) return 0;
    const present = await db.repository.findMany({
      where: { endpointId, presence: 'present' },
      select: { id: true },
    });
    for (const route of sourceRoutes) {
      const have = new Set(
        (
          await db.migration.findMany({
            where: { routeId: route.id, scope: 'repository' },
            select: { sourceRepositoryId: true },
          })
        ).map((m) => m.sourceRepositoryId),
      );
      const missing = present.filter((r) => !have.has(r.id));
      for (const batch of chunks(missing)) {
        const result = await db.migration.createMany({
          data: batch.map((r) => ({
            scope: 'repository' as const,
            routeId: route.id,
            sourceRepositoryId: r.id,
          })),
          skipDuplicates: true,
        });
        created += result.count;
      }
    }
    return created;
  }

  /**
   * LIF-002 `source_missing` / `source_present`, level-triggered from `Repository.presence`: a
   * Migration that is `running` when its source disappears keeps running (the event is deferred,
   * ADR-0058), and the next pass sends the event again once the Run has finished (ADR-0280).
   */
  async function reconcileMissing(): Promise<void> {
    const migrations = await db.migration.findMany({
      where: {
        scope: 'repository',
        sourceRepository: { endpointId },
        OR: [
          { sourceRepository: { presence: 'missing' }, status: { notIn: ['source_missing'] } },
          { sourceRepository: { presence: 'present' }, status: 'source_missing' },
        ],
      },
      select: {
        id: true,
        status: true,
        statusBeforeRun: true,
        statusBeforeDrift: true,
        statusBeforeManual: true,
        statusBeforeMissing: true,
        sourceRepository: { select: { presence: true } },
      },
    });
    for (const m of migrations) {
      checkpoint();
      const state: LifecycleState = {
        status: m.status as MigrationStatus,
        statusBeforeRun: m.statusBeforeRun as MigrationStatus | null,
        statusBeforeDrift: m.statusBeforeDrift as MigrationStatus | null,
        statusBeforeManual: m.statusBeforeManual as MigrationStatus | null,
        statusBeforeMissing: m.statusBeforeMissing as MigrationStatus | null,
      };
      const event: LifecycleEvent = {
        type: m.sourceRepository?.presence === 'missing' ? 'source_missing' : 'source_present',
      };
      const result = transition(state, event);
      if (!result.ok) {
        log.warn(
          { migrationId: m.id, event: event.type, error: result.error },
          'transition rejected',
        );
        continue;
      }
      if (!result.changed) continue;
      await deps.hooks?.beforeTransitionWrite?.(m.id);
      // The row was read a moment ago; a Run may have started since (LIF-002, LIF-003). Write only
      // if nothing the transition depends on moved. Otherwise skip: presence still says the same
      // thing, so the next pass retries.
      const written = await db.migration.updateMany({
        where: {
          id: m.id,
          status: m.status,
          statusBeforeRun: m.statusBeforeRun,
          statusBeforeDrift: m.statusBeforeDrift,
          statusBeforeManual: m.statusBeforeManual,
          statusBeforeMissing: m.statusBeforeMissing,
        },
        data: {
          status: result.state.status,
          statusBeforeMissing: result.state.statusBeforeMissing,
        },
      });
      if (written.count === 0) {
        log.info(
          { migrationId: m.id, event: event.type },
          'migration changed meanwhile; retry next pass',
        );
      }
    }
  }

  async function upsertIdentities(
    records: readonly IdentityRecord[],
  ): Promise<ReadonlyMap<string, string>> {
    const existing = new Map(
      (await db.identity.findMany({ where: { endpointId } })).map((i) => [i.providerId, i]),
    );
    const fresh = records.filter((r) => !existing.has(r.providerId));
    for (const batch of chunks(fresh)) {
      await db.identity.createMany({
        data: batch.map((r) => ({
          endpointId,
          providerId: r.providerId,
          login: r.login ?? null,
          displayName: r.displayName ?? null,
          email: r.email ?? null,
          emailSource: r.emailSource ?? null,
          kind: r.kind,
          isMember: r.isMember,
        })),
        skipDuplicates: true,
      });
    }
    for (const r of records) {
      checkpoint();
      const row = existing.get(r.providerId);
      if (!row) continue;
      // An email an operator supplied by CSV is kept when the provider does not know one.
      const keepCsv = r.email === undefined && row.emailSource === 'csv';
      const data = {
        login: r.login ?? null,
        displayName: r.displayName ?? null,
        email: keepCsv ? row.email : (r.email ?? null),
        emailSource: keepCsv ? row.emailSource : (r.emailSource ?? null),
        kind: r.kind,
        isMember: r.isMember,
      };
      if (
        row.login !== data.login ||
        row.displayName !== data.displayName ||
        row.email !== data.email ||
        row.emailSource !== data.emailSource ||
        row.kind !== data.kind ||
        row.isMember !== data.isMember
      ) {
        await db.identity.update({ where: { id: row.id }, data });
      }
    }
    return new Map(
      (
        await db.identity.findMany({
          where: { endpointId },
          select: { id: true, providerId: true },
        })
      ).map((i) => [i.providerId, i.id]),
    );
  }

  async function upsertGroups(
    records: readonly GroupRecord[],
    identityIds: ReadonlyMap<string, string>,
  ): Promise<void> {
    const existing = new Map(
      (await db.group.findMany({ where: { endpointId } })).map((g) => [g.providerId, g]),
    );
    const membersOf = (g: GroupRecord): string[] => {
      const ids: string[] = [];
      for (const providerId of g.memberProviderIds) {
        const id = identityIds.get(providerId);
        if (id) ids.push(id);
        else log.debug({ endpointId, group: g.providerId }, 'group member is not a known Identity');
      }
      return [...new Set(ids)].sort();
    };
    const fresh = records.filter((g) => !existing.has(g.providerId));
    for (const batch of chunks(fresh)) {
      await db.group.createMany({
        data: batch.map((g) => ({
          endpointId,
          providerId: g.providerId,
          slug: g.slug,
          name: g.name,
          memberIds: membersOf(g),
        })),
        skipDuplicates: true,
      });
    }
    for (const g of records) {
      checkpoint();
      const row = existing.get(g.providerId);
      if (!row) continue;
      const memberIds = membersOf(g);
      if (
        row.slug !== g.slug ||
        row.name !== g.name ||
        [...row.memberIds].sort().join() !== memberIds.join()
      ) {
        await db.group.update({
          where: { id: row.id },
          data: { slug: g.slug, name: g.name, memberIds },
        });
      }
    }
  }

  /** AUTH-050 step 2 and the Group Mapping flow, for every Route this Endpoint belongs to. */
  async function mapRoutes(routeRows: readonly RouteRow[]): Promise<number> {
    let changed = 0;
    for (const route of routeRows) {
      checkpoint();
      let autoConfirmEmail = DEFAULT_ROUTE_POLICIES.identityMatch.autoConfirmEmail;
      try {
        autoConfirmEmail = resolveRoutePolicies(route.policies).identityMatch.autoConfirmEmail;
      } catch (error) {
        log.warn({ routeId: route.id, err: error }, 'route policies unreadable; using defaults');
      }
      const identityChanges = await mapIdentities(route, autoConfirmEmail);
      const groupChanges = await mapGroups(route);
      changed += identityChanges.changed + groupChanges;
      // AUTH-050 step 5: a mapping that now resolves (or no longer resolves) a principal changes
      // what translation produces, so the Route's Analyses are stale.
      if (identityChanges.resolution) await markStale({ routeId: route.id });
    }
    return changed;
  }

  async function mapIdentities(
    route: RouteRow,
    autoConfirmEmail: boolean,
  ): Promise<{ changed: number; resolution: boolean }> {
    const [sources, targets, mappings] = await Promise.all([
      db.identity.findMany({
        where: { endpointId: route.sourceEndpointId },
        orderBy: { id: 'asc' },
      }),
      db.identity.findMany({
        where: { endpointId: route.targetEndpointId },
        orderBy: { id: 'asc' },
      }),
      db.identityMapping.findMany({ where: { routeId: route.id } }),
    ]);
    const bySource = new Map(mappings.map((m) => [m.sourceIdentityId, m]));
    // Targets already confirmed by a decided mapping are not handed out again automatically.
    const takenTargets = new Set(
      mappings
        .filter((m) => m.status === 'confirmed')
        .flatMap((m) => (m.targetIdentityId ? [m.targetIdentityId] : [])),
    );
    const index = indexTargets(targets);
    const pending = sources.filter((source) => {
      const existing = bySource.get(source.id);
      return !existing || REMATCHABLE_STATUSES.has(existing.status);
    });
    const raw = [];
    for (const [i, source] of pending.entries()) {
      // A big directory must not hold the event loop (BullMQ lock renewal, health endpoint).
      if (i % YIELD_EVERY === 0) {
        checkpoint();
        await yieldToEventLoop();
      }
      raw.push(matchIdentity(source, index, { autoConfirmEmail }));
    }
    const outcomes = demoteDuplicateConfirmations(raw, takenTargets);

    const toCreate: Array<MappingFields & { sourceIdentityId: string }> = [];
    let changed = 0;
    let resolution = false;
    const resolves = (status: string) => status === 'confirmed';
    for (const [i, source] of pending.entries()) {
      checkpoint();
      const existing = bySource.get(source.id);
      const next = outcomeFields(outcomes[i] as (typeof outcomes)[number]);
      if (!existing) {
        toCreate.push({ sourceIdentityId: source.id, ...next });
        continue;
      }
      const before: MappingFields = {
        status: existing.status,
        targetIdentityId: existing.targetIdentityId,
        method: existing.method,
        confidence: existing.confidence,
      };
      if (sameMapping(before, next)) continue;
      await deps.hooks?.beforeMappingWrite?.(existing.id);
      // An operator may have decided this row since it was read: write only while it is still
      // undecided, and count nothing otherwise (AUTH-050: decisions are never overwritten).
      const written = await db.identityMapping.updateMany({
        where: { id: existing.id, status: { in: ['unmapped', 'suggested'] } },
        data: {
          status: next.status as 'unmapped' | 'suggested' | 'confirmed',
          targetIdentityId: next.targetIdentityId,
          method: next.method,
          confidence: next.confidence,
          decidedAt: next.status === 'confirmed' ? now() : null,
        },
      });
      if (written.count === 0) continue;
      changed++;
      resolution ||= resolves(next.status) || resolves(before.status);
    }
    for (const batch of chunks(toCreate)) {
      const result = await db.identityMapping.createMany({
        data: batch.map((m) => ({
          routeId: route.id,
          sourceIdentityId: m.sourceIdentityId,
          targetIdentityId: m.targetIdentityId,
          status: m.status as 'unmapped' | 'suggested' | 'confirmed',
          method: m.method,
          confidence: m.confidence,
          decidedAt: m.status === 'confirmed' ? now() : null,
        })),
        skipDuplicates: true,
      });
      changed += result.count;
      resolution ||= batch.some((m) => resolves(m.status));
    }
    return { changed, resolution };
  }

  async function mapGroups(route: RouteRow): Promise<number> {
    const [sources, targets, mappings] = await Promise.all([
      db.group.findMany({ where: { endpointId: route.sourceEndpointId }, orderBy: { id: 'asc' } }),
      db.group.findMany({ where: { endpointId: route.targetEndpointId }, orderBy: { id: 'asc' } }),
      db.groupMapping.findMany({ where: { routeId: route.id } }),
    ]);
    const bySource = new Map(mappings.map((m) => [m.sourceGroupId, m]));
    const toCreate: Array<{
      sourceGroupId: string;
      plannedSlug: string;
      status: 'suggested' | 'unmapped';
      targetGroupId: string | null;
    }> = [];
    let changed = 0;
    for (const source of sources) {
      checkpoint();
      const existing = bySource.get(source.id);
      if (existing && !REMATCHABLE_STATUSES.has(existing.status)) continue;
      const next = matchGroup(source.slug, targets);
      if (!existing) {
        toCreate.push({ sourceGroupId: source.id, plannedSlug: source.slug, ...next });
        changed++;
        continue;
      }
      if (existing.status === next.status && existing.targetGroupId === next.targetGroupId)
        continue;
      await deps.hooks?.beforeMappingWrite?.(existing.id);
      const written = await db.groupMapping.updateMany({
        where: { id: existing.id, status: { in: ['unmapped', 'suggested'] } },
        data: { status: next.status, targetGroupId: next.targetGroupId },
      });
      if (written.count > 0) changed++;
    }
    for (const batch of chunks(toCreate)) {
      await db.groupMapping.createMany({
        data: batch.map((m) => ({ routeId: route.id, ...m })),
        skipDuplicates: true,
      });
    }
    return changed;
  }
}

/** The `inventory.endpoint` handler (JOB-030). Register it with the other handlers of the process. */
export function inventoryHandlers(deps: InventoryDeps): JobHandlers {
  return {
    'inventory.endpoint': ({ endpointId }, ctx) =>
      runInventory(deps, endpointId, { shutdown: ctx.shutdown, log: ctx.log }),
  };
}
