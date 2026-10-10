/**
 * Where a Migration's target is, relative to its Route (ADR-0504). A config sync may retarget a
 * Route (LIF-011) after the framework wrote the target: a repository it created or adopted, or the
 * teams, variables and hooks an endpoint Migration wrote to the target Namespace. The first
 * target-writing Step pins that place on the Migration (`targetPlaced*`); the Run guard, the Steps,
 * the Analysis and the Parity Check then refuse to work on the new place, and a rollback reverts
 * where the writes went. A completed rollback clears the pin.
 */
import type { RunKind } from '@git-migrator/core';
import type { Db } from '@git-migrator/db';
import { StepFailure } from './errors.ts';

/** Run kinds that read or write the target through the Route's target namespace. */
export const ROUTE_TARGET_KINDS: readonly RunKind[] = ['migrate', 'run_anyway', 'resync', 'verify'];
/** Run kinds whose Steps write the target, and so pin its place. */
export const PLACING_KINDS: readonly RunKind[] = ['migrate', 'run_anyway', 'resync'];

/** The blocker an Analysis raises, and the code a step fails with, for a target outside the Route. */
export const TARGET_OUTSIDE_ROUTE = 'repository-settings.target-outside-route';

/**
 * The blocker an Analysis raises, and the code a Step fails with, for target writes from before
 * places were recorded whose place no evidence shows (ADR-0504).
 */
export const TARGET_PLACEMENT_UNKNOWN = 'repository-settings.target-placement-unknown';

/** What a refused Run says about target writes of unknown place. */
export function placementUnknownMessage(namespacePath: string): string {
  return `The framework did not record where this Migration's earlier target writes went. If the Route still points at the Namespace they were written to, confirm it by typing ${namespacePath} to continue. Otherwise restore the Route's target, roll the Migration back, then change the Route`;
}

/** The parts of a target place and of its Route that `targetOutsideRoute` compares. */
export interface TargetPlacement {
  readonly repository: {
    readonly endpointId: string;
    readonly namespaceId: string;
    readonly namespace: { readonly slug: string; readonly key: string | null };
  };
  readonly route: {
    readonly targetEndpointId: string;
    readonly targetNamespaceId: string | null;
    readonly targetNamespacePath: string;
  };
}

/**
 * True when the Migration's target is no longer where its Route points: the Route's target Endpoint
 * or Namespace changed after the framework wrote it (a config sync, LIF-011). While the Route's
 * namespace is not resolved again yet, the target's namespace is compared with the configured path
 * the way inventory resolves it (slug or key, ignoring case). A Run that went on would read or
 * write the target in the new place and split the Migration (ADR-0504).
 */
export function targetOutsideRoute({ repository, route }: TargetPlacement): boolean {
  if (repository.endpointId !== route.targetEndpointId) return true;
  if (route.targetNamespaceId !== null) return repository.namespaceId !== route.targetNamespaceId;
  const wanted = route.targetNamespacePath.toLowerCase();
  return (
    repository.namespace.slug.toLowerCase() !== wanted &&
    repository.namespace.key?.toLowerCase() !== wanted
  );
}

/** What a refused Run and the blocker say about a target outside the Route. */
export function targetOutsideRouteMessage(label: string): string {
  return `The target ${label} is not in the Route's target Namespace any more (the Route was changed). Roll the Migration back to remove what the framework made there, or restore the Route's target, then analyze again`;
}

/** Where the framework wrote a Migration's target, with a name for messages. */
export interface Placement {
  readonly endpointId: string;
  readonly namespaceId: string;
  readonly namespace: {
    readonly providerId: string;
    readonly slug: string;
    readonly key: string | null;
  };
  /** The target repository's full path, or the Namespace for an endpoint Migration. */
  readonly label: string;
}

/**
 * The place of a Migration's target: the pinned place, or, for a Migration written before pins
 * existed, its target repository's. `undefined` when the framework has written no target.
 */
export async function loadPlacement(
  db: PlacementDb,
  migrationId: string,
): Promise<Placement | undefined> {
  const m = await db.migration.findUnique({
    where: { id: migrationId },
    select: {
      targetPlacedEndpointId: true,
      targetPlacedNamespaceId: true,
      targetRepository: { select: { endpointId: true, namespaceId: true, fullPath: true } },
    },
  });
  if (!m) return undefined;
  const repo = m.targetRepository;
  // A pin counts only while there is something to protect: a target repository, or target writes
  // not undone (an open intent included). A Run that failed before its first write left nothing
  // there, so a corrected Route is not refused because of it, and the next write pins again.
  const pinned =
    m.targetPlacedEndpointId !== null &&
    m.targetPlacedNamespaceId !== null &&
    (repo !== null || (await hasTargetWrites(db, migrationId)));
  const endpointId = pinned ? m.targetPlacedEndpointId : repo?.endpointId;
  const namespaceId = pinned ? m.targetPlacedNamespaceId : repo?.namespaceId;
  if (!endpointId || !namespaceId) return undefined;
  const namespace = await db.namespace.findUnique({
    where: { id: namespaceId },
    select: { providerId: true, slug: true, key: true },
  });
  if (!namespace) return undefined;
  const sameRepo = repo && repo.endpointId === endpointId && repo.namespaceId === namespaceId;
  return {
    endpointId,
    namespaceId,
    namespace,
    label: sameRepo ? `repository ${repo.fullPath}` : `Namespace ${namespace.slug}`,
  };
}

/** The client calls `loadPlacement` and `checkPlacement` need. */
export type PlacementDb = Pick<Db, 'migration' | 'namespace' | '$queryRaw'>;

/**
 * True when the ledger holds target writes not undone: recorded or still intended, not adopted
 * state and not no-ops (the same rule as `hasUndoableMutations`, on the target side).
 */
export async function hasTargetWrites(
  db: Pick<Db, '$queryRaw'>,
  migrationId: string,
): Promise<boolean> {
  const rows = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app.mutation
    WHERE migration_id = ${migrationId} AND side = 'target' AND undone_at IS NULL
      AND state <> 'not_applied'
      AND coalesce(resource_ref->>'adopted', 'false') <> 'true'
      AND coalesce(resource_ref->>'noop', 'false') <> 'true'`;
  return (rows[0]?.n ?? 0) > 0;
}

/** True when the Migration holds legacy target writes whose place is unknown. */
export async function placementUnknown(
  db: Pick<Db, 'migration'>,
  migrationId: string,
): Promise<boolean> {
  const m = await db.migration.findUnique({
    where: { id: migrationId },
    select: { targetPlacementUnknown: true },
  });
  return m?.targetPlacementUnknown === true;
}

/** True when `placement` exists and is outside `route`. */
export function placementOutside(
  placement: Placement | undefined,
  route: TargetPlacement['route'],
): placement is Placement {
  return placement !== undefined && targetOutsideRoute({ repository: placement, route });
}

/**
 * The Step-time check of every target Step: a Run admitted before the Route changed (queued, or
 * resumed after a hand-off) stops before it touches the new place. A Run that writes the target
 * pins the Route's current place when nothing is pinned yet, before its first write.
 */
export async function checkPlacement(
  db: PlacementDb,
  migrationId: string,
  kind: RunKind,
  route: TargetPlacement['route'],
): Promise<void> {
  if (!ROUTE_TARGET_KINDS.includes(kind)) return;
  const placement = await loadPlacement(db, migrationId);
  if (placementOutside(placement, route)) {
    throw new StepFailure(TARGET_OUTSIDE_ROUTE, targetOutsideRouteMessage(placement.label));
  }
  // Legacy writes of unknown place: only the confirmation at admission pins them, so a Run queued
  // or resumed past the guard never pins on its own (ADR-0504).
  if (placement === undefined && (await placementUnknown(db, migrationId))) {
    throw new StepFailure(
      TARGET_PLACEMENT_UNKNOWN,
      placementUnknownMessage(route.targetNamespacePath),
    );
  }
  if (placement === undefined && PLACING_KINDS.includes(kind) && route.targetNamespaceId) {
    await db.migration.update({
      where: { id: migrationId },
      data: {
        targetPlacedEndpointId: route.targetEndpointId,
        targetPlacedNamespaceId: route.targetNamespaceId,
      },
    });
  }
}
