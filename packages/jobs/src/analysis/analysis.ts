/**
 * The `analysis.migration` processor (LIF-020, JOB-020): reads the Facets of a Migration from the
 * source (and the target when it exists), translates them, builds the Plan, and stores the result.
 * Everything that reaches a provider goes through `EndpointConnector` and the adapters' drivers,
 * so quota and raw capture apply (ADP-060). Decisions: docs/adr/0310-analysis-processor.md,
 * 0311-analysis-route-index.md.
 */
import type {
  EndpointConnection,
  FacetRead,
  FacetTarget,
  GitClient,
  NamespaceRef,
  ProviderHttpClient,
  RepositoryRecord,
  RepositoryRef,
} from '@git-migrator/adapter-sdk';
import type { Config } from '@git-migrator/config';
import {
  buildPlan,
  ENDPOINT_STEP_TEMPLATE,
  type ExpectedDifferenceRecord,
  type ExtraFinding,
  type FacetCapability,
  type FacetDefinition,
  type FacetKey,
  type FacetTranslation,
  hashCanonical,
  type NamingPipeline,
  type NamingRules,
  NO_CAPABILITY,
  planRouteNaming,
  REPOSITORY_STEP_TEMPLATE,
  type RouteNamingEntry,
  resolveRoutePolicies,
  resolveTargetName,
  translateAll,
} from '@git-migrator/core';
import { type Db, markAnalysesStale, publishEvent } from '@git-migrator/db';
import type { Logger } from '@git-migrator/observability';
import { effectiveFieldSupport, type ProviderRegistry } from '@git-migrator/registry';
import { UnrecoverableError } from 'bullmq';
import type pg from 'pg';
import { databaseNow } from '../db-clock.ts';
import type { EndpointConnector } from '../inventory/connector.ts';
import type { JobHandlers } from '../runtime.ts';
import {
  collectPrincipals,
  deployKeysOf,
  deployKeyUsage,
  groupResolver,
  identityResolver,
  type MappingRow,
  namesOf,
  type ReadWarning,
  splitReadWarnings,
  withoutFrameworkCreated,
} from './context.ts';
import { FAILURE_BACKOFF_BASE_MS, FAILURE_BACKOFF_CAP_MS } from './feeder.ts';
import { type PersistHooks, persistAnalysis, type SnapshotInput } from './persist.ts';

type Json = Record<string, unknown>;

/** Weight of the newest Analysis in the rolling mean of calls per Analysis (ADR-0310). */
export const CALLS_EMA_WEIGHT = 0.1;

export interface AnalysisDeps {
  /** The privileged client: analysis is server code behind a job (DOM-005). */
  readonly db: Db;
  /** The application pool (rolling mean update, deploy-key usage query). */
  readonly appPool: pg.Pool;
  readonly connector: EndpointConnector;
  readonly registry: Pick<ProviderRegistry, 'adapter' | 'facets' | 'capabilities'>;
  readonly config: Pick<Config, 'schedules'>;
  /** Git transport for the `git-refs` read (ls-remote). */
  readonly git: GitClient;
  readonly log: Logger;
  /** Test seam. */
  readonly now?: () => Date;
  readonly hooks?: PersistHooks;
}

export interface AnalysisRunOptions {
  readonly shutdown: AbortSignal;
  /** `interactive` for user-triggered analyses, `background` for the feeder's (JOB-020). */
  readonly pool: 'interactive' | 'background';
  readonly log?: Logger;
}

export interface AnalysisResult {
  /** A newer-started Analysis of the Migration was stored first; this one was dropped. */
  readonly superseded?: true;
  readonly skipped?: 'migration-missing' | 'route-retired' | 'source-missing' | 'no-source';
  readonly analysisId?: string;
  readonly readiness?: string | null;
  /** Provider calls made, for the rolling mean. */
  readonly calls?: number;
}

/** Thrown at shutdown: the job fails and BullMQ retries it; nothing was stored. */
export class AnalysisInterruptedError extends Error {
  constructor() {
    super('Analysis interrupted by shutdown');
    this.name = 'AnalysisInterruptedError';
  }
}

/** A configuration or data problem that retrying cannot fix. */
export class AnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisError';
  }
}

/** The Route default naming pipeline when `routes[].defaults.naming` is absent (LIF-030). */
export const DEFAULT_NAMING: NamingPipeline = {
  steps: [
    { var: 'namespace', op: 'projectKey' },
    { var: 'namespace', op: 'lowercase' },
    { var: 'repository', op: 'slug' },
    { var: 'repository', op: 'kebab' },
  ],
  template: '{namespace}-{repository}',
};

/** `routes[].defaults.naming` of a stored Route, or the default pipeline. Throws `AnalysisError` when malformed. */
export function routeNaming(defaults: unknown): NamingPipeline {
  const naming = (defaults as { naming?: unknown } | null)?.naming;
  if (naming === undefined) return DEFAULT_NAMING;
  const p = naming as { steps?: unknown; template?: unknown };
  if (!Array.isArray(p.steps) || typeof p.template !== 'string') {
    throw new AnalysisError('routes[].defaults.naming is not a naming pipeline');
  }
  return naming as NamingPipeline;
}

/** Counts calls through the HTTP client handed to the drivers (JOB-020 `avgCallsPerAnalysis`). */
export function counting(http: ProviderHttpClient, counter: { n: number }): ProviderHttpClient {
  return new Proxy(http, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      if (prop === 'request') {
        return (...args: unknown[]) => {
          counter.n++;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
}

export function jsonSafe<V>(value: V): V {
  return JSON.parse(JSON.stringify(value)) as V;
}

export interface FacetReading {
  readonly key: FacetKey;
  readonly read: FacetRead<unknown>;
  readonly caps: FacetCapability;
}

/** Static capabilities with the read-time facts laid over them (ADR-0231, ADR-0310). */
export function effectiveCaps(
  base: FacetCapability | undefined,
  read: FacetRead<unknown> | undefined,
): FacetCapability {
  const b = base ?? NO_CAPABILITY;
  let fields = effectiveFieldSupport(b.fields, read?.capabilities);
  const unreadable = Object.fromEntries(
    (read?.unreadable ?? []).map((p) => [p, { kind: 'unreadable' as const }]),
  );
  fields = effectiveFieldSupport(fields, unreadable);
  return { read: b.read, write: b.write, fields };
}

export const adapterCaps = (
  registry: AnalysisDeps['registry'],
  type: string,
  key: FacetKey,
): FacetCapability | undefined =>
  (registry.capabilities(type).facets as Record<string, FacetCapability | undefined>)[key];

/**
 * One Analysis (LIF-020). Idempotent: a retry reads again and stores a new Analysis; ManualTasks
 * upsert by identity, so nothing is duplicated.
 */
export async function runAnalysis(
  deps: AnalysisDeps,
  migrationId: string,
  options: AnalysisRunOptions,
): Promise<AnalysisResult> {
  const { db, registry } = deps;
  const log = (options.log ?? deps.log).child?.({ migrationId }) ?? deps.log;
  const now = deps.now ?? (() => new Date());
  const checkpoint = (): void => {
    if (options.shutdown.aborted) throw new AnalysisInterruptedError();
  };
  // The start of the Analysis on the database clock: it orders concurrent Analyses of one
  // Migration without comparing the clocks of different workers (ADR-0310).
  const startedAt = await databaseNow(db);

  const migration = await db.migration.findUnique({
    where: { id: migrationId },
    include: {
      route: true,
      sourceRepository: { include: { namespace: true } },
      targetRepository: true,
    },
  });
  if (!migration) return { skipped: 'migration-missing' };
  const route = migration.route;
  if (route.retiredAt) return { skipped: 'route-retired' };
  const isRepository = migration.scope === 'repository';
  const sourceRepository = migration.sourceRepository;
  if (isRepository) {
    if (!sourceRepository) return { skipped: 'no-source' };
    if (sourceRepository.presence !== 'present') return { skipped: 'source-missing' };
  }

  const [sourceEndpoint, targetEndpoint] = await Promise.all([
    db.endpoint.findUniqueOrThrow({ where: { id: route.sourceEndpointId } }),
    db.endpoint.findUniqueOrThrow({ where: { id: route.targetEndpointId } }),
  ]);
  if (sourceEndpoint.status !== 'active' || targetEndpoint.status !== 'active') {
    throw new AnalysisError(`Route ${route.id} has a retired Endpoint`);
  }
  const sourceType = sourceEndpoint.providerType;
  const targetType = targetEndpoint.providerType;
  const policies = resolveRoutePolicies(route.policies);
  // Everything that needs no provider call is checked before the first one, so a configuration
  // fault fails at once and for free (ADR-0312).
  routeNaming(route.defaults);
  for (const type of [sourceType, targetType]) {
    try {
      registry.capabilities(type);
    } catch {
      throw new AnalysisError(`Provider type ${type} of Route ${route.id} is not registered`);
    }
  }
  const targetNamespace = route.targetNamespaceId
    ? await db.namespace.findUnique({ where: { id: route.targetNamespaceId } })
    : null;
  if (!targetNamespace) {
    throw new AnalysisError(`The target namespace of Route ${route.id} is not resolved yet`);
  }

  const calls = { n: 0 };
  checkpoint();
  const [sourceConn, targetConn] = await Promise.all([
    deps.connector.connect(route.sourceEndpointId, {
      pool: options.pool,
      signal: options.shutdown,
    }),
    deps.connector.connect(route.targetEndpointId, {
      pool: options.pool,
      signal: options.shutdown,
    }),
  ]);
  const driverContext = (conn: EndpointConnection) => ({
    http: counting(conn.http, calls),
    git: deps.git,
    logger: log as never,
    pool: options.pool,
    signal: options.shutdown,
  });

  const scopeKind = isRepository ? 'repository' : 'endpoint';
  const facetDefs = registry.facets.ordered().filter((d) => d.scope === scopeKind);

  const readSide = async (
    conn: EndpointConnection,
    type: string,
    target: FacetTarget,
  ): Promise<FacetReading[]> => {
    const ctx = driverContext(conn);
    const out: FacetReading[] = [];
    for (const def of facetDefs) {
      checkpoint();
      const base = adapterCaps(registry, type, def.key);
      const real = conn.facets[def.key as keyof typeof conn.facets];
      if (!base?.read || !real) continue;
      const read = await real.read(ctx, target);
      out.push({ key: def.key, read, caps: effectiveCaps(base, read) });
    }
    return out;
  };

  // -- step 2: source reads ------------------------------------------------------------------
  const sourceNamespace = isRepository
    ? (sourceRepository?.namespace as NonNullable<typeof sourceRepository>['namespace'])
    : await rootNamespace(db, route.sourceEndpointId);
  const sourceNsRef: NamespaceRef = {
    providerId: sourceNamespace.providerId,
    slug: sourceNamespace.slug,
  };
  const sourceRef: RepositoryRef | undefined = sourceRepository
    ? {
        providerId: sourceRepository.providerId,
        namespace: sourceNsRef,
        slug: sourceRepository.slug,
      }
    : undefined;
  const sourceTarget: FacetTarget = sourceRef
    ? { scope: 'repository', repository: sourceRef, namespace: sourceNsRef }
    : { scope: 'endpoint', namespace: sourceNsRef };
  const sourceReads = await readSide(sourceConn, sourceType, sourceTarget);

  // LIF-045: what the framework created on the source is not translated.
  const sourceMutations = isRepository
    ? await db.mutation.findMany({
        where: { migrationId, side: 'source', action: 'create', undoneAt: null },
        select: { facetKey: true, paths: true, resourceRef: true },
      })
    : [];
  const frameworkPaths = (facetKey: string): string[] =>
    sourceMutations
      .filter((m) => m.facetKey === facetKey)
      .filter((m) => {
        const ref = m.resourceRef as Json | null;
        return ref?.adopted !== true && ref?.noop !== true;
      })
      .flatMap((m) => m.paths);

  const sources: Record<string, unknown> = {};
  const attachments: Record<string, string> = {};
  for (const r of sourceReads) {
    sources[r.key] = withoutFrameworkCreated(r.read.data, frameworkPaths(r.key));
    Object.assign(attachments, r.read.attachments ?? {});
  }
  const sourceCaps = Object.fromEntries(sourceReads.map((r) => [r.key, r.caps]));

  // -- step 3: naming, the target ------------------------------------------------------------
  let plannedTargetName: string | null | undefined;
  const extraFindings: ExtraFinding[] = [];
  let targetReads: FacetReading[] = [];
  let targetRepositoryDbId: string | null = null;
  let targetRecord: RepositoryRecord | null = null;
  const targetNsRef: NamespaceRef = {
    providerId: targetNamespace.providerId,
    slug: targetNamespace.slug,
  };

  if (isRepository && sourceRepository) {
    const naming = await planNaming({
      deps,
      routeId: route.id,
      routeDefaults: route.defaults,
      migrationId,
      targetEndpointId: route.targetEndpointId,
      targetRepositoryId: migration.targetRepositoryId,
      targetRepository: migration.targetRepository,
      targetNsRef,
      targetConn,
      checkpoint,
      calls,
    });
    plannedTargetName = naming.entry.plannedName;
    targetRecord = naming.live;
    targetRepositoryDbId = naming.liveDbId;
    for (const f of naming.entry.findings) {
      extraFindings.push({
        kind: f.severity === 'blocker' ? 'blocker' : 'warning',
        facetKey: null,
        code: f.code,
        params: { ...f.params },
      });
    }
    if (targetRecord) {
      const targetRef: RepositoryRef = {
        providerId: targetRecord.providerId,
        namespace: targetNsRef,
        slug: targetRecord.slug,
      };
      targetReads = await readSide(targetConn, targetType, {
        scope: 'repository',
        repository: targetRef,
        namespace: targetNsRef,
      });
    }
  } else {
    targetReads = await readSide(targetConn, targetType, {
      scope: 'endpoint',
      namespace: targetNsRef,
    });
  }
  const targetCaps: Record<string, FacetCapability> = {};
  for (const def of facetDefs) {
    const base = adapterCaps(registry, targetType, def.key);
    if (!base) continue;
    targetCaps[def.key] = effectiveCaps(base, targetReads.find((r) => r.key === def.key)?.read);
  }

  // -- the translate environment -------------------------------------------------------------
  checkpoint();
  const principals = [...collectPrincipals(sources).values()];
  const [identityRows, groupRows, allowlist, overlays, eds] = await Promise.all([
    loadIdentityMappings(db, route.id, route.sourceEndpointId, principals),
    loadGroupMappings(db, route.id, route.sourceEndpointId),
    db.webhookAllowlistEntry.findMany({ where: { routeId: route.id }, select: { pattern: true } }),
    db.overlay.findMany({ where: { routeId: route.id, enabled: true }, select: { id: true } }),
    db.expectedDifference.findMany({
      where: {
        routeId: route.id,
        revokedAt: null,
        OR: [{ migrationId: null }, { migrationId }],
      },
    }),
  ]);

  const routeIndex: Json = {};
  let staleMigrationIds: string[] = [];
  const snapshotsExtra: { deployKeys?: string[] } = {};
  if (isRepository && sourceRepository) {
    const usage = await buildDeployKeyUsage(
      deps,
      route.id,
      sourceRepository.id,
      migrationId,
      sources,
    );
    routeIndex.deployKeyUsage = usage.usage;
    staleMigrationIds = usage.holdersOfChangedKeys;
    snapshotsExtra.deployKeys = usage.own;
    routeIndex.pipelines = {
      sources: attachments,
      workspaceVariables: await endpointNames(db, route.sourceEndpointId, 'org-variables'),
      workspaceSecrets: await endpointNames(db, route.sourceEndpointId, 'org-secrets'),
    };
  } else {
    Object.assign(routeIndex, await endpointRouteIndex(db, route));
  }

  const env = {
    identities: identityResolver(identityRows),
    groups: groupResolver(groupRows),
    policies,
    route: jsonSafe({
      defaults: route.defaults,
      webhookAllowlist: allowlist.map((a) => a.pattern),
    }) as Json,
    routeIndex: jsonSafe(routeIndex),
  };
  const edRecords: ExpectedDifferenceRecord[] = eds.map((e) => ({
    id: e.id,
    facetKey: e.facetKey,
    path: e.path,
    reason: e.reason,
    note: e.note,
    migrationId: e.migrationId,
    revokedAt: e.revokedAt,
  }));

  // -- step 4: translate ---------------------------------------------------------------------
  const translated = translateAll(registry.facets, {
    env,
    sources,
    sourceCaps,
    targetCaps,
    pair: { source: sourceType, target: targetType },
    migrationId,
    expectedDifferences: edRecords,
  });

  // Adapter read warnings that the Facets declare become Plan warnings (ADR-0311).
  const diagnostics: Record<string, ReadWarning[]> = {};
  for (const r of [...sourceReads, ...targetReads]) {
    const def = registry.facets.get(r.key);
    const split = splitReadWarnings(def, r.read.warnings);
    for (const f of split.findings) {
      if (
        !extraFindings.some(
          (x) => x.code === f.code && JSON.stringify(x.params ?? {}) === JSON.stringify(f.params),
        )
      ) {
        extraFindings.push({
          kind: 'warning',
          facetKey: r.key,
          code: f.code,
          paths: f.paths,
          params: f.params,
        });
      }
    }
    if (split.diagnostics.length > 0) diagnostics[r.key] = split.diagnostics;
  }

  // -- step 5: the Plan ----------------------------------------------------------------------
  const desiredOf = (key: string): Json | undefined =>
    translated.translations.find((t) => t.facetKey === key)?.desired as Json | undefined;
  const flags = new Set<string>();
  const targetBranchRules = targetReads.find((r) => r.key === 'branch-rules')?.read.data as
    | { rules?: unknown[] }
    | undefined;
  if ((targetBranchRules?.rules?.length ?? 0) > 0) flags.add('liftProtection');
  if (
    ((desiredOf('pipelines')?.files as unknown[] | undefined)?.length ?? 0) > 0 ||
    ((desiredOf('code-ownership')?.owners as unknown[] | undefined)?.length ?? 0) > 0
  ) {
    flags.add('changeRequests');
  }
  if (overlays.length > 0) flags.add('overlays');
  if (route.sourcePostAction === 'read-only') flags.add('sourceReadOnly');

  const plan = buildPlan({
    registry: registry.facets,
    translations: translated.translations,
    extraFindings,
    stepTemplate: isRepository ? REPOSITORY_STEP_TEMPLATE : ENDPOINT_STEP_TEMPLATE,
    flags,
    targetCaps,
  });

  // -- step 6/7: persist ---------------------------------------------------------------------
  checkpoint();
  const fetchedAt = now();
  const snapshots: SnapshotInput[] = [
    ...sourceReads.map((r) =>
      snapshotOf('source', route.sourceEndpointId, sourceRepository?.id ?? null, r, fetchedAt),
    ),
    ...targetReads.map((r) =>
      snapshotOf('target', route.targetEndpointId, targetRepositoryDbId, r, fetchedAt),
    ),
  ];
  const persisted = await persistAnalysis(
    db,
    {
      migrationId,
      routeId: route.id,
      startedAt,
      staleGenerationAtStart: migration.staleGeneration,
      now: now(),
      staleAfterMs: deps.config.schedules.analysisStaleAfter,
      snapshots,
      plan,
      plannedTargetName,
      translation: translationJson(translated.translations, diagnostics, {
        plannedTargetName: plannedTargetName ?? null,
        flags: [...flags].sort(),
        targetFound: targetRecord !== null,
        skipped: translated.skipped,
      }),
    },
    deps.hooks ?? {},
    log,
  );
  if (!persisted.superseded) {
    // After the commit and one row at a time in id order, so it can never wait on, or deadlock
    // with, an Analysis that holds another Migration's row lock (ADR-0310).
    // A failure here must not fail (and so repeat) the Analysis that is already stored; the holder
    // then waits for its scheduled Analysis (ADR-0310).
    for (const id of [...new Set(staleMigrationIds)].filter((x) => x !== migrationId).sort()) {
      try {
        for (const marked of await markAnalysesStale(db, { ids: [id] })) {
          await publishEvent(deps.appPool, {
            type: 'migration.updated',
            ids: { migration: marked },
            at: now().toISOString(),
          });
        }
      } catch (error) {
        log.warn({ err: error, holder: id }, 'could not mark a deploy-key holder stale');
      }
    }
  }
  await recordCalls(deps.appPool, route.id, calls.n, log);
  log.info(
    { analysisId: persisted.analysisId, readiness: persisted.readiness, calls: calls.n },
    'analysis complete',
  );
  return {
    analysisId: persisted.analysisId,
    readiness: persisted.readiness,
    calls: calls.n,
    ...(persisted.superseded ? { superseded: true as const } : {}),
  };
}

function snapshotOf(
  side: 'source' | 'target',
  endpointId: string,
  repositoryId: string | null,
  r: FacetReading,
  fetchedAt: Date,
): SnapshotInput {
  const data = jsonSafe(r.read.data);
  return {
    side,
    endpointId,
    repositoryId,
    facetKey: r.key,
    schemaVersion: 1,
    data,
    unreadable: r.read.unreadable,
    hash: hashCanonical(data),
    fetchedAt,
    rawResponseIds: r.read.rawResponseIds,
  };
}

function translationJson(
  translations: readonly FacetTranslation[],
  diagnostics: Record<string, ReadWarning[]>,
  extra: Json,
): Json {
  return {
    ...extra,
    facets: Object.fromEntries(
      translations.map((t) => [
        t.facetKey,
        { desired: t.desired, decisions: t.decisions, overridden: t.overridden },
      ]),
    ),
    readDiagnostics: diagnostics,
  };
}

export async function rootNamespace(db: Db, endpointId: string) {
  const root = await db.namespace.findFirst({
    where: { endpointId, parentId: null },
    orderBy: { id: 'asc' },
  });
  if (!root) throw new AnalysisError(`Endpoint ${endpointId} has no namespace yet; run inventory`);
  return root;
}

export async function loadIdentityMappings(
  db: Db,
  routeId: string,
  sourceEndpointId: string,
  principals: readonly { kind: string; id: string }[],
): Promise<MappingRow[]> {
  const ids = principals.filter((p) => p.kind === 'identity').map((p) => p.id);
  if (ids.length === 0) return [];
  const rows = await db.identityMapping.findMany({
    where: { routeId, sourceIdentity: { endpointId: sourceEndpointId, providerId: { in: ids } } },
    include: {
      sourceIdentity: { select: { providerId: true } },
      targetIdentity: { select: { providerId: true } },
    },
  });
  return rows.map((r) => ({
    status: r.status,
    sourceProviderId: r.sourceIdentity.providerId,
    targetProviderId: r.targetIdentity?.providerId ?? null,
  }));
}

export async function loadGroupMappings(
  db: Db,
  routeId: string,
  sourceEndpointId: string,
): Promise<MappingRow[]> {
  // A Route has few groups, and SQL equality is case-sensitive while group ids are not (FAC-006,
  // ADR-0106): load them all and let the resolver fold case.
  const rows = await db.groupMapping.findMany({
    where: { routeId, sourceGroup: { endpointId: sourceEndpointId } },
    include: {
      sourceGroup: { select: { providerId: true } },
      targetGroup: { select: { providerId: true } },
    },
  });
  return rows.map((r) => ({
    status: r.status,
    sourceProviderId: r.sourceGroup.providerId,
    targetProviderId: r.targetGroup?.providerId ?? null,
  }));
}

/** FAC-DKY-003: usage from the stored Snapshots of the other present repositories (ADR-0311). */
export async function buildDeployKeyUsage(
  deps: Pick<AnalysisDeps, 'db' | 'appPool'>,
  routeId: string,
  ownRepositoryId: string,
  ownMigrationId: string,
  sources: Json,
): Promise<{
  usage: Record<string, number>;
  own: string[];
  holdersOfChangedKeys: string[];
}> {
  const peers = await deps.db.migration.findMany({
    where: {
      routeId,
      scope: 'repository',
      sourceRepositoryId: { not: ownRepositoryId },
      sourceRepository: { presence: 'present' },
    },
    select: { id: true, sourceRepositoryId: true },
  });
  const repositoryIds = peers.flatMap((p) => (p.sourceRepositoryId ? [p.sourceRepositoryId] : []));
  const latest = await deps.appPool.query<{ repository_id: string; data: unknown }>(
    `SELECT DISTINCT ON (repository_id) repository_id, data
       FROM app.facet_snapshot
      WHERE side = 'source' AND facet_key = 'deploy-keys' AND repository_id = ANY($1::text[])
      ORDER BY repository_id, fetched_at DESC, id DESC`,
    [repositoryIds],
  );
  const others = new Map(latest.rows.map((r) => [r.repository_id, deployKeysOf(r.data)]));
  const own = deployKeysOf(sources['deploy-keys']);
  const previous = await deps.appPool.query<{ data: unknown }>(
    `SELECT data FROM app.facet_snapshot
      WHERE side = 'source' AND facet_key = 'deploy-keys' AND repository_id = $1
      ORDER BY fetched_at DESC, id DESC LIMIT 1`,
    [ownRepositoryId],
  );
  const before = new Set(deployKeysOf(previous.rows[0]?.data));
  const after = new Set(own);
  const changed = new Set([...before, ...after].filter((k) => before.has(k) !== after.has(k)));
  const holders = peers
    .filter((p) => {
      const keys = p.sourceRepositoryId ? others.get(p.sourceRepositoryId) : undefined;
      return keys?.some((k) => changed.has(k)) === true;
    })
    .map((p) => p.id)
    .filter((id) => id !== ownMigrationId);
  return { usage: deployKeyUsage(others, own), own, holdersOfChangedKeys: holders };
}

/** Names from the latest source-side endpoint Snapshot of a list facet (pipelines variables). */
export async function endpointNames(
  db: Db,
  endpointId: string,
  facetKey: string,
): Promise<string[]> {
  const snap = await db.facetSnapshot.findFirst({
    where: { side: 'source', endpointId, repositoryId: null, facetKey },
    orderBy: [{ fetchedAt: 'desc' }, { id: 'desc' }],
    select: { data: true },
  });
  return snap ? namesOf(snap.data) : [];
}

/** LIF-080: the facts the endpoint-level facets read from the route index (ADR-0311). */
export async function endpointRouteIndex(
  db: Db,
  route: { id: string; sourceEndpointId: string; targetEndpointId: string },
): Promise<Json> {
  const members = await db.identity.findMany({
    where: { endpointId: route.targetEndpointId, isMember: true },
    select: { providerId: true },
    orderBy: { providerId: 'asc' },
  });
  const groups = await db.groupMapping.findMany({
    where: { routeId: route.id },
    include: { sourceGroup: { select: { providerId: true } } },
  });
  const plannedSlugs = Object.fromEntries(
    groups.map((g) => [g.sourceGroup.providerId, g.plannedSlug]),
  );
  const withEmail = await db.identity.findMany({
    where: { endpointId: route.sourceEndpointId, email: { not: null } },
    select: { id: true, providerId: true },
  });
  const mappings = await db.identityMapping.findMany({
    where: { routeId: route.id, sourceIdentityId: { in: withEmail.map((i) => i.id) } },
    select: { sourceIdentityId: true, status: true },
  });
  const status = new Map(mappings.map((m) => [m.sourceIdentityId, m.status]));
  const invitationCandidates = withEmail
    .filter((i) => {
      const s = status.get(i.id);
      return s === undefined || s === 'unmapped';
    })
    .map((i) => i.providerId)
    .sort();
  return {
    targetOrgMembers: members.map((m) => m.providerId),
    plannedSlugs,
    invitationCandidates,
  };
}

interface PlanNamingInput {
  readonly deps: AnalysisDeps;
  readonly routeId: string;
  readonly routeDefaults: unknown;
  readonly migrationId: string;
  readonly targetEndpointId: string;
  readonly targetRepositoryId: string | null;
  readonly targetRepository: { providerId: string; slug: string } | null;
  readonly targetNsRef: NamespaceRef;
  readonly targetConn: EndpointConnection;
  readonly checkpoint: () => void;
  readonly calls: { n: number };
}

/** LIF-030, LIF-031 and analysis step 3: names, collisions and the target repository. */
async function planNaming(input: PlanNamingInput): Promise<{
  entry: RouteNamingEntry;
  live: RepositoryRecord | null;
  liveDbId: string | null;
}> {
  const { db } = input.deps;
  const [peers, rules] = await Promise.all([
    db.migration.findMany({
      where: {
        routeId: input.routeId,
        scope: 'repository',
        sourceRepository: { presence: 'present' },
      },
      select: {
        id: true,
        targetRepositoryId: true,
        sourceRepository: {
          select: {
            id: true,
            slug: true,
            name: true,
            namespaceId: true,
            namespace: { select: { key: true, slug: true, name: true } },
          },
        },
      },
    }),
    db.namingRule.findMany({ where: { routeId: input.routeId } }),
  ]);
  const routeDefault = routeNaming(input.routeDefaults);
  const ruleFor = (repoId: string, nsId: string): NamingRules => {
    const repo = rules.find((r) => r.scope === 'repository' && r.scopeRef === repoId);
    const ns = rules.find((r) => r.scope === 'namespace' && r.scopeRef === nsId);
    return {
      override: repo?.override ?? null,
      repositoryPipeline: (repo?.pipeline as NamingPipeline | undefined) ?? null,
      namespacePipeline: (ns?.pipeline as NamingPipeline | undefined) ?? null,
      routeDefault,
    };
  };
  const inputs = peers.flatMap((p) => {
    const r = p.sourceRepository;
    if (!r) return [];
    return [
      {
        id: p.id,
        source: {
          namespace: { key: r.namespace.key, slug: r.namespace.slug, name: r.namespace.name },
          repository: { slug: r.slug, name: r.name },
        },
        rules: ruleFor(r.id, r.namespaceId),
        targetRepositoryId: p.targetRepositoryId,
      },
    ];
  });
  const me = inputs.find((i) => i.id === input.migrationId);
  if (!me) throw new AnalysisError(`Migration ${input.migrationId} is not part of its Route plan`);
  const limits = input.targetConn.limits.repositoryName;

  // The live target decides what exists: by the owned id first, then by the planned name.
  const mine = resolveTargetName(me.rules, me.source, limits);
  const { targetConn, targetNsRef } = input;
  let live: RepositoryRecord | null = null;
  if (input.targetRepository) {
    input.calls.n++;
    live = await targetConn.inventory.getRepository({
      providerId: input.targetRepository.providerId,
      namespace: targetNsRef,
      slug: input.targetRepository.slug,
    });
  }
  if (!live && mine.ok) {
    input.calls.n++;
    live = await targetConn.inventory.findRepository(targetNsRef, mine.name);
  }
  input.checkpoint();
  let liveDbId: string | null = null;
  let hasRefs = true;
  if (live) {
    const row = await db.repository.findFirst({
      where: { endpointId: input.targetEndpointId, providerId: live.providerId },
      select: { id: true },
    });
    liveDbId = row?.id ?? null;
    input.calls.n++;
    hasRefs = !(await targetConn.repositories.isEmpty({
      providerId: live.providerId,
      namespace: targetNsRef,
      slug: live.slug,
    }));
  }
  const claimed = await db.repository.findMany({
    where: {
      endpointId: input.targetEndpointId,
      id: { in: peers.flatMap((p) => (p.targetRepositoryId ? [p.targetRepositoryId] : [])) },
    },
    select: { id: true, name: true },
  });
  const existing = new Map(claimed.map((c) => [c.id, { id: c.id, name: c.name, hasRefs: true }]));
  if (live) {
    const id = liveDbId ?? `live:${live.providerId}`;
    existing.set(id, { id, name: live.name, hasRefs });
  }
  const plan = planRouteNaming(inputs, limits, [...existing.values()]);
  const entry = plan.entries.find((e) => e.id === input.migrationId) as RouteNamingEntry;
  return { entry, live, liveDbId };
}

async function recordCalls(pool: pg.Pool, routeId: string, calls: number, log: Logger) {
  try {
    await pool.query(
      `UPDATE app.route
          SET avg_calls_per_analysis = avg_calls_per_analysis + $3 * ($2 - avg_calls_per_analysis)
        WHERE id = $1`,
      [routeId, calls, CALLS_EMA_WEIGHT],
    );
  } catch (error) {
    log.warn({ err: error, routeId }, 'could not update the calls per analysis mean');
  }
}

/**
 * Records the attempt before it runs (ADR-0312): count + 1, failed now, retry after the capped
 * backoff, all on the database clock. A success clears it, so what stays is exactly a job that
 * failed or whose worker died (a deterministic crash backs off like any other failure). Only the
 * first attempt of a job counts; BullMQ's own retries of it do not add to the count.
 */
async function markAttempt(pool: pg.Pool, migrationId: string, log: Logger): Promise<void> {
  try {
    await pool.query(
      `UPDATE app.migration
          SET analysis_failure_count = analysis_failure_count + 1,
              analysis_failed_at = clock_timestamp(),
              analysis_retry_at = clock_timestamp()
                + LEAST($2::float8 * power(2, analysis_failure_count), $3::float8)
                  * interval '1 millisecond'
        WHERE id = $1`,
      [migrationId, FAILURE_BACKOFF_BASE_MS, FAILURE_BACKOFF_CAP_MS],
    );
  } catch (error) {
    log.warn({ err: error, migrationId }, 'could not record the analysis attempt');
  }
}

/**
 * The failure marker for an Analysis that a Run started inline (ADR-0312): the feeder backs off
 * from a Migration whose Analysis fails. The `analysis.migration` handler writes it for its own
 * jobs; the Run executor calls this for `analyzeForRun` (ADR-0343).
 */
export async function recordAnalysisFailure(
  pool: pg.Pool,
  migrationId: string,
  log: Logger,
): Promise<void> {
  await markAttempt(pool, migrationId, log);
  await restampFailure(pool, migrationId, log);
}

/** A Migration that needs no Analysis (missing, retired) must not stay marked as failing. */
async function clearAttempt(pool: pg.Pool, migrationId: string): Promise<void> {
  await pool.query(
    `UPDATE app.migration
        SET analysis_failure_count = 0, analysis_failed_at = NULL, analysis_retry_at = NULL
      WHERE id = $1`,
    [migrationId],
  );
}

/** The backoff after a failure that has just been counted, measured from now (database clock). */
async function restampFailure(pool: pg.Pool, migrationId: string, log: Logger): Promise<void> {
  try {
    await pool.query(
      `UPDATE app.migration
          SET analysis_failed_at = clock_timestamp(),
              analysis_retry_at = clock_timestamp()
                + LEAST($2::float8 * power(2, GREATEST(analysis_failure_count - 1, 0)), $3::float8)
                  * interval '1 millisecond'
        WHERE id = $1 AND analysis_failure_count > 0`,
      [migrationId, FAILURE_BACKOFF_BASE_MS, FAILURE_BACKOFF_CAP_MS],
    );
  } catch (error) {
    log.warn({ err: error, migrationId }, 'could not record the analysis failure');
  }
}

/** A shutdown is not a failure: takes the attempt that was recorded at the start back. */
async function undoAttempt(pool: pg.Pool, migrationId: string, log: Logger): Promise<void> {
  try {
    await pool.query(
      `UPDATE app.migration
          SET analysis_failure_count = GREATEST(analysis_failure_count - 1, 0),
              analysis_failed_at = CASE WHEN analysis_failure_count <= 1 THEN NULL ELSE analysis_failed_at END,
              analysis_retry_at = CASE WHEN analysis_failure_count <= 1 THEN NULL ELSE analysis_retry_at END
        WHERE id = $1`,
      [migrationId],
    );
  } catch (error) {
    log.warn({ err: error, migrationId }, 'could not undo the analysis attempt');
  }
}

/**
 * The `analysis.migration` handler (JOB-020). A fault that retrying cannot fix (`AnalysisError`)
 * fails the job without further attempts. The attempt is recorded before it runs (a dying worker
 * leaves it), restamped when the job's last attempt fails so the backoff runs from the failure and
 * not from the start, and taken back on a shutdown.
 */
export function analysisHandlers(deps: AnalysisDeps): JobHandlers {
  return {
    'analysis.migration': async ({ migrationId }, ctx) => {
      const counted = (ctx.job.attemptsMade ?? 0) === 0;
      if (counted) await markAttempt(deps.appPool, migrationId, ctx.log);
      try {
        const result = await runAnalysis(deps, migrationId, {
          shutdown: ctx.shutdown,
          pool: ctx.queue === 'analysis-interactive' ? 'interactive' : 'background',
          log: ctx.log,
        });
        if (result.skipped) await clearAttempt(deps.appPool, migrationId);
        return result;
      } catch (error) {
        if (error instanceof AnalysisInterruptedError) {
          if (counted) await undoAttempt(deps.appPool, migrationId, ctx.log);
          throw error;
        }
        const attempts = ctx.job.opts?.attempts ?? 1;
        const final = error instanceof AnalysisError || (ctx.job.attemptsMade ?? 0) + 1 >= attempts;
        if (final) await restampFailure(deps.appPool, migrationId, ctx.log);
        if (error instanceof AnalysisError) throw new UnrecoverableError(error.message);
        throw error;
      }
    },
  };
}

export type { FacetDefinition };
