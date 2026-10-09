/**
 * LIF-040 step 9: `change-requests.open`. The `code-ownership` and `pipelines` Facets reach the
 * target as Change Requests, never as direct commits (LIF-047, FAC-PIP-003). The step runs before
 * the branch rules exist (step 10), so a protection rule never blocks the framework's own pushes.
 * Each Change Request is written through the adapter's `ChangeRequestWriter`, which creates the
 * branch `git-migrator/<purpose>`, commits as `git-migrator`, and opens or updates the request
 * idempotently. Decisions: docs/adr/0380-migration-steps.md.
 */
import type { FacetTarget, MutationRecord } from '@git-migrator/adapter-sdk';
import { itemSeg, joinFieldPath } from '@git-migrator/core';
import { endpointNames } from '../analysis/analysis.ts';
import type { StepDefinition, StepResult } from '../run/types.ts';
import { applyWithLedger } from './facets.ts';
import { connectSide, type MigrationContext, type MigrationServices } from './services.ts';
import { loadRunWorld, repositoryTarget, targetOf } from './world.ts';

const SOURCE_PIPELINES_FILE = 'bitbucket-pipelines.yml';

/** The parity paths a framework branch adds on the target (LIF-045 target-side). */
const branchDifference = (purpose: string) => ({
  facetKey: 'git-refs',
  path: joinFieldPath('', itemSeg('refs', 'name', `refs/heads/git-migrator/${purpose}`)),
});

/** Records written before a Change Request call failed travel on the error (ADR-0231 item 13). */
export function partialMutationsOf(error: unknown): MutationRecord[] {
  const list = (error as { mutations?: unknown } | null)?.mutations;
  return Array.isArray(list) ? (list as MutationRecord[]) : [];
}

/** Step 9. Skipped, with warning `git-refs.empty-repository`, when the target has no default branch. */
export function changeRequestsStep(): StepDefinition<MigrationServices> {
  return {
    key: 'change-requests.open',
    severity: 'independent',
    async run(ctx): Promise<StepResult> {
      const world = await loadRunWorld(ctx);
      const target = await connectSide(ctx, world.targetEndpointId, world.targetType);
      const { ref } = await targetOf(ctx, world);
      const repo = await target.connection.inventory.getRepository(ref);
      if (!repo?.defaultBranch) {
        await ctx.runLog(
          'warn',
          'The target has no default branch, so no Change Request is opened (git-refs.empty-repository)',
          {},
        );
        return { status: 'skipped', reason: 'git-refs.empty-repository' };
      }
      await recoverChangeRequestIntents(ctx, target, ref);
      const facetTarget = repositoryTarget(world, ref);
      let opened = 0;
      // LIF-047 step 3: the request body links to the Migration. Noted around each write, from the
      // database, so a Run resumed in another job or process has it.
      {
        // code-ownership: the target driver renders CODEOWNERS and opens the request itself.
        const owners = world.facets.get('code-ownership');
        const ownersDriver = target.connection.facets['code-ownership'];
        if (owners && ownersDriver?.apply && hasEntries(owners.desired, 'owners')) {
          const current = (await ownersDriver.read(target.driver, facetTarget)).data;
          await applyWithLedger(ctx, {
            facetKey: 'code-ownership',
            driver: ownersDriver,
            side: target,
            target: facetTarget,
            desired: owners.desired,
            decisions: [...owners.decisions],
            current,
            origin: 'framework',
            differences: [branchDifference('codeowners')],
            umbrella: 'change-request-open',
            refExtra: { purpose: 'codeowners' },
          });
          opened += 1;
        }

        // pipelines: the workflows are generated from the source file by the target adapter's
        // delivery, which the registry reaches (ARC-012).
        const pipelines = world.facets.get('pipelines');
        if (pipelines && hasEntries(pipelines.desired, 'files')) {
          opened += await openPipelines(ctx, world, target, facetTarget, ref);
        }
      }
      return opened === 0
        ? { status: 'skipped', reason: 'no Change Request is needed' }
        : { status: 'succeeded' };
    },
  };
}

const hasEntries = (doc: Record<string, unknown>, key: string): boolean =>
  Array.isArray(doc[key]) && (doc[key] as unknown[]).length > 0;

async function openPipelines(
  ctx: MigrationContext,
  world: Awaited<ReturnType<typeof loadRunWorld>>,
  target: Awaited<ReturnType<typeof connectSide>>,
  _facetTarget: FacetTarget,
  ref: Awaited<ReturnType<typeof targetOf>>['ref'],
): Promise<number> {
  const { services } = ctx;
  const writer = target.connection.changeRequests;
  const delivery = services.registry.pipelinesDelivery(world.sourceType, world.targetType);
  if (!writer || !delivery) {
    await ctx.runLog('warn', 'No pipelines delivery is registered for this pair', {
      source: world.sourceType,
      target: world.targetType,
    });
    return 0;
  }
  const source = await connectSide(ctx, world.sourceEndpointId, world.sourceType);
  const sourceDriver = source.connection.facets.pipelines;
  if (!sourceDriver) return 0;
  const read = await sourceDriver.read(source.driver, {
    scope: 'repository',
    repository: world.sourceRef,
    namespace: world.sourceRef.namespace,
  });
  const files = (read.data as { files?: { path: string; sha256: string }[] }).files ?? [];
  const file = files.find((f) => f.path === SOURCE_PIPELINES_FILE) ?? files[0];
  const text = file ? read.attachments?.[file.sha256] : undefined;
  if (text === undefined) {
    await ctx.runLog(
      'warn',
      'The source pipeline file could not be read again; no Change Request is opened',
      {},
    );
    return 0;
  }
  const rendered = delivery.render({
    text,
    variables: world.facets.get('variables')?.desired,
    secrets: world.facets.get('secrets')?.desired,
    workspaceVariables: await endpointNames(services.db, world.sourceEndpointId, 'org-variables'),
    workspaceSecrets: await endpointNames(services.db, world.sourceEndpointId, 'org-secrets'),
  });
  const write = {
    side: 'target',
    origin: 'framework',
    differences: [branchDifference(rendered.purpose)],
  } as const;
  const intentId = await ctx.ledger.intend(write, {
    facetKey: 'change-requests',
    action: 'create',
    resourceRef: { kind: 'change-request-open', purpose: rendered.purpose, noop: true },
    paths: [],
    before: null,
    after: null,
  });
  ctx.checkpoint();
  ctx.services.links.note(ref.providerId, world.migrationId);
  try {
    const result = await writer.upsert(ref, {
      purpose: rendered.purpose,
      branch: `git-migrator/${rendered.purpose}`,
      title: rendered.title,
      body: rendered.body,
      files: rendered.files.map((f) => ({ path: f.path, content: f.content })),
    });
    await ctx.ledger.record(write, result.mutations);
  } catch (error) {
    // The branch and commit written before the failure are real: ledger them, then fail.
    await ctx.ledger.record(write, partialMutationsOf(error));
    throw error;
  } finally {
    ctx.services.links.forget(ref.providerId);
  }
  await ctx.ledger.confirm(intentId, 'applied');
  return 1;
}

/**
 * Settles the Change Request intents a previous attempt left open. The writer (and the driver that
 * uses it) is idempotent and returns its records only when it finishes, so a worker that died
 * after opening the request left none. The request is read back by purpose: when it exists, the
 * framework's creation of it is ledgered (with the `framework_mutation` Expected Difference of its
 * branch), so rollback can close it. A branch pushed without a request is adopted by the next
 * `upsert`, which records it (LIF-045, LIF-047, ADR-0380).
 */
async function recoverChangeRequestIntents(
  ctx: MigrationContext,
  target: Awaited<ReturnType<typeof connectSide>>,
  ref: Awaited<ReturnType<typeof targetOf>>['ref'],
): Promise<void> {
  const writer = target.connection.changeRequests;
  for (const intent of await ctx.ledger.openIntents()) {
    const purpose = intent.resourceRef.purpose;
    if (
      intent.resourceRef.kind !== 'change-request-open' ||
      typeof purpose !== 'string' ||
      !writer
    ) {
      await ctx.ledger.confirm(intent.id, 'applied');
      continue;
    }
    const covered = await ctx.services.db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app.mutation
      WHERE run_id = ${ctx.run.id} AND written_by_step = ${ctx.step.id} AND state = 'recorded'
        AND seq > (SELECT seq FROM app.mutation WHERE id = ${intent.id})
        AND resource_ref->>'kind' = 'change-request'`;
    const state = await writer.status(ref, purpose);
    if (state === 'none' || (covered[0]?.n ?? 0) > 0) {
      await ctx.ledger.confirm(intent.id, 'applied');
      continue;
    }
    await ctx.ledger.confirm(intent.id, 'applied', {
      facetKey: 'git-refs',
      action: 'create',
      resourceRef: {
        kind: 'change-request',
        repository: ref.slug,
        purpose,
        state,
        recovered: true,
      },
      paths: [branchDifference(purpose).path],
      before: null,
      after: { state },
    });
    await ctx.runLog(
      'warn',
      `Recovered an unrecorded Change Request (${purpose}) after a restart`,
      {
        state,
      },
    );
  }
}
