/**
 * LIF-040 step 12: `overlays.apply` (LIF-048). The Route's enabled Overlays are partial canonical
 * documents, merged onto the Facet's desired target document with overlay values winning; the
 * result is applied like any desired document, and the merged paths get `overlay` Expected
 * Differences so parity ignores them. Overlays are validated by their editor (T-091); the merge
 * refuses prototype keys regardless. Decisions: docs/adr/0380-migration-steps.md.
 */
import { randomUUID } from 'node:crypto';
import { mergeOverlay, OverlayError } from '@git-migrator/core';
import { StepFailure } from '../run/errors.ts';
import type { StepDefinition, StepResult } from '../run/types.ts';
import { applyWithLedger, settleOpenIntents } from './facets.ts';
import { connectSide, type MigrationContext, type MigrationServices } from './services.ts';
import { loadRunWorld, type RunWorld, repositoryTarget, targetOf } from './world.ts';

/** Records the `overlay` Expected Differences once; an operator's revocation is never undone. */
async function recordOverlayDifferences(
  ctx: MigrationContext,
  world: RunWorld,
  facetKey: string,
  paths: readonly string[],
): Promise<void> {
  const now = (ctx.services.now ?? (() => new Date()))();
  await ctx.transaction(async (tx) => {
    for (const path of paths) {
      await tx.$executeRaw`
        INSERT INTO app.expected_difference
          (id, route_id, migration_id, facet_key, path, reason, note, updated_at)
        SELECT ${randomUUID()}, ${world.routeId}, ${world.migrationId}, ${facetKey}, ${path},
               'overlay'::app.expected_difference_reason, 'Applied from an Overlay (LIF-048)', ${now}
        WHERE NOT EXISTS (
          SELECT 1 FROM app.expected_difference e
          WHERE e.migration_id = ${world.migrationId} AND e.facet_key = ${facetKey}
            AND e.path = ${path} AND e.reason = 'overlay')
        ON CONFLICT DO NOTHING`;
    }
  });
}

export function overlaysStep(): StepDefinition<MigrationServices> {
  return {
    key: 'overlays.apply',
    severity: 'independent',
    async run(ctx): Promise<StepResult> {
      const world = await loadRunWorld(ctx);
      const { services } = ctx;
      const overlays = await services.db.overlay.findMany({
        where: { routeId: world.routeId, enabled: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      if (overlays.length === 0)
        return { status: 'skipped', reason: 'the Route has no enabled Overlay' };
      const target = await connectSide(ctx, world.targetEndpointId, world.targetType);
      const { ref } = await targetOf(ctx, world);
      const facetTarget = repositoryTarget(world, ref);
      await settleOpenIntents(ctx);

      const byFacet = new Map<string, unknown[]>();
      for (const overlay of overlays) {
        byFacet.set(overlay.facetKey, [...(byFacet.get(overlay.facetKey) ?? []), overlay.data]);
      }
      let applied = 0;
      for (const facetKey of services.registry.facets.ordered().map((d) => d.key)) {
        const documents = byFacet.get(facetKey);
        if (!documents) continue;
        const def = services.registry.facets.get(facetKey);
        const plan = world.facets.get(facetKey);
        const driver = target.connection.facets[facetKey as keyof typeof target.connection.facets];
        if (def.scope !== 'repository' || !plan || !driver?.apply) {
          await ctx.runLog(
            'warn',
            `An Overlay for ${facetKey} is not applied: the Facet is not written for a repository`,
            {},
          );
          continue;
        }
        let merged: unknown = plan.desired;
        const paths = new Set<string>();
        try {
          for (const document of documents) {
            const step = mergeOverlay(merged, document, {
              collections: def.collections,
              sets: def.sets ?? [],
            });
            merged = step.merged;
            for (const path of step.paths) paths.add(path);
          }
          merged = def.schema.parse(merged);
        } catch (error) {
          if (error instanceof OverlayError || (error as Error)?.name === 'ZodError') {
            throw new StepFailure(
              'overlay.invalid',
              `An Overlay for ${facetKey} does not give a valid document`,
              {
                facetKey,
                reason: (error as Error).message.slice(0, 300),
              },
            );
          }
          throw error;
        }
        const current = (await driver.read(target.driver, facetTarget)).data;
        await applyWithLedger(ctx, {
          facetKey,
          driver,
          side: target,
          target: facetTarget,
          desired: merged,
          decisions: [...plan.decisions],
          current,
          umbrella: 'overlay-apply',
        });
        await recordOverlayDifferences(ctx, world, facetKey, [...paths].sort());
        applied += 1;
      }
      return applied === 0
        ? { status: 'skipped', reason: 'no Overlay applies to a repository Facet' }
        : { status: 'succeeded' };
    },
  };
}
