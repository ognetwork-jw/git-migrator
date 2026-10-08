import type { Db } from './client.ts';

/** A model delegate without the generated types, so one matrix can drive every model. */
export interface AnyDelegate {
  findMany(args?: unknown): Promise<Record<string, unknown>[]>;
  findFirst(args?: unknown): Promise<Record<string, unknown> | null>;
  create(args: unknown): Promise<unknown>;
  update(args: unknown): Promise<unknown>;
  delete(args: unknown): Promise<unknown>;
}

export const delegateOf = (db: object, model: string): AnyDelegate =>
  (db as unknown as Record<string, AnyDelegate>)[
    model.charAt(0).toLowerCase() + model.slice(1)
  ] as AnyDelegate;

export interface World {
  /** One Actor per role, plus the service Actor that owns the API key. */
  readonly actors: { viewer: Actor; operator: Actor; admin: Actor; service: Actor };
  /** A unique `where` for one existing row of each model. */
  readonly where: Record<string, Record<string, unknown>>;
  /** Valid `data` for creating one more row of `model`. Every call yields a new unique row. */
  createData(model: string): Record<string, unknown>;
  /**
   * A valid update payload for `model` that changes one non-protected-looking field. Used to prove
   * a denied update leaves the row alone.
   */
  patch(model: string): Record<string, unknown>;
}

export interface Actor {
  id: string;
  kind: 'human' | 'service';
  displayName: string;
  role: 'viewer' | 'operator' | 'admin';
  disabled: boolean;
}

let counter = 0;
const uniq = (label: string): string => `${label}-${++counter}`;

/** Inserts one row of every model through the privileged client. */
export async function buildWorld(db: Db): Promise<World> {
  const now = new Date();
  const actorOf = async (role: Actor['role'], kind: Actor['kind']): Promise<Actor> =>
    (await db.actor.create({
      data: { kind, role, displayName: `${role}-${kind}`, email: `${role}-${kind}@test.local` },
    })) as Actor;
  const actors = {
    viewer: await actorOf('viewer', 'human'),
    operator: await actorOf('operator', 'human'),
    admin: await actorOf('admin', 'human'),
    service: await actorOf('operator', 'service'),
  };

  const mkEndpoint = (id: string) =>
    db.endpoint.create({
      data: {
        id,
        providerType: 'type-a',
        displayName: id,
        baseUrl: `http://${id}.test`,
        status: 'active',
        configHash: 'h',
      },
    });
  const source = await mkEndpoint('src');
  const target = await mkEndpoint('dst');
  const route = await db.route.create({
    data: {
      id: 'route-1',
      sourceEndpointId: source.id,
      targetEndpointId: target.id,
      targetNamespacePath: 'acme',
      policies: {},
      defaults: {},
      configHash: 'h',
      sourcePostAction: 'read-only',
    },
  });
  const namespace = await db.namespace.create({
    data: {
      endpointId: source.id,
      providerId: 'ns-1',
      kind: 'project',
      slug: 'plat',
      name: 'Plat',
    },
  });
  const repository = await db.repository.create({
    data: {
      endpointId: source.id,
      namespaceId: namespace.id,
      providerId: 'repo-1',
      slug: 'auto-ok',
      name: 'auto-ok',
      fullPath: 'acme/plat/auto-ok',
      isPrivate: true,
      lastInventoriedAt: now,
    },
  });
  const wave = await db.wave.create({ data: { name: 'wave-0' } });
  const migration = await db.migration.create({
    data: { scope: 'repository', routeId: route.id, sourceRepositoryId: repository.id },
  });
  const analysis = await db.analysis.create({
    data: {
      migrationId: migration.id,
      sourceSnapshotIds: [],
      targetSnapshotIds: [],
      readiness: 'ready',
      translation: {},
    },
  });
  const planItem = await db.planItem.create({
    data: {
      analysisId: analysis.id,
      facetKey: 'git-refs',
      kind: 'step',
      code: 'c',
      fieldPaths: [],
      params: {},
      order: 0,
    },
  });
  const run = await db.run.create({
    data: {
      migrationId: migration.id,
      analysisId: analysis.id,
      kind: 'migrate',
      triggeredById: actors.operator.id,
      options: {},
    },
  });
  const runStep = await db.runStep.create({
    data: { runId: run.id, stepKey: 'git.push-refs', order: 0 },
  });
  const runLog = await db.runLog.create({
    data: { runId: run.id, stepId: runStep.id, ts: now, level: 'info', message: 'hello' },
  });
  const mutation = await db.mutation.create({
    data: {
      migrationId: migration.id,
      runId: run.id,
      side: 'target',
      facetKey: 'git-refs',
      resourceRef: {},
      paths: [],
      action: 'create',
    },
  });
  const manualTask = await db.manualTask.create({
    data: {
      migrationId: migration.id,
      facetKey: 'secrets',
      code: 'secrets.set-value',
      phase: 'post',
      origin: 'analysis',
      params: {},
      verifiable: false,
      paramsHash: 'p0',
      sourcePlanItemId: planItem.id,
    },
  });
  const expectedDifference = await db.expectedDifference.create({
    data: {
      routeId: route.id,
      facetKey: 'git-refs',
      path: '/refs[name=x]',
      reason: 'manual_accepted',
    },
  });
  const parityResult = await db.parityResult.create({
    data: {
      migrationId: migration.id,
      facetKey: 'git-refs',
      status: 'equal',
      diffs: [],
      excluded: [],
      checkedAt: now,
    },
  });
  const sourceIdentity = await db.identity.create({
    data: {
      endpointId: source.id,
      providerId: 'u1',
      kind: 'user',
      isMember: true,
      email: 'a@x.test',
    },
  });
  const targetIdentity = await db.identity.create({
    data: { endpointId: target.id, providerId: 'u2', kind: 'user', isMember: true },
  });
  const sourceGroup = await db.group.create({
    data: { endpointId: source.id, providerId: 'g1', slug: 'devs', name: 'Devs', memberIds: [] },
  });
  const identityMapping = await db.identityMapping.create({
    data: { routeId: route.id, sourceIdentityId: sourceIdentity.id, status: 'suggested' },
  });
  const groupMapping = await db.groupMapping.create({
    data: {
      routeId: route.id,
      sourceGroupId: sourceGroup.id,
      plannedSlug: 'devs',
      status: 'unmapped',
    },
  });
  const batch = await db.invitationBatch.create({
    data: { routeId: route.id, seatPreview: { toInvite: 1 }, createdById: actors.operator.id },
  });
  const invitation = await db.invitation.create({
    data: {
      batchId: batch.id,
      sourceIdentityId: sourceIdentity.id,
      email: 'a@x.test',
      teamSlugs: [],
    },
  });
  const namingRule = await db.namingRule.create({
    data: { routeId: route.id, scope: 'namespace', scopeRef: namespace.id, pipeline: {} },
  });
  const allowlist = await db.webhookAllowlistEntry.create({
    data: { routeId: route.id, pattern: 'https://hooks.test/*' },
  });
  const overlay = await db.overlay.create({
    data: { routeId: route.id, facetKey: 'git-refs', data: {} },
  });
  const audit = await db.auditEvent.create({
    data: {
      actorId: actors.admin.id,
      action: 'test.seed',
      subjectType: 'Migration',
      subjectId: migration.id,
    },
  });
  const quotaEvent = await db.quotaEvent.create({
    data: { bucketKey: 'b', pool: 'background', at: now },
  });
  const quotaLease = await db.quotaLease.create({
    data: { bucketKey: 'b', holder: 'h', expiresAt: now },
  });
  const quotaState = await db.quotaState.create({
    data: { bucketKey: 'b', limitPerWindow: 10, windowSeconds: 60 },
  });
  const snapshot = await db.facetSnapshot.create({
    data: {
      side: 'source',
      endpointId: source.id,
      repositoryId: repository.id,
      facetKey: 'git-refs',
      schemaVersion: 1,
      data: {},
      unreadable: [],
      hash: 'h',
      fetchedAt: now,
      rawResponseIds: [],
    },
  });
  const rawResponse = await db.rawResponse.create({
    data: {
      endpointId: source.id,
      method: 'GET',
      url: 'http://src.test/x',
      status: 200,
      body: { secret: 'body' },
      fetchedAt: now,
    },
  });
  const apiKey = await db.apiKey.create({
    data: { actorId: actors.service.id, name: 'ci', prefix: 'abcd1234', hash: 'f'.repeat(64) },
  });

  const id = (row: { id: string }) => ({ id: row.id });
  const where: World['where'] = {
    Actor: id(actors.viewer),
    ApiKey: id(apiKey),
    Endpoint: { id: source.id },
    Route: { id: route.id },
    Namespace: id(namespace),
    Repository: id(repository),
    Migration: id(migration),
    FacetSnapshot: id(snapshot),
    RawResponse: id(rawResponse),
    Analysis: id(analysis),
    PlanItem: id(planItem),
    Run: id(run),
    RunStep: id(runStep),
    RunLog: id(runLog),
    Mutation: id(mutation),
    ManualTask: id(manualTask),
    ExpectedDifference: id(expectedDifference),
    ParityResult: id(parityResult),
    Identity: id(sourceIdentity),
    Group: id(sourceGroup),
    IdentityMapping: id(identityMapping),
    GroupMapping: id(groupMapping),
    InvitationBatch: id(batch),
    Invitation: id(invitation),
    Wave: id(wave),
    NamingRule: id(namingRule),
    WebhookAllowlistEntry: id(allowlist),
    Overlay: id(overlay),
    AuditEvent: id(audit),
    QuotaEvent: { id: quotaEvent.id },
    QuotaLease: { id: quotaLease.id },
    QuotaState: { bucketKey: quotaState.bucketKey },
  };

  const createData = (model: string): Record<string, unknown> => {
    const n = uniq(model);
    switch (model) {
      case 'Actor':
        return { kind: 'human', displayName: n, role: 'admin' };
      case 'ApiKey':
        return {
          actorId: actors.service.id,
          name: n,
          prefix: n.slice(-8).padStart(8, 'k'),
          hash: 'h',
        };
      case 'Endpoint':
        return {
          id: n,
          providerType: 't',
          displayName: n,
          baseUrl: 'http://x.test',
          status: 'active',
          configHash: 'h',
        };
      case 'Route':
        return {
          id: n,
          sourceEndpointId: source.id,
          targetEndpointId: target.id,
          targetNamespacePath: 'x',
          policies: {},
          defaults: {},
          configHash: 'h',
          sourcePostAction: 'none',
        };
      case 'Namespace':
        return { endpointId: source.id, providerId: n, kind: 'project', slug: n, name: n };
      case 'Repository':
        return {
          endpointId: source.id,
          namespaceId: namespace.id,
          providerId: n,
          slug: n,
          name: n,
          fullPath: n,
          isPrivate: false,
          lastInventoriedAt: now,
        };
      case 'Migration':
        return { scope: 'repository', routeId: route.id, sourceRepositoryId: repository.id };
      case 'FacetSnapshot':
        return {
          side: 'source',
          endpointId: source.id,
          facetKey: n,
          schemaVersion: 1,
          data: {},
          unreadable: [],
          hash: 'h',
          fetchedAt: now,
          rawResponseIds: [],
        };
      case 'RawResponse':
        return {
          endpointId: source.id,
          method: 'GET',
          url: 'http://x.test',
          status: 200,
          fetchedAt: now,
        };
      case 'Analysis':
        return {
          migrationId: migration.id,
          sourceSnapshotIds: [],
          targetSnapshotIds: [],
          readiness: 'ready',
          translation: {},
        };
      case 'PlanItem':
        return {
          analysisId: analysis.id,
          facetKey: 'f',
          kind: 'step',
          code: n,
          fieldPaths: [],
          params: {},
          order: 1,
        };
      case 'Run':
        return {
          migrationId: migration.id,
          kind: 'verify',
          status: 'succeeded',
          triggeredById: actors.operator.id,
          options: {},
        };
      case 'RunStep':
        return { runId: run.id, stepKey: n, order: 1 };
      case 'RunLog':
        return { runId: run.id, ts: now, level: 'info', message: n };
      case 'Mutation':
        return {
          migrationId: migration.id,
          runId: run.id,
          side: 'target',
          facetKey: 'f',
          resourceRef: {},
          paths: [],
          action: 'create',
        };
      case 'ManualTask':
        return {
          migrationId: migration.id,
          facetKey: 'f',
          code: n,
          phase: 'pre',
          origin: 'run',
          params: {},
          verifiable: false,
          paramsHash: n,
        };
      case 'ExpectedDifference':
        return { routeId: route.id, facetKey: 'f', path: `/${n}`, reason: 'manual_accepted' };
      case 'ParityResult':
        return {
          migrationId: migration.id,
          facetKey: 'f',
          status: 'equal',
          diffs: [],
          excluded: [],
          checkedAt: now,
        };
      case 'Identity':
        return { endpointId: source.id, providerId: n, kind: 'user', isMember: false };
      case 'Group':
        return { endpointId: source.id, providerId: n, slug: n, name: n, memberIds: [] };
      case 'IdentityMapping':
        return { routeId: route.id, sourceIdentityId: targetIdentity.id, status: 'unmapped' };
      case 'GroupMapping':
        return {
          routeId: route.id,
          sourceGroupId: sourceGroup.id,
          plannedSlug: n,
          status: 'unmapped',
        };
      case 'InvitationBatch':
        return { routeId: route.id, seatPreview: {}, createdById: actors.operator.id };
      case 'Invitation':
        return {
          batchId: batch.id,
          sourceIdentityId: sourceIdentity.id,
          email: 'b@x.test',
          teamSlugs: [],
        };
      case 'Wave':
        return { name: n };
      case 'NamingRule':
        return { routeId: route.id, scope: 'repository', scopeRef: n, pipeline: {} };
      case 'WebhookAllowlistEntry':
        return { routeId: route.id, pattern: `https://${n}.test/*` };
      case 'Overlay':
        return { routeId: route.id, facetKey: n, data: {} };
      case 'AuditEvent':
        return { action: n, subjectType: 'Migration', subjectId: migration.id };
      case 'QuotaEvent':
        return { bucketKey: n, pool: 'background', at: now };
      case 'QuotaLease':
        return { bucketKey: n, holder: 'h', expiresAt: now };
      case 'QuotaState':
        return { bucketKey: n, limitPerWindow: 1, windowSeconds: 1 };
      default:
        throw new Error(`no create data for model ${model}`);
    }
  };

  const patch = (model: string): Record<string, unknown> => {
    switch (model) {
      case 'RunLog':
        return { message: 'changed' };
      case 'AuditEvent':
        return { action: 'changed' };
      case 'QuotaEvent':
        return { pool: 'interactive' };
      case 'Actor':
        return { displayName: 'changed' };
      case 'Wave':
        return { description: uniq('changed') };
      case 'ManualTask':
        return { status: 'done' };
      case 'Migration':
        return { plannedTargetName: 'changed' };
      default:
        return { updatedAt: new Date('2030-01-01T00:00:00.000Z') };
    }
  };

  return { actors, where, createData, patch };
}
