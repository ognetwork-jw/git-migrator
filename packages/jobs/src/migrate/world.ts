/**
 * What a Step reads about the Run it belongs to: the Route, both Endpoints, the source repository,
 * the planned target name and the translated Facets of the Run's Analysis. The Analysis is the
 * Run's own (`Run.analysisId`, set by the pre-run Analysis), so a resume and an Analysis taken
 * meanwhile cannot change what a Run applies. Decisions: docs/adr/0380-migration-steps.md.
 */
import type {
  FacetTarget,
  NamespaceRef,
  RepositoryRecord,
  RepositoryRef,
} from '@git-migrator/adapter-sdk';
import type { FieldDecision } from '@git-migrator/core';
import { StepFailure } from '../run/errors.ts';
import { checkPlacement } from '../run/placement.ts';
import type { MigrationContext } from './services.ts';

type Json = Record<string, unknown>;

export interface FacetPlan {
  readonly desired: Json;
  readonly decisions: readonly FieldDecision[];
}

export interface RunWorld {
  readonly migrationId: string;
  readonly routeId: string;
  readonly analysisId: string;
  readonly sourceEndpointId: string;
  readonly targetEndpointId: string;
  readonly sourceType: string;
  readonly targetType: string;
  readonly sourceRepository: {
    readonly id: string;
    readonly providerId: string;
    readonly slug: string;
    readonly fullPath: string;
    readonly sizeBytes: bigint | null;
    readonly lfsBytes: bigint | null;
  };
  readonly sourceRef: RepositoryRef;
  readonly targetNamespace: {
    readonly id: string;
    readonly providerId: string;
    readonly slug: string;
  };
  readonly targetNamespaceRef: NamespaceRef;
  /** The name the Analysis planned (LIF-030). */
  readonly plannedName: string;
  /** Translated Facets of the Run's Analysis by Facet key. */
  readonly facets: ReadonlyMap<string, FacetPlan>;
  /** Run option `adoptNonEmpty` (LIF-043). */
  readonly adoptNonEmpty: boolean;
}

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The translated Facets of an Analysis (`Analysis.translation`) by Facet key. */
export function facetPlansOf(translationJson: unknown): Map<string, FacetPlan> {
  const translation = isObject(translationJson) ? translationJson : {};
  const facetsJson = isObject(translation.facets) ? translation.facets : {};
  const facets = new Map<string, FacetPlan>();
  for (const [key, value] of Object.entries(facetsJson)) {
    if (!isObject(value) || !isObject(value.desired)) continue;
    facets.set(key, {
      desired: value.desired,
      decisions: Array.isArray(value.decisions)
        ? (value.decisions as unknown as FieldDecision[])
        : [],
    });
  }
  return facets;
}

export async function loadRunWorld(ctx: MigrationContext): Promise<RunWorld> {
  const { db } = ctx.services;
  if (ctx.migration.scope !== 'repository' || ctx.migration.sourceRepositoryId === null) {
    throw new StepFailure('run.scope_unsupported', 'Only a repository Migration has these Steps');
  }
  if (ctx.run.analysisId === null) {
    throw new StepFailure('run.analysis_missing', 'The Run has no Analysis to apply');
  }
  const migration = await db.migration.findUniqueOrThrow({
    where: { id: ctx.migration.id },
    include: {
      route: { include: { sourceEndpoint: true, targetEndpoint: true } },
      sourceRepository: { include: { namespace: true } },
    },
  });
  const route = migration.route;
  const source = migration.sourceRepository;
  if (!source)
    throw new StepFailure('run.source_missing', 'The Migration has no source repository');
  // The guard refuses these Runs once the Route is retargeted; a Run admitted before the change
  // (queued, or resumed after a hand-off) is stopped here, before it touches the new place, and a
  // Run that writes the target pins where it writes (ADR-0504).
  await checkPlacement(db, migration.id, ctx.run.kind, route);
  if (!route.targetNamespaceId) {
    throw new StepFailure('run.target_namespace_missing', 'The target namespace is not resolved');
  }
  const targetNamespace = await db.namespace.findUniqueOrThrow({
    where: { id: route.targetNamespaceId },
  });
  const analysis = await db.analysis.findUniqueOrThrow({
    where: { id: ctx.run.analysisId },
    select: { translation: true },
  });
  const facets = facetPlansOf(analysis.translation);
  const plannedName = migration.plannedTargetName;
  if (!plannedName) {
    throw new StepFailure('run.target_name_missing', 'The Analysis planned no target name');
  }
  const sourceNamespace = { providerId: source.namespace.providerId, slug: source.namespace.slug };
  return {
    migrationId: migration.id,
    routeId: route.id,
    analysisId: ctx.run.analysisId,
    sourceEndpointId: route.sourceEndpointId,
    targetEndpointId: route.targetEndpointId,
    sourceType: route.sourceEndpoint.providerType,
    targetType: route.targetEndpoint.providerType,
    sourceRepository: {
      id: source.id,
      providerId: source.providerId,
      slug: source.slug,
      fullPath: source.fullPath,
      sizeBytes: source.sizeBytes,
      lfsBytes: source.lfsBytes,
    },
    sourceRef: { providerId: source.providerId, namespace: sourceNamespace, slug: source.slug },
    targetNamespace: {
      id: targetNamespace.id,
      providerId: targetNamespace.providerId,
      slug: targetNamespace.slug,
    },
    targetNamespaceRef: { providerId: targetNamespace.providerId, slug: targetNamespace.slug },
    plannedName,
    facets,
    adoptNonEmpty: ctx.run.options.adoptNonEmpty === true,
  };
}

/** The target repository as the adapters address it. */
export function targetRefOf(
  world: RunWorld,
  repo: { providerId: string; slug: string },
): RepositoryRef {
  return { providerId: repo.providerId, namespace: world.targetNamespaceRef, slug: repo.slug };
}

export function repositoryTarget(_world: RunWorld, ref: RepositoryRef): FacetTarget {
  return { scope: 'repository', repository: ref, namespace: ref.namespace };
}

/** The ref of the Migration's target repository; throws when step 3 has not recorded one. */
export async function targetOf(
  ctx: MigrationContext,
  world: RunWorld,
): Promise<{
  ref: RepositoryRef;
  record: { id: string; providerId: string; slug: string; defaultBranch: string | null };
}> {
  const migration = await ctx.services.db.migration.findUniqueOrThrow({
    where: { id: world.migrationId },
    select: { targetRepository: true },
  });
  const repo = migration.targetRepository;
  if (!repo) {
    throw new StepFailure(
      'target.not_ensured',
      'The target repository is not recorded: target.ensure-repository has not succeeded',
    );
  }
  return {
    ref: targetRefOf(world, repo),
    record: {
      id: repo.id,
      providerId: repo.providerId,
      slug: repo.slug,
      defaultBranch: repo.defaultBranch,
    },
  };
}

/** Rows of an adapter record for the target `Repository` table. */
export function repositoryRow(world: RunWorld, record: RepositoryRecord, now: Date) {
  return {
    endpointId: world.targetEndpointId,
    namespaceId: world.targetNamespace.id,
    providerId: record.providerId,
    slug: record.slug,
    name: record.name,
    fullPath: record.fullPath,
    isPrivate: record.isPrivate,
    defaultBranch: record.defaultBranch ?? null,
    lastInventoriedAt: now,
  };
}
