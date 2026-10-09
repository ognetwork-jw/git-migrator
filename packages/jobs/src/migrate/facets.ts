/**
 * LIF-040 steps 6, 7, 8, 10 and 11: `facet.<key>.apply`. One Step per Facet applies the Facet's
 * desired target document with the target driver (ADP-011): the driver changes only what differs
 * and yields one `MutationRecord` per provider-side change, which the ledger stores as it arrives
 * (ADP-012). Run-time findings that only the write can show are raised here (LIF-049):
 * `deploy-keys.key-in-use` and `branch-rules.exemptions-not-applied`. Decisions:
 * docs/adr/0380-migration-steps.md.
 */
import type { FacetDriver, MutationRecord } from '@git-migrator/adapter-sdk';
import { redactWebhookUrl } from '@git-migrator/canonical';
import { diffDocuments, formatFieldPath, parseFieldPath } from '@git-migrator/core';
import type { StepDefinition, StepResult } from '../run/types.ts';
import {
  connectSide,
  type MigrationContext,
  type MigrationServices,
  type Side,
} from './services.ts';
import { loadRunWorld, type RunWorld, repositoryTarget, targetOf } from './world.ts';

type Json = Record<string, unknown>;

/**
 * What the umbrella intent and recovered records store of a Facet document. Webhook URLs may
 * carry credentials in the path or query (FAC-WEB-002), so they are reduced to their origin
 * before they reach the ledger; hooks are keyed by `key`, so recovery does not need the URL.
 * Recovery redacts the fresh read the same way before it diffs (ADR-0435).
 */
export function ledgerSafe(facetKey: string, document: unknown): unknown {
  if (facetKey !== 'webhooks' && facetKey !== 'org-webhooks') return document;
  // Only `hooks[].url` can carry a credential. `key` (`<origin>#<hash>`) identifies the hook for
  // recovery and must stay as it is: the generic rule would hide it (ADR-0435).
  const hooks = (document as { hooks?: unknown } | null)?.hooks;
  if (!Array.isArray(hooks)) return document;
  return {
    ...(document as object),
    hooks: hooks.map((h) =>
      typeof h === 'object' && h !== null && typeof (h as { url?: unknown }).url === 'string'
        ? { ...h, url: redactWebhookUrl((h as { url: string }).url) }
        : h,
    ),
  };
}

/** Passes records through while keeping them for the hooks below. */
async function* tap<T>(source: AsyncIterable<T>, into: T[]): AsyncGenerator<T> {
  for await (const item of source) {
    into.push(item);
    yield item;
  }
}

/**
 * Runs `driver.apply` for `desired` under an umbrella intent and ledgers every record. The
 * umbrella marks the Run as having written even if the worker dies before the first record, and a
 * resumed Step settles it first (the apply that follows is idempotent). It is inert, so rollback
 * never tries to undo it.
 */
export async function applyWithLedger(
  ctx: MigrationContext,
  options: {
    readonly facetKey: string;
    readonly driver: FacetDriver<unknown>;
    readonly side: Side;
    readonly target: ReturnType<typeof repositoryTarget>;
    readonly desired: unknown;
    readonly decisions: Parameters<NonNullable<FacetDriver<unknown>['apply']>>[4];
    readonly current: unknown;
    readonly origin?: 'desired' | 'framework';
    /** Parity paths of a `framework` write whose records name no Facet path (LIF-045). */
    readonly differences?: readonly { readonly facetKey: string; readonly path: string }[];
    readonly umbrella: string;
    /** More fields of the umbrella's `resourceRef` (for example the Change Request purpose). */
    readonly refExtra?: Readonly<Record<string, unknown>>;
  },
): Promise<MutationRecord[]> {
  const { driver, side } = options;
  const records: MutationRecord[] = [];
  const write = {
    side: 'target',
    origin: options.origin ?? 'desired',
    ...(options.differences ? { differences: options.differences } : {}),
  } as const;
  const intentId = await ctx.ledger.intend(write, {
    facetKey: options.facetKey,
    action: 'update',
    resourceRef: {
      kind: options.umbrella,
      noop: true,
      // What the write is meant to leave: only the part of a later change that is meant is ours.
      // (An inert record's `after` is normalized to its `before`, so it cannot carry this.)
      meant: (ledgerSafe(options.facetKey, options.desired) ?? null) as never,
      ...options.refExtra,
    },
    paths: [],
    // What the target held before the write, so a resumed Step can tell what a lost record changed.
    before: (ledgerSafe(options.facetKey, options.current) ?? null) as never,
    after: (ledgerSafe(options.facetKey, options.current) ?? null) as never,
  });
  ctx.checkpoint();
  const apply = driver.apply;
  if (!apply) throw new Error(`The ${options.facetKey} driver cannot apply`);
  // A Change Request an apply opens or updates links to the Migration (LIF-047 step 3): the note
  // covers every apply, so an Overlay on `code-ownership` keeps it too.
  const repository = options.target.scope === 'repository' ? options.target.repository : undefined;
  if (repository) ctx.services.links.note(repository.providerId, ctx.migration.id);
  try {
    await ctx.ledger.recordAll(
      write,
      tap(
        apply.call(
          driver,
          side.driver,
          options.target,
          options.desired,
          options.current,
          options.decisions,
        ),
        records,
      ),
    );
  } finally {
    if (repository) ctx.services.links.forget(repository.providerId);
  }
  await ctx.ledger.confirm(intentId, 'applied');
  return records;
}

/** Settles what a previous attempt of this Step left open. */
export async function settleOpenIntents(ctx: MigrationContext): Promise<void> {
  for (const intent of await ctx.ledger.openIntents()) {
    await ctx.ledger.confirm(intent.id, 'applied');
  }
}

/** Umbrella intents whose effect shows in a read of the Facet. */
const RECOVERABLE_UMBRELLAS: ReadonlySet<string> = new Set([
  'facet-apply',
  'overlay-apply',
  'lift-protection',
]);

/** `/rules[pattern=x]/enforcement` to `/rules[pattern=x]`: the element a leaf path belongs to. */
const elementPath = (path: string): string => {
  const first = parseFieldPath(path)[0];
  return first ? formatFieldPath([first]) : path;
};

/**
 * Settles the open intents of a resumed Facet Step. A driver `apply` that died between a provider
 * write and the record of it left a change nobody ledgered. The umbrella intent kept what the
 * target held before (`before`) and what the write is meant to leave (`after`). What the lost
 * record would have said is the change since `before` that the write was meant to make, and that
 * no record of this Step already covers:
 *   (diff(before, fresh) intersect diff(before, after)) minus the paths of the Step's own records
 * written after the umbrella. A change somebody else made meanwhile is not in `after`, so it is
 * not blamed on the framework (rollback would undo it, LIF-077). The remainder is ledgered as a
 * real record (kind `recovered-write`, undoable by its paths); with nothing left the umbrella
 * stays inert, and when nothing changed at all it was not applied (LIF-045, ADR-0342, ADR-0380).
 * The protection lift is recovered the same way, per rule element, as deletions.
 */
export async function recoverOpenIntents(
  ctx: MigrationContext,
  target: Side,
  facetTarget: ReturnType<typeof repositoryTarget>,
): Promise<void> {
  for (const intent of await ctx.ledger.openIntents()) {
    const kind = String(intent.resourceRef.kind ?? '');
    const key = intent.facetKey;
    const driver = key
      ? target.connection.facets[key as keyof typeof target.connection.facets]
      : undefined;
    if (!key || !driver || !RECOVERABLE_UMBRELLAS.has(kind) || intent.before == null) {
      await ctx.ledger.confirm(intent.id, 'applied');
      continue;
    }
    const lift = kind === 'lift-protection';
    const def = ctx.services.registry.facets.get(key as never);
    const schema = { collections: def.collections, sets: def.sets ?? [] };
    const fresh = ledgerSafe(key, (await driver.read(target.driver, facetTarget)).data);
    const norm = (path: string): string => (lift ? elementPath(path) : path);
    const changed = new Set(diffDocuments(fresh, intent.before, schema).map((d) => norm(d.path)));
    if (changed.size === 0) {
      await ctx.ledger.confirm(intent.id, 'not_applied');
      continue;
    }
    const wanted = intent.resourceRef.meant;
    const meant =
      wanted == null
        ? changed
        : new Set(diffDocuments(wanted, intent.before, schema).map((d) => norm(d.path)));
    const covered = (
      await ctx.services.db.$queryRaw<{ paths: string[] }[]>`
        SELECT paths FROM app.mutation
        WHERE run_id = ${ctx.run.id} AND written_by_step = ${ctx.step.id} AND state = 'recorded'
          AND seq > (SELECT seq FROM app.mutation WHERE id = ${intent.id})`
    ).flatMap((r) => r.paths.map(norm));
    const isCovered = (p: string): boolean =>
      covered.some((c) => p === c || p.startsWith(`${c}/`) || p.startsWith(`${c}[`));
    const remaining = [...changed].filter((p) => meant.has(p) && !isCovered(p)).sort();
    if (remaining.length === 0) {
      await ctx.ledger.confirm(intent.id, 'applied');
      continue;
    }
    await ctx.ledger.confirm(intent.id, 'applied', {
      facetKey: key,
      action: lift ? 'delete' : 'update',
      resourceRef: { kind: 'recovered-write', umbrella: kind },
      paths: remaining,
      before: intent.before,
      after: lift ? null : fresh,
    });
    await ctx.runLog('warn', `Recovered an unrecorded write to ${key} after a restart`, {
      paths: remaining.slice(0, 50),
    });
  }
}

/** The rule pattern a branch-rules record is about, from its canonical path. */
function patternOf(record: MutationRecord): string | undefined {
  const first = record.paths[0];
  if (first === undefined) return undefined;
  return parseFieldPath(first)[0]?.key?.value;
}

/** Hooks: findings that only the write itself reveals. */
export async function afterApply(
  ctx: MigrationContext,
  world: RunWorld,
  facetKey: string,
  records: readonly MutationRecord[],
  readBack: () => Promise<unknown>,
  desired: Json,
): Promise<void> {
  if (facetKey === 'branch-rules') {
    // ADR-0040: the provider refused the force-push exemptions; the rule is stricter than the
    // source's (fail closed). An operator decides whether that is acceptable.
    const patterns = new Set<string>();
    for (const record of records) {
      if (record.resourceRef.exemptionsDropped === true) {
        const pattern = patternOf(record);
        if (pattern !== undefined) patterns.add(pattern);
      }
    }
    for (const pattern of [...patterns].sort()) {
      await ctx.findings.addTask({
        code: 'branch-rules.exemptions-not-applied',
        facetKey: 'branch-rules',
        phase: 'post',
        params: { pattern },
      });
    }
  }
  if (facetKey === 'deploy-keys') {
    // FAC-DKY-002: the provider refuses a key another repository or a user key already uses; the
    // driver logs it and goes on, so the key is simply missing afterwards.
    const wanted = (desired.keys ?? []) as { publicKey: string; title?: string }[];
    if (wanted.length === 0) return;
    const have = new Set(
      ((await readBack()) as { keys?: { publicKey: string }[] }).keys?.map((k) => k.publicKey) ??
        [],
    );
    for (const key of wanted) {
      if (have.has(key.publicKey)) continue;
      await ctx.findings.addTask({
        code: 'deploy-keys.key-in-use',
        facetKey: 'deploy-keys',
        phase: 'post',
        verifiable: true,
        params: {
          keyName: key.title && key.title.trim() !== '' ? key.title : 'deploy-key',
          publicKey: key.publicKey,
        },
      });
    }
  }
  void world;
}

/** Steps 6 to 8, 10 and 11: applies one Facet's desired document to the target. */
export function facetApplyStep(facetKey: string): StepDefinition<MigrationServices> {
  return {
    key: `facet.${facetKey}.apply`,
    facetKey,
    severity: 'independent',
    async run(ctx): Promise<StepResult> {
      const world = await loadRunWorld(ctx);
      const plan = world.facets.get(facetKey);
      if (!plan)
        return { status: 'skipped', reason: `the Analysis translated no ${facetKey} document` };
      const target = await connectSide(ctx, world.targetEndpointId, world.targetType);
      const driver = target.connection.facets[facetKey as keyof typeof target.connection.facets];
      if (!driver?.apply)
        return { status: 'skipped', reason: 'the target cannot write this Facet' };
      const { ref } = await targetOf(ctx, world);
      const facetTarget = repositoryTarget(world, ref);
      await recoverOpenIntents(ctx, target, facetTarget);

      const current = (await driver.read(target.driver, facetTarget)).data;
      const records = await applyWithLedger(ctx, {
        facetKey,
        driver,
        side: target,
        target: facetTarget,
        desired: plan.desired,
        decisions: [...plan.decisions],
        current,
        umbrella: 'facet-apply',
      });
      await afterApply(
        ctx,
        world,
        facetKey,
        records,
        async () => (await driver.read(target.driver, facetTarget)).data,
        plan.desired,
      );
      return { status: 'succeeded', detail: { changes: records.length } };
    },
  };
}
