import type { Db } from '@git-migrator/db';

/** Rows the jobs tests need: one Route with a source repository and its Migration. */
export interface BasicWorld {
  readonly actorId: string;
  readonly sourceEndpointId: string;
  readonly targetEndpointId: string;
  readonly routeId: string;
  readonly repositoryId: string;
  readonly migrationId: string;
}

let counter = 0;

/** Inserts a fresh, independent set of rows through the privileged client. */
export async function seedBasics(
  db: Db,
  options: { sizeClass?: 'standard' | 'large' } = {},
): Promise<BasicWorld> {
  const n = ++counter;
  const actor = await db.actor.create({
    data: { kind: 'service', role: 'operator', displayName: `t${n}`, email: `t${n}@test.local` },
  });
  const endpoint = (id: string) =>
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
  const source = await endpoint(`src-${n}`);
  const target = await endpoint(`dst-${n}`);
  const route = await db.route.create({
    data: {
      id: `route-${n}`,
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
    data: { endpointId: source.id, providerId: 'ns', kind: 'project', slug: 'plat', name: 'Plat' },
  });
  const repository = await db.repository.create({
    data: {
      endpointId: source.id,
      namespaceId: namespace.id,
      providerId: 'repo',
      slug: 'r',
      name: 'r',
      fullPath: 'acme/plat/r',
      isPrivate: true,
      sizeClass: options.sizeClass ?? 'standard',
      lastInventoriedAt: new Date(),
    },
  });
  const migration = await db.migration.create({
    data: { scope: 'repository', routeId: route.id, sourceRepositoryId: repository.id },
  });
  return {
    actorId: actor.id,
    sourceEndpointId: source.id,
    targetEndpointId: target.id,
    routeId: route.id,
    repositoryId: repository.id,
    migrationId: migration.id,
  };
}

export interface SeedRunFields {
  status?: 'queued' | 'running';
  sizeClass?: 'standard' | 'large';
  kind?: 'migrate' | 'verify';
  leaseOwner?: string | null;
  /** Seconds from now (negative: already expired). */
  leaseExpiresInSeconds?: number | null;
  reaperResumes?: number;
}

/** Inserts a Migration with one Run (running by default) and returns the Run id. */
export async function seedRun(
  handle: { db: import('@git-migrator/db').Db; pool: import('pg').Pool },
  fields: SeedRunFields = {},
): Promise<string> {
  const world = await seedBasics(handle.db, { sizeClass: fields.sizeClass ?? 'standard' });
  const run = await handle.db.run.create({
    data: {
      migrationId: world.migrationId,
      kind: fields.kind ?? 'migrate',
      triggeredById: world.actorId,
      options: {},
      status: fields.status ?? 'running',
      startedAt: new Date(),
      reaperResumes: fields.reaperResumes ?? 0,
      leaseOwner: fields.leaseOwner ?? null,
    },
  });
  if (fields.leaseExpiresInSeconds !== undefined && fields.leaseExpiresInSeconds !== null) {
    await handle.pool.query(
      'UPDATE app.run SET lease_expires_at = clock_timestamp() + make_interval(secs => $2) WHERE id = $1',
      [run.id, fields.leaseExpiresInSeconds],
    );
  }
  return run.id;
}
