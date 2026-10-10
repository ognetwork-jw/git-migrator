/**
 * The Parity Check (LIF-060): re-reads the source and the target of a Migration, translates the
 * source to the desired target document (LIF-045 source-side filtering, Overlays merged in), compares
 * it with the actual target per Facet, and subtracts the active Expected Differences (LIF-063). The
 * result is data; `store.ts` writes it. Everything that reaches a provider goes through
 * `EndpointConnector` and the adapters' drivers, so quota and raw capture apply (ADP-060).
 * Decisions: docs/adr/0396-parity-engine-and-verified-status.md, 0397-parity-git-checks.md.
 */

import {
  type EndpointConnection,
  type FacetRead,
  type FacetTarget,
  type GitClient,
  isAdapterError,
  type NamespaceRef,
  type RepositoryRef,
  stripText,
} from '@git-migrator/adapter-sdk';
import {
  compareFacet,
  type ExpectedDifferenceRecord,
  type FacetCapability,
  type FacetDefinition,
  FacetEngineError,
  type FacetLookup,
  type FacetTranslation,
  type FieldDiff,
  hashCanonical,
  mergeOverlay,
  NO_CAPABILITY,
  type ParityStatus,
  resolveRoutePolicies,
  translateAll,
} from '@git-migrator/core';
import type { Db } from '@git-migrator/db';
import type { GitQuota } from '@git-migrator/git';
import type { Logger } from '@git-migrator/observability';
import type { ProviderRegistry } from '@git-migrator/registry';
import type pg from 'pg';
import {
  adapterCaps,
  buildDeployKeyUsage,
  effectiveCaps,
  endpointNames,
  endpointRouteIndex,
  jsonSafe,
  loadGroupMappings,
  loadIdentityMappings,
  rootNamespace,
} from '../analysis/analysis.ts';
import { collectPrincipals, groupResolver, identityResolver } from '../analysis/context.ts';
import { type SourceLockView, sourceLockView } from '../analysis/framework-resources.ts';
import { databaseNow } from '../db-clock.ts';
import type { EndpointConnector } from '../inventory/connector.ts';
import { isRateLimited } from '../run/errors.ts';
import { loadPlacement, placementOutside, placementUnknown } from '../run/placement.ts';
import { applyContainment, checkLfsObjects } from './git.ts';
import { redactAtPath } from './redact.ts';

type Json = Record<string, unknown>;

/** Diffs kept in one ParityResult; the status stays `different` however many there are. */
export const MAX_STORED_DIFFS = 1_000;

/**
 * The LFS objects the source's refs reference (FAC-GIT-005): `git lfs ls-files --all` over a mirror.
 * Injected, because it needs a scratch directory and git credentials (the worker builds it with the
 * `@git-migrator/git` service, `createMirrorLfsSource`).
 */
export interface LfsObjectSource {
  objects(input: {
    readonly connection: EndpointConnection;
    readonly repository: RepositoryRef;
    readonly migrationId: string;
    readonly signal: AbortSignal;
    /** Repository size, for the JOB-015 disk precheck. */
    readonly sizeBytes: bigint | null;
    /** The `git` bucket of the source credential (JOB-041); absent in tests. */
    readonly quota?: GitQuota | undefined;
    /** The Run's mirror from `git.prepare`, when the check runs inside a Run. */
    readonly mirrorDir?: string | undefined;
  }): Promise<readonly { readonly oid: string; readonly size: number }[]>;
}

export interface ParityDeps {
  readonly db: Db;
  readonly appPool: pg.Pool;
  readonly connector: EndpointConnector;
  readonly registry: Pick<ProviderRegistry, 'adapter' | 'facets' | 'capabilities'>;
  /** The git transport of the `git-refs` read (ls-remote). */
  readonly git: GitClient;
  readonly log: Logger;
  /** Without it LFS parity is not checked (the Facet's own `compare` still is). */
  readonly lfs?: LfsObjectSource;
  /** `schedules.driftReadsSource` (LIF-060 step 1): a drift check reads the full source only when set. */
  readonly driftReadsSource?: boolean;
  readonly now?: () => Date;
}

export interface ParityOptions {
  readonly shutdown: AbortSignal;
  /** `interactive` for a Run an operator waits for, `background` for scheduled checks. */
  readonly pool: 'interactive' | 'background';
  /** `skip` leaves LFS out, for a drift check whose refs did not change (FAC-GIT-005). Default `check`. */
  readonly lfs?: 'check' | 'skip';
  /**
   * Inside a Run: the source mirror `git.prepare` made (see `ParityServices`). The LFS object ids
   * are read from it instead of mirroring the source again.
   */
  readonly mirrorDir?: string | undefined;
  readonly log?: Logger;
  /**
   * A scheduled drift check (LIF-065, LIF-060 step 1): it re-reads the target and the source
   * `git-refs`, and takes every other source Facet from the Snapshots of the Migration's latest
   * Analysis unless `readsSource` (`schedules.driftReadsSource`). When the refs it reads are the
   * ones that Analysis saw, the LFS check is skipped (FAC-GIT-005). A Migration without an Analysis
   * is read in full.
   */
  readonly drift?: { readonly readsSource: boolean };
}

/**
 * What a Run's `services` may offer the `verify` Step (T-071 supplies it from `git.prepare`):
 * `sourceMirror(runId)` is the directory of the Run's bare mirror of the source, or `undefined`
 * when there is none (then the check mirrors the source itself, metered and prechecked).
 */
export interface ParityServices {
  sourceMirror?(runId: string): string | undefined;
}

/** The scratch volume is too small for the check's mirror (JOB-015): the Facet is unverifiable. */
export class ScratchInsufficientError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`The scratch volume cannot hold the mirror (${code})`);
    this.name = 'ScratchInsufficientError';
    this.code = code;
  }
}

/** One diff as stored (`ParityResult.diffs`): both sides redacted. */
export interface StoredDiff {
  readonly path: string;
  /** The desired value (translated from the source). */
  readonly source: unknown;
  /** The actual value on the target. */
  readonly target: unknown;
}

/** A diff hidden by an Expected Difference (`ParityResult.excluded`). */
export interface StoredExclusion {
  readonly path: string;
  readonly expectedDifferenceId: string | null;
  readonly reason: string;
  /** Set on the `truncated` entry: how many exclusions there were. */
  readonly total?: number;
}

export interface FacetParity {
  readonly facetKey: string;
  readonly status: ParityStatus;
  readonly diffs: readonly StoredDiff[];
  readonly excluded: readonly StoredExclusion[];
  /** Why the Facet is `unverifiable`. Logged, never stored. */
  readonly reason?: string;
  /** The actual document and the remaining diffs, for `isTaskSatisfied` (LIF-061). Never stored. */
  readonly evidence?: { readonly target: unknown; readonly diffs: readonly FieldDiff[] };
}

export type ParitySkip =
  | 'migration-missing'
  | 'route-retired'
  | 'no-source'
  | 'source-missing'
  /** The Route was retargeted after the framework wrote the target (ADR-0504). */
  | 'target-outside-route'
  /** Legacy target writes whose place is not confirmed (ADR-0504). */
  | 'target-placement-unknown';

export type ParityComputation =
  | { readonly skipped: ParitySkip }
  | {
      readonly skipped?: undefined;
      readonly migrationId: string;
      /** When the check started, on the database clock: it orders checks of one Migration. */
      readonly checkedAt: Date;
      /** `Migration.parityGeneration` when the check started (ADR-0396). */
      readonly generation: bigint;
      readonly facets: readonly FacetParity[];
    };

/** A configuration or data problem that retrying cannot fix. */
export class ParityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParityError';
  }
}

type SideRead =
  | { readonly ok: true; readonly read: FacetRead<unknown>; readonly caps: FacetCapability }
  | { readonly ok: false; readonly reason: string };

const reasonOf = (error: unknown): string => {
  if (isAdapterError(error)) return error.code;
  if (error instanceof FacetEngineError || error instanceof ScratchInsufficientError) {
    return error.code;
  }
  return 'error';
};

/** Rate limits and a stop request end the check; every other failure only makes a Facet unverifiable. */
function propagate(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || isRateLimited(error);
}

/** The Facets whose documents the check needs: the compared ones and what they depend on. */
function neededFacets(defs: readonly FacetDefinition<unknown>[]): Set<string> {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const needed = new Set<string>();
  const visit = (key: string): void => {
    if (needed.has(key)) return;
    const def = byKey.get(key);
    if (!def) return;
    needed.add(key);
    for (const dep of def.dependsOn) visit(dep);
  };
  for (const def of defs) if (def.compareMode === 'full') visit(def.key);
  return needed;
}

/** `roots` and everything they depend on. */
function closureOf(
  defs: readonly FacetDefinition<unknown>[],
  roots: readonly string[],
): Set<string> {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const out = new Set<string>();
  const visit = (key: string): void => {
    if (out.has(key)) return;
    const def = byKey.get(key);
    if (!def) return;
    out.add(key);
    for (const dep of def.dependsOn) visit(dep);
  };
  for (const root of roots) visit(root);
  return out;
}

/** The source Snapshots of a Migration's latest Analysis, by Facet key (LIF-065). */
async function latestSourceSnapshots(
  db: Db,
  analysisId: string | null,
): Promise<Map<string, { data: unknown; unreadable: string[]; hash: string }> | undefined> {
  if (analysisId === null) return undefined;
  const analysis = await db.analysis.findUnique({
    where: { id: analysisId },
    select: { sourceSnapshotIds: true },
  });
  if (!analysis || analysis.sourceSnapshotIds.length === 0) return undefined;
  const rows = await db.facetSnapshot.findMany({
    where: { id: { in: analysis.sourceSnapshotIds }, side: 'source' },
    select: { facetKey: true, data: true, unreadable: true, hash: true },
  });
  return new Map(rows.map((r) => [r.facetKey, r]));
}

/** The first Facet among `def`'s transitive dependencies whose source read failed, if any. */
function brokenDependency(
  def: FacetDefinition<unknown>,
  byKey: ReadonlyMap<string, FacetDefinition<unknown>>,
  reads: ReadonlyMap<string, SideRead>,
): string | undefined {
  const seen = new Set<string>();
  const visit = (key: string): string | undefined => {
    if (seen.has(key)) return undefined;
    seen.add(key);
    const side = reads.get(key);
    if (side && !side.ok) return key;
    for (const dep of byKey.get(key)?.dependsOn ?? []) {
      const found = visit(dep);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  for (const dep of def.dependsOn) {
    const found = visit(dep);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Wraps a registry so one Facet's `compare` returns `diffs` (already adjusted by git checks). */
function withDiffs(
  registry: FacetLookup,
  facetKey: string,
  diffs: readonly FieldDiff[],
): FacetLookup {
  return {
    has: (key) => registry.has(key),
    override: (pair, key) => registry.override(pair, key),
    ordered: () => registry.ordered(),
    get: (key) =>
      key === facetKey
        ? { ...registry.get(key), compare: () => diffs.map((d) => ({ ...d })) }
        : registry.get(key),
  };
}

const unverifiable = (facetKey: string, reason: string): FacetParity => ({
  facetKey,
  status: 'unverifiable',
  diffs: [],
  excluded: [],
  reason,
});

const describeError = (error: unknown): string => stripText(String(error)).slice(0, 300);

/**
 * One Parity Check of a Migration (LIF-060). Reads, translates and compares; writes nothing. A
 * failure of one Facet makes that Facet `unverifiable` and never ends the check (LIF-042); a rate
 * limit or a stop request does end it (the caller delays or stops).
 */
export async function computeParity(
  deps: ParityDeps,
  migrationId: string,
  options: ParityOptions,
): Promise<ParityComputation> {
  const { db, registry } = deps;
  const log = (options.log ?? deps.log).child?.({ migrationId }) ?? deps.log;
  const signal = options.shutdown;
  // Before any provider read: a check that started before the latest stored one must not replace it.
  const checkStartedAt = await databaseNow(db);

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
  // Reading the Route's new place would report every Facet as missing on the target; the check is
  // skipped with the reason instead, and the Analysis blocker says what to do (ADR-0504).
  const placement = await loadPlacement(db, migrationId);
  if (placementOutside(placement, route)) return { skipped: 'target-outside-route' };
  // Legacy target writes of unknown place: the Route's place may not be where they are, so nothing
  // is read or completed until the operator confirms it (ADR-0504).
  if (placement === undefined && (await placementUnknown(db, migrationId))) {
    return { skipped: 'target-placement-unknown' };
  }
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
    throw new ParityError(`Route ${route.id} has a retired Endpoint`);
  }
  const sourceType = sourceEndpoint.providerType;
  const targetType = targetEndpoint.providerType;
  for (const type of [sourceType, targetType]) {
    try {
      registry.capabilities(type);
    } catch {
      throw new ParityError(`Provider type ${type} of Route ${route.id} is not registered`);
    }
  }
  const targetNamespace = route.targetNamespaceId
    ? await db.namespace.findUnique({ where: { id: route.targetNamespaceId } })
    : null;
  if (!targetNamespace) {
    throw new ParityError(`The target namespace of Route ${route.id} is not resolved yet`);
  }

  const scopeKind = isRepository ? 'repository' : 'endpoint';
  const facetDefs = registry.facets.ordered().filter((d) => d.scope === scopeKind);
  const needed = neededFacets(facetDefs);
  const compared = facetDefs.filter((d) => d.compareMode === 'full');

  const [sourceConn, targetConn] = await Promise.all([
    deps.connector.connect(route.sourceEndpointId, { pool: options.pool, signal }),
    deps.connector.connect(route.targetEndpointId, { pool: options.pool, signal }),
  ]);
  const driverContext = (conn: EndpointConnection) => ({
    http: conn.http,
    git: deps.git,
    logger: log as never,
    pool: options.pool,
    signal,
  });

  const readSide = async (
    conn: EndpointConnection,
    type: string,
    target: FacetTarget,
    keys: ReadonlySet<string>,
  ): Promise<Map<string, SideRead>> => {
    const ctx = driverContext(conn);
    const out = new Map<string, SideRead>();
    for (const def of facetDefs) {
      if (!keys.has(def.key)) continue;
      signal.throwIfAborted();
      const base = adapterCaps(registry, type, def.key);
      const real = conn.facets[def.key as keyof typeof conn.facets];
      if (!base?.read || !real) continue;
      try {
        const read = await real.read(ctx, target);
        out.set(def.key, { ok: true, read, caps: effectiveCaps(base, read) });
      } catch (error) {
        if (propagate(error, signal)) throw error;
        log.warn(
          { facetKey: def.key, code: reasonOf(error), message: describeError(error) },
          'a Facet could not be read for parity',
        );
        out.set(def.key, { ok: false, reason: `read-failed:${reasonOf(error)}` });
      }
    }
    return out;
  };

  // -- the source ----------------------------------------------------------------------------
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
  // LIF-045: what the framework created on the source is left out of the read, by identity. While
  // a lock write is unsettled and its state cannot be told, the Facets it writes are unverifiable
  // rather than compared (ADR-0425).
  const view: SourceLockView = sourceRef
    ? await sourceLockView(db, migrationId, sourceConn.sourceLock, sourceRef, signal)
    : { resources: [], withheld: [] };
  // A drift check reads only the source `git-refs` live (LIF-060 step 1); the other Facets of the
  // source come from the Analysis' Snapshots, which were read through the same lock view.
  const stored =
    options.drift && isRepository
      ? await latestSourceSnapshots(db, migration.latestAnalysisId)
      : undefined;
  const refsOnly = stored !== undefined && options.drift?.readsSource === false;
  // A Facet the Analysis has no Snapshot of (it withheld or could not read it) is read live: it is
  // never dropped from the check, which would leave its last result or none (ADR-0466 round 2).
  const liveKeys = refsOnly ? closureOf(facetDefs, ['git-refs']) : needed;
  if (refsOnly && stored) {
    for (const key of needed) {
      if (!liveKeys.has(key) && !stored.has(key)) {
        for (const dep of closureOf(facetDefs, [key])) liveKeys.add(dep);
      }
    }
  }
  const sourceReads = await readSide(
    sourceConn,
    sourceType,
    sourceRef
      ? {
          scope: 'repository',
          repository: sourceRef,
          namespace: sourceNsRef,
          frameworkResources: view.resources,
        }
      : { scope: 'endpoint', namespace: sourceNsRef },
    new Set([...liveKeys].filter((k) => !view.withheld.includes(k))),
  );
  if (refsOnly && stored) {
    for (const key of needed) {
      if (liveKeys.has(key) || view.withheld.includes(key)) continue;
      const snapshot = stored.get(key);
      const base = adapterCaps(registry, sourceType, key as never);
      if (!snapshot || !base?.read) continue;
      const read: FacetRead<unknown> = {
        data: snapshot.data,
        unreadable: snapshot.unreadable,
        warnings: [],
        rawResponseIds: [],
      };
      sourceReads.set(key, { ok: true, read, caps: effectiveCaps(base, read) });
    }
  }
  for (const key of view.withheld) {
    if (needed.has(key)) sourceReads.set(key, { ok: false, reason: 'source-lock-unsettled' });
  }
  // LFS objects cannot have changed when the source refs are the ones the Analysis saw (FAC-GIT-005).
  const liveRefs = sourceReads.get('git-refs');
  const refsUnchanged =
    stored !== undefined &&
    liveRefs?.ok === true &&
    stored.get('git-refs')?.hash === hashCanonical(jsonSafe(liveRefs.read.data));

  // -- the target ----------------------------------------------------------------------------
  const targetNsRef: NamespaceRef = {
    providerId: targetNamespace.providerId,
    slug: targetNamespace.slug,
  };
  const comparedKeys = new Set(compared.map((d) => d.key));
  let targetRef: RepositoryRef | undefined;
  let targetReads = new Map<string, SideRead>();
  let targetMissing = false;
  if (isRepository) {
    const owned = migration.targetRepository;
    const live = owned
      ? await targetConn.inventory.getRepository({
          providerId: owned.providerId,
          namespace: targetNsRef,
          slug: owned.slug,
        })
      : null;
    // The lookup must find the repository this Migration migrated to, not one that now has its name.
    if (live && owned && live.providerId === owned.providerId) {
      targetRef = { providerId: live.providerId, namespace: targetNsRef, slug: live.slug };
      targetReads = await readSide(
        targetConn,
        targetType,
        { scope: 'repository', repository: targetRef, namespace: targetNsRef },
        comparedKeys,
      );
    } else {
      targetMissing = true;
    }
  } else {
    targetReads = await readSide(
      targetConn,
      targetType,
      { scope: 'endpoint', namespace: targetNsRef },
      comparedKeys,
    );
  }

  const sources: Record<string, unknown> = {};
  const attachments: Record<string, string> = {};
  const sourceCaps: Record<string, FacetCapability> = {};
  for (const [key, side] of sourceReads) {
    if (!side.ok) continue;
    sources[key] = side.read.data;
    Object.assign(attachments, side.read.attachments ?? {});
    sourceCaps[key] = side.caps;
  }
  const targetCaps: Record<string, FacetCapability> = {};
  for (const def of facetDefs) {
    const side = targetReads.get(def.key);
    const base = adapterCaps(registry, targetType, def.key);
    if (side?.ok) targetCaps[def.key] = side.caps;
    else if (base) targetCaps[def.key] = effectiveCaps(base, undefined);
  }

  // -- the translate environment (the same inputs as the Analysis) ---------------------------
  signal.throwIfAborted();
  const principals = [...collectPrincipals(sources).values()];
  const [identityRows, groupRows, allowlist, overlays, eds] = await Promise.all([
    loadIdentityMappings(db, route.id, route.sourceEndpointId, principals),
    loadGroupMappings(db, route.id, route.sourceEndpointId),
    db.webhookAllowlistEntry.findMany({ where: { routeId: route.id }, select: { pattern: true } }),
    db.overlay.findMany({
      where: { routeId: route.id, enabled: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    db.expectedDifference.findMany({
      where: {
        routeId: route.id,
        revokedAt: null,
        OR: [{ migrationId: null }, { migrationId }],
      },
    }),
  ]);
  const routeIndex: Json = {};
  if (isRepository && sourceRepository) {
    const usage = await buildDeployKeyUsage(
      deps,
      route.id,
      sourceRepository.id,
      migrationId,
      sources,
    );
    routeIndex.deployKeyUsage = usage.usage;
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
    policies: resolveRoutePolicies(route.policies),
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

  // -- LIF-060 step 2: desired ---------------------------------------------------------------
  let translations: FacetTranslation[];
  try {
    translations = translateAll(registry.facets, {
      env,
      sources,
      sourceCaps,
      targetCaps,
      pair: { source: sourceType, target: targetType },
      migrationId,
      expectedDifferences: edRecords,
    }).translations;
  } catch (error) {
    if (!(error instanceof FacetEngineError)) throw error;
    log.warn({ code: error.code, facetKey: error.facetKey }, 'translation failed during parity');
    return {
      migrationId,
      checkedAt: checkStartedAt,
      generation: migration.parityGeneration,
      facets: compared
        .filter((d) => sourceReads.has(d.key))
        .map((d) => unverifiable(d.key, `translate-failed:${error.code}`)),
    };
  }
  const translationOf = new Map(translations.map((t) => [t.facetKey, t]));

  // -- LIF-060 steps 3 to 5, per Facet -------------------------------------------------------
  const facets: FacetParity[] = [];
  const defByKey = new Map(facetDefs.map((d) => [d.key, d]));
  for (const def of compared) {
    signal.throwIfAborted();
    // The source decides which Facets the Migration has (as in the Analysis): no source read, no
    // desired document, nothing to compare.
    const sourceSide = sourceReads.get(def.key);
    if (!sourceSide) continue;
    if (!sourceSide.ok) {
      facets.push(unverifiable(def.key, sourceSide.reason));
      continue;
    }
    // A Facet translated from a degraded dependency would compare against the wrong document.
    const broken = brokenDependency(def, defByKey, sourceReads);
    if (broken !== undefined) {
      facets.push(unverifiable(def.key, `dependency-unreadable:${broken}`));
      continue;
    }
    const translation = translationOf.get(def.key);
    if (!translation) {
      facets.push(unverifiable(def.key, 'source-unreadable'));
      continue;
    }
    if (targetMissing) {
      facets.push(unverifiable(def.key, 'target-missing'));
      continue;
    }
    const targetSide = targetReads.get(def.key);
    if (!targetSide) {
      facets.push(unverifiable(def.key, 'target-unreadable'));
      continue;
    }
    if (!targetSide.ok) {
      facets.push(unverifiable(def.key, targetSide.reason));
      continue;
    }
    try {
      facets.push(
        await compareOne({
          deps,
          options,
          def,
          migration,
          sourceRepository: sourceRepository ?? undefined,
          sourceEndpointId: route.sourceEndpointId,
          sourceConn,
          sourceRef,
          targetConn,
          targetRef,
          translation,
          actual: targetSide.read.data,
          overlays: overlays.filter((o) => o.facetKey === def.key).map((o) => o.data),
          env,
          caps: targetCaps[def.key] ?? NO_CAPABILITY,
          eds: edRecords,
          refsUnchanged,
        }),
      );
    } catch (error) {
      if (propagate(error, signal)) throw error;
      log.warn(
        { facetKey: def.key, code: reasonOf(error), message: describeError(error) },
        'a Facet could not be compared',
      );
      facets.push(unverifiable(def.key, `compare-failed:${reasonOf(error)}`));
    }
  }
  return { migrationId, checkedAt: checkStartedAt, generation: migration.parityGeneration, facets };
}

interface CompareOneInput {
  readonly deps: ParityDeps;
  readonly options: ParityOptions;
  readonly def: FacetDefinition<unknown>;
  readonly migration: { readonly id: string; readonly sourceReadOnlyApplied: boolean };
  readonly sourceRepository:
    | { readonly lfsBytes: bigint | null; readonly sizeBytes: bigint | null }
    | undefined;
  readonly sourceEndpointId: string;
  readonly sourceConn: EndpointConnection;
  readonly sourceRef: RepositoryRef | undefined;
  readonly targetConn: EndpointConnection;
  readonly targetRef: RepositoryRef | undefined;
  readonly translation: FacetTranslation;
  readonly actual: unknown;
  readonly overlays: readonly unknown[];
  readonly env: { readonly route: Json; readonly routeIndex: Json };
  readonly caps: FacetCapability;
  readonly eds: readonly ExpectedDifferenceRecord[];
  /** A drift check whose source refs equal the Analysis' (LFS is skipped, FAC-GIT-005). */
  readonly refsUnchanged: boolean;
}

async function compareOne(input: CompareOneInput): Promise<FacetParity> {
  const { deps, def, translation } = input;
  const registry = deps.registry.facets;
  const schema = { collections: def.collections, sets: def.sets ?? [] };
  let desired = translation.desired;
  for (const overlay of input.overlays) desired = mergeOverlay(desired, overlay, schema).merged;
  const compareInput = {
    migrationId: input.migration.id,
    ctx: { targetCaps: input.caps, route: input.env.route, routeIndex: input.env.routeIndex },
  };
  const adjusted =
    def.key === 'git-refs' ? await gitDiffs(input, desired, compareInput) : undefined;
  const result = compareFacet(
    adjusted ? withDiffs(registry, def.key, adjusted) : registry,
    def.key,
    desired,
    input.actual,
    { ...compareInput, expectedDifferences: input.eds },
  );
  if (!result) throw new ParityError(`Facet ${def.key} writes no ParityResult`);
  return {
    facetKey: def.key,
    status: result.status,
    diffs: result.diffs.slice(0, MAX_STORED_DIFFS).map((d) => ({
      path: d.path,
      source: redactAtPath(def.key, d.path, d.desired),
      target: redactAtPath(def.key, d.path, d.actual),
    })),
    excluded: cappedExclusions(
      result.masked.map((m) => ({
        path: m.diff.path,
        expectedDifferenceId: m.expectedDifferenceId ?? null,
        reason: m.reason,
      })),
    ),
    evidence: { target: input.actual, diffs: result.diffs },
  };
}

/** At most `MAX_STORED_DIFFS` exclusions; a last entry with reason `truncated` carries the total. */
function cappedExclusions(all: StoredExclusion[]): StoredExclusion[] {
  if (all.length <= MAX_STORED_DIFFS) return all;
  return [
    ...all.slice(0, MAX_STORED_DIFFS),
    { path: '', expectedDifferenceId: null, reason: 'truncated', total: all.length },
  ];
}

/**
 * The `git-refs` diffs after the checks beyond `compare`: containment once the source is read-only
 * (FAC-GIT-006) and LFS parity (FAC-GIT-005). Containment sees the diffs before Expected
 * Differences are subtracted, so a relaxed ref is dropped, not "excluded".
 */
async function gitDiffs(
  input: CompareOneInput,
  desired: unknown,
  compareInput: { migrationId: string; ctx: Json },
): Promise<FieldDiff[]> {
  const registry = input.deps.registry.facets;
  const strict = compareFacet(registry, 'git-refs', desired, input.actual, compareInput);
  let diffs: FieldDiff[] = strict ? [...strict.diffs] : [];
  const { deps, options, targetRef, sourceRef } = input;
  if (input.migration.sourceReadOnlyApplied && targetRef) {
    diffs = await applyContainment({
      diffs,
      desired: desired as { refs: [] },
      actual: input.actual as { refs: [] },
      compare: (base, head) => input.targetConn.refs.compare(targetRef, base, head),
    });
  }
  // `lfsBytes` is what the last Run measured on the source: zero means it has no LFS objects.
  const lfsKnownEmpty = input.sourceRepository?.lfsBytes === 0n;
  if (
    deps.lfs &&
    targetRef &&
    sourceRef &&
    options.lfs !== 'skip' &&
    !input.refsUnchanged &&
    !lfsKnownEmpty
  ) {
    const objects = await deps.lfs.objects({
      connection: input.sourceConn,
      repository: sourceRef,
      migrationId: input.migration.id,
      signal: options.shutdown,
      sizeBytes: input.sourceRepository?.sizeBytes ?? null,
      quota: deps.connector.gitQuota?.(input.sourceEndpointId, { pool: options.pool }),
      mirrorDir: options.mirrorDir,
    });
    const lfs = await checkLfsObjects({
      objects,
      missing: (oids) => input.targetConn.lfs.missing(targetRef, oids),
    });
    diffs = [...diffs, ...lfs.diffs];
  }
  return diffs;
}
