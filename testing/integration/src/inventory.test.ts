/**
 * T-060: the inventory processor against the TST-012 fixture world. The real adapters (through the
 * registry) talk to the fake Bitbucket and GitHub over loopback; Postgres is a throw-away database.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  EndpointConnection,
  IdentityRecord,
  RepositoryRecord,
} from '@git-migrator/adapter-sdk';
import { type Config, resolveConfig } from '@git-migrator/config';
import { hashConfig, syncConfig } from '@git-migrator/db';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import {
  resetWorld,
  startWorldFakes,
  WORLD_GITHUB_ONLY_MEMBERS,
  WORLD_GROUPS,
  WORLD_MEMBERS,
  WORLD_PROJECTS,
  WORLD_REPOSITORIES,
  WORLD_WORKSPACE,
} from '@git-migrator/fixtures';
import {
  createEndpointConnector,
  createProviderEnvironment,
  type EndpointConnector,
  type InventoryDeps,
  InventoryInterruptedError,
  inventoryHandlers,
  noGitClient,
  runInventory,
} from '@git-migrator/jobs';
import { createLogger, createMetrics } from '@git-migrator/observability';
import type { RunningFakes } from '@git-migrator/provider-fakes';
import { QuotaLeases, QuotaService } from '@git-migrator/quota';
import { createBuiltinRegistry } from '@git-migrator/registry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const PEM = readFileSync(join(here, '../../fixtures/fake-github-app.pem'), 'utf8');
const BB_AUTH = `Basic ${Buffer.from('operator@test.local:fake-bitbucket-api-token').toString('base64')}`;
const SOURCE = 'bb-src';
const TARGET = 'gh-dst';
const log = createLogger({ level: 'silent' });
const registry = createBuiltinRegistry();

let fakes: RunningFakes;
let t: TestDatabase;
let config: Config;
let connector: EndpointConnector;
let deps: InventoryDeps;
const shutdown = new AbortController();

/** Wraps the real connector to change what the adapters report, as a decorator on the interface. */
interface Tweaks {
  hideRepositories?: ReadonlySet<string>;
  identities?: (records: IdentityRecord[]) => IdentityRecord[];
  afterListRepositories?: () => void;
  mapRepository?: (record: RepositoryRecord) => RepositoryRecord;
  connectError?: Error;
  emptyNamespaces?: boolean;
  emptyRepositories?: boolean;
  /** Every namespace page names the same next cursor. */
  loopNamespaces?: boolean;
}
let tweaks: Tweaks = {};

function tweaked(real: EndpointConnector): EndpointConnector {
  return {
    async connect(endpointId, options) {
      if (tweaks.connectError) throw tweaks.connectError;
      const connection = await real.connect(endpointId, options);
      const inventory: EndpointConnection['inventory'] = {
        ...connection.inventory,
        async listNamespaces(cursor) {
          if (tweaks.emptyNamespaces) return { items: [] };
          const page = await connection.inventory.listNamespaces(
            tweaks.loopNamespaces ? undefined : cursor,
          );
          return tweaks.loopNamespaces ? { ...page, nextCursor: 'same' } : page;
        },
        async listRepositories(ns, cursor) {
          if (tweaks.emptyRepositories) return { items: [] };
          const page = await connection.inventory.listRepositories(ns, cursor);
          tweaks.afterListRepositories?.();
          const hidden = tweaks.hideRepositories;
          const visible = hidden ? page.items.filter((r) => !hidden.has(r.slug)) : page.items;
          const items: readonly RepositoryRecord[] = tweaks.mapRepository
            ? visible.map(tweaks.mapRepository)
            : visible;
          return { ...page, items };
        },
        async listIdentities(cursor) {
          const page = await connection.inventory.listIdentities(cursor);
          return tweaks.identities ? { ...page, items: tweaks.identities([...page.items]) } : page;
        },
      };
      return { ...connection, inventory };
    },
  };
}

const rowCounts = async () => {
  const q = async (table: string) =>
    Number((await t.db.pool.query(`SELECT count(*) AS n FROM app.${table}`)).rows[0].n);
  return {
    namespace: await q('namespace'),
    repository: await q('repository'),
    identity: await q('identity'),
    group: await q('"group"'),
    migration: await q('migration'),
    identityMapping: await q('identity_mapping'),
    groupMapping: await q('group_mapping'),
  };
};

const mappingsOf = async (routeId: string) =>
  new Map(
    (
      await t.db.privileged.identityMapping.findMany({
        where: { routeId },
        include: { sourceIdentity: true, targetIdentity: true },
      })
    ).map((m) => [m.sourceIdentity.login ?? m.sourceIdentity.providerId, m]),
  );

const run = (endpointId = SOURCE) => runInventory(deps, endpointId, { shutdown: shutdown.signal });

beforeAll(async () => {
  t = await createTestDatabase('gm_t060_');
  fakes = await startWorldFakes({ bitbucketPort: 0, githubPort: 0, gitPort: 0 });
  await resetWorld(fakes);
  const gh = fakes.github;
  if (!gh) throw new Error('the fake GitHub did not start');
  const installationId = [...gh.state.installations.keys()][0] as number;
  const gitBase = fakes.git?.baseUrl ?? 'http://127.0.0.1:1';
  config = resolveConfig({
    text: `
environment: test
endpoints:
  - id: ${SOURCE}
    provider: bitbucket-cloud
    baseUrl: http://127.0.0.1:${fakes.bitbucket.port}
    gitBaseUrl: ${gitBase}
    options: { workspace: ${WORLD_WORKSPACE} }
  - id: ${TARGET}
    provider: github
    baseUrl: http://127.0.0.1:${gh.port}
    gitBaseUrl: ${gitBase}
    options: { org: acme, appId: ${gh.state.ownApp.id}, installationId: ${installationId} }
routes:
  - id: r-auto
    source: ${SOURCE}
    target: ${TARGET}
    targetNamespace: acme
  - id: r-manual
    source: ${SOURCE}
    target: ${TARGET}
    targetNamespace: acme
    policies: { identityMatch: { autoConfirmEmail: false } }
`,
    env: {},
  });
  await syncConfig(t.db.privileged, {
    endpoints: config.endpoints.map((e) => ({
      id: e.id,
      providerType: e.provider,
      displayName: e.id,
      baseUrl: e.baseUrl,
      configHash: hashConfig(e),
    })),
    routes: config.routes.map((r) => ({
      id: r.id,
      sourceEndpointId: r.source,
      targetEndpointId: r.target,
      targetNamespacePath: r.targetNamespace,
      policies: r.policies,
      defaults: r.defaults,
      sourcePostAction: r.sourcePostAction,
      configHash: hashConfig(r),
    })),
  });
  const environment = createProviderEnvironment({
    quota: new QuotaService({ pool: t.db.pool }),
    leases: new QuotaLeases({ pool: t.db.pool }),
    db: t.db.privileged,
    recorders: createMetrics().recorders,
    logger: log,
    environment: 'test',
  });
  connector = tweaked(
    createEndpointConnector({
      config,
      registry,
      env: {
        BITBUCKET_CREDENTIALS: JSON.stringify([
          {
            id: 'operator',
            accountId: 'acct-operator',
            email: 'operator@test.local',
            apiToken: 'fake-bitbucket-api-token',
          },
        ]),
        GITHUB_APP_PRIVATE_KEY: PEM,
      },
      environment,
      git: noGitClient,
    }),
  );
  deps = { db: t.db.privileged, appPool: t.db.pool, connector, registry, config, log };
}, 180_000);

afterAll(async () => {
  await fakes?.close();
  await t?.drop();
}, 60_000);

describe('inventory against the fixture world', () => {
  it('[JOB-030][DOM-014] creates the endpoint Migration of every Route even when the provider is down', async () => {
    // Config sync creates them too; remove them to see the inventory create them itself.
    await t.db.privileged.migration.deleteMany({});
    tweaks = { connectError: new Error('provider down') };
    try {
      await expect(run(SOURCE)).rejects.toThrow('provider down');
    } finally {
      tweaks = {};
    }
    for (const routeId of ['r-auto', 'r-manual']) {
      const migrations = await t.db.privileged.migration.findMany({ where: { routeId } });
      expect(migrations).toHaveLength(1);
      expect(migrations[0]).toMatchObject({ scope: 'endpoint', sourceRepositoryId: null });
    }
  });

  it('[JOB-030] creates every Namespace, Repository, Identity, Group and Migration of the world', async () => {
    const source = await run(SOURCE);
    const target = await run(TARGET);

    // Bitbucket: the workspace plus its projects; GitHub: the organization.
    expect(source.namespaces).toBe(WORLD_PROJECTS.length + 1);
    expect(target.namespaces).toBe(1);
    expect(source.repositories).toBe(WORLD_REPOSITORIES.length);
    expect(target.repositories).toBe(0);

    const repositories = await t.db.privileged.repository.findMany({
      where: { endpointId: SOURCE },
      include: { namespace: true },
    });
    expect(repositories.map((r) => r.fullPath).sort()).toEqual(
      WORLD_REPOSITORIES.map((r) => `${WORLD_WORKSPACE}/${r.project}/${r.slug}`).sort(),
    );
    expect(repositories.every((r) => r.presence === 'present')).toBe(true);
    const plat = repositories.find((r) => r.slug === 'auto-ok');
    expect(plat?.namespace.slug).toBe('PLAT');
    expect(plat?.namespace.kind).toBe('project');

    // Namespaces form the workspace > project tree.
    const workspace = await t.db.privileged.namespace.findFirst({
      where: { endpointId: SOURCE, kind: 'workspace' },
    });
    const projects = await t.db.privileged.namespace.findMany({
      where: { endpointId: SOURCE, kind: 'project' },
    });
    expect(projects.map((p) => p.slug).sort()).toEqual(WORLD_PROJECTS.map((p) => p.key).sort());
    expect(projects.every((p) => p.parentId === workspace?.id)).toBe(true);

    // Identities: the world members and the operator on Bitbucket, the org members on GitHub.
    const sourceLogins = (
      await t.db.privileged.identity.findMany({ where: { endpointId: SOURCE } })
    ).map((i) => i.login);
    for (const m of WORLD_MEMBERS) expect(sourceLogins).toContain(m.nickname);
    const targetLogins = (
      await t.db.privileged.identity.findMany({ where: { endpointId: TARGET } })
    ).map((i) => i.login);
    for (const m of WORLD_GITHUB_ONLY_MEMBERS) expect(targetLogins).toContain(m.login);

    // Groups carry their members as Identity ids.
    const groups = await t.db.privileged.group.findMany({ where: { endpointId: SOURCE } });
    for (const spec of WORLD_GROUPS) {
      const group = groups.find((g) => g.slug === spec.slug);
      expect(group, spec.slug).toBeDefined();
      const members = await t.db.privileged.identity.findMany({
        where: { id: { in: group?.memberIds ?? [] } },
      });
      expect(members.map((m) => m.providerId).sort()).toEqual([...spec.members].sort());
    }

    // The Route's target namespace is resolved from the first target inventory.
    const route = await t.db.privileged.route.findUnique({ where: { id: 'r-auto' } });
    const org = await t.db.privileged.namespace.findFirst({ where: { endpointId: TARGET } });
    expect(route?.targetNamespaceId).toBe(org?.id);
  }, 120_000);

  it('[JOB-030][DOM-014] has one endpoint Migration per Route and one repository Migration per source Repository', async () => {
    for (const routeId of ['r-auto', 'r-manual']) {
      const migrations = await t.db.privileged.migration.findMany({ where: { routeId } });
      expect(migrations.filter((m) => m.scope === 'endpoint')).toHaveLength(1);
      expect(migrations.filter((m) => m.scope === 'repository')).toHaveLength(
        WORLD_REPOSITORIES.length,
      );
      expect(migrations.every((m) => m.status === 'discovered')).toBe(true);
    }
    // Target-side repositories get none: only the source Endpoint's Repositories do.
    expect(
      await t.db.privileged.migration.count({
        where: { scope: 'repository', sourceRepository: { endpointId: TARGET } },
      }),
    ).toBe(0);
  });

  it('[JOB-015] derives the size class from the threshold and keeps the last known size when the provider reports none', async () => {
    const big = await t.db.privileged.repository.findFirstOrThrow({ where: { slug: 'big-blob' } });
    const over = BigInt(config.sizeClass.largeThresholdBytes) + 1n;
    await t.db.privileged.repository.update({ where: { id: big.id }, data: { sizeBytes: over } });
    const withoutSize = ({ sizeBytes: _omitted, ...rest }: RepositoryRecord): RepositoryRecord =>
      rest;
    tweaks = { mapRepository: withoutSize };
    try {
      await run(SOURCE);
    } finally {
      tweaks = {};
    }
    const kept = await t.db.privileged.repository.findUniqueOrThrow({ where: { id: big.id } });
    expect(kept).toMatchObject({ sizeBytes: over, sizeClass: 'large' });

    // The provider's own figure wins as soon as it reports one.
    const small = (r: RepositoryRecord): RepositoryRecord => ({ ...r, sizeBytes: 10 });
    tweaks = { mapRepository: small };
    try {
      await run(SOURCE);
    } finally {
      tweaks = {};
    }
    expect(
      await t.db.privileged.repository.findUniqueOrThrow({ where: { id: big.id } }),
    ).toMatchObject({ sizeBytes: 10n, sizeClass: 'standard' });
  }, 120_000);

  it('[JOB-030] is idempotent: a second pass creates nothing and keeps every id', async () => {
    const before = await rowCounts();
    const ids = (await t.db.privileged.repository.findMany({ select: { id: true } })).map(
      (r) => r.id,
    );
    const migrationIds = (await t.db.privileged.migration.findMany({ select: { id: true } })).map(
      (m) => m.id,
    );

    const stamp = new Date('2030-01-01T00:00:00Z');
    const result = await runInventory({ ...deps, now: () => stamp }, SOURCE, {
      shutdown: shutdown.signal,
    });
    await run(TARGET);

    // Unchanged rows only get their "seen" stamp, in batches.
    const stamps = await t.db.privileged.repository.findMany({
      where: { endpointId: SOURCE },
      select: { lastInventoriedAt: true },
    });
    expect(stamps.every((r) => r.lastInventoriedAt.getTime() === stamp.getTime())).toBe(true);
    expect(await rowCounts()).toEqual(before);
    expect(result.createdMigrations).toBe(0);
    expect(result.missing).toBe(0);
    expect(result.mappingsChanged).toBe(0);
    expect(
      (await t.db.privileged.repository.findMany({ select: { id: true } })).map((r) => r.id).sort(),
    ).toEqual(ids.sort());
    expect(
      (await t.db.privileged.migration.findMany({ select: { id: true } })).map((m) => m.id).sort(),
    ).toEqual(migrationIds.sort());
  }, 120_000);

  it('[AUTH-050] runs the matching cascade: a login match is suggested and the rest stays unmapped', async () => {
    const mappings = await mappingsOf('r-auto');
    // Identity emails are not part of the Bitbucket data without the Atlassian Admin source, so the
    // email step has nothing to match here (see the next test).
    const bob = mappings.get('bob');
    expect(bob).toMatchObject({ status: 'suggested', method: 'login', confidence: 0.9 });
    expect(bob?.targetIdentity?.login).toBe('bob');
    const carol = mappings.get('carol');
    expect(carol).toMatchObject({ status: 'unmapped', targetIdentityId: null, method: null });
    // Every source Identity has a mapping row.
    const sources = await t.db.privileged.identity.count({ where: { endpointId: SOURCE } });
    expect(mappings.size).toBe(sources);
  });

  it('[AUTH-050] confirms an exact email match when autoConfirmEmail is on and only suggests it otherwise', async () => {
    const withEmails = (records: IdentityRecord[]): IdentityRecord[] =>
      records.map((r) => {
        const member = WORLD_MEMBERS.find(
          (m) => m.accountId === r.providerId.replace(/^\{|\}$/g, '') || m.nickname === r.login,
        );
        return member?.email ? { ...r, email: member.email, emailSource: 'atlassian-admin' } : r;
      });
    const watched = await Promise.all(
      ['r-auto', 'r-manual'].map(async (routeId) => {
        const repo = await t.db.privileged.repository.findFirstOrThrow({
          where: { slug: 'with-secrets' },
        });
        const migration = await t.db.privileged.migration.findFirstOrThrow({
          where: { routeId, sourceRepositoryId: repo.id },
        });
        const analysis = await t.db.privileged.analysis.create({
          data: {
            migrationId: migration.id,
            sourceSnapshotIds: [],
            targetSnapshotIds: [],
            readiness: 'ready',
            translation: {},
          },
        });
        await t.db.privileged.migration.update({
          where: { id: migration.id },
          data: { latestAnalysisId: analysis.id },
        });
        return { routeId, id: migration.id };
      }),
    );
    tweaks = { identities: withEmails };
    try {
      const result = await run(SOURCE);
      expect(result.mappingsChanged).toBeGreaterThan(0);
    } finally {
      tweaks = {};
    }
    // AUTH-050 step 5: a new confirmation makes the Route's Analyses stale; a suggestion does not.
    const staleOf = async (routeId: string) =>
      (
        await t.db.privileged.migration.findUniqueOrThrow({
          where: { id: watched.find((w) => w.routeId === routeId)?.id ?? '' },
        })
      ).analysisStaleAt;
    expect(await staleOf('r-auto')).not.toBeNull();
    expect(await staleOf('r-manual')).toBeNull();
    const auto = await mappingsOf('r-auto');
    const manual = await mappingsOf('r-manual');
    for (const m of WORLD_MEMBERS) {
      const a = auto.get(m.nickname);
      const b = manual.get(m.nickname);
      if (m.match === 'email') {
        expect(a, m.nickname).toMatchObject({ status: 'confirmed', method: 'email' });
        expect(a?.targetIdentity?.login).toBe(m.github?.login);
        expect(a?.decidedAt).not.toBeNull();
        expect(b, m.nickname).toMatchObject({ status: 'suggested', method: 'email' });
        expect(b?.targetIdentity?.login).toBe(m.github?.login);
      } else if (m.match === 'login') {
        expect(a, m.nickname).toMatchObject({ status: 'suggested', method: 'login' });
      } else {
        expect(a, m.nickname).toMatchObject({ status: 'unmapped' });
      }
    }
  }, 120_000);

  it('[AUTH-050] never overwrites a decision, and keeps rematching only unmapped and suggested rows', async () => {
    const auto = await mappingsOf('r-auto');
    const bob = auto.get('bob');
    const carol = auto.get('carol');
    await t.db.privileged.identityMapping.update({
      where: { id: bob?.id ?? '' },
      data: { status: 'excluded', targetIdentityId: null, method: null, confidence: null },
    });
    await t.db.privileged.identityMapping.update({
      where: { id: carol?.id ?? '' },
      data: { status: 'pending_invite' },
    });
    await run(SOURCE);
    await run(TARGET);
    const after = await mappingsOf('r-auto');
    expect(after.get('bob')).toMatchObject({ status: 'excluded', targetIdentityId: null });
    expect(after.get('carol')).toMatchObject({ status: 'pending_invite' });
    // The suggestion on the other Route is still recomputed from the data.
    expect((await mappingsOf('r-manual')).get('bob')).toMatchObject({ status: 'suggested' });
  }, 120_000);

  it('[AUTH-050] plans a team for every group and suggests an existing target team with the same slug', async () => {
    const mappings = await t.db.privileged.groupMapping.findMany({
      where: { routeId: 'r-auto' },
      include: { sourceGroup: true },
    });
    const platform = mappings.find((m) => m.sourceGroup.slug === 'platform-team');
    // The world's GitHub organization has no teams.
    expect(platform).toMatchObject({
      status: 'unmapped',
      plannedSlug: 'platform-team',
      targetGroupId: null,
    });
    // A team with that slug appears on the target: the next pass suggests it.
    fakes.github?.state.addTeam('acme', { name: 'Platform Team' });
    await run(TARGET);
    const after = await t.db.privileged.groupMapping.findFirst({
      where: { id: platform?.id ?? '' },
      include: { targetGroup: true },
    });
    expect(after?.status).toBe('suggested');
    expect(after?.targetGroup?.slug).toBe('platform-team');
  }, 120_000);

  it('[JOB-030] follows a renamed repository by its provider id and marks its Analysis stale', async () => {
    const before = await t.db.privileged.repository.findFirstOrThrow({
      where: { slug: 'auto-ok' },
    });
    const migration = await t.db.privileged.migration.findFirstOrThrow({
      where: { routeId: 'r-auto', sourceRepositoryId: before.id },
    });
    const analysis = await t.db.privileged.analysis.create({
      data: {
        migrationId: migration.id,
        sourceSnapshotIds: [],
        targetSnapshotIds: [],
        readiness: 'ready',
        translation: {},
      },
    });
    await t.db.privileged.migration.update({
      where: { id: migration.id },
      data: { latestAnalysisId: analysis.id, status: 'analyzed' },
    });

    const res = await fetch(
      `http://127.0.0.1:${fakes.bitbucket.port}/2.0/repositories/${WORLD_WORKSPACE}/auto-ok`,
      {
        method: 'PUT',
        headers: { Authorization: BB_AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'auto-fine' }),
      },
    );
    expect(res.status).toBe(200);

    const result = await run(SOURCE);
    const after = await t.db.privileged.repository.findFirstOrThrow({ where: { id: before.id } });
    expect(after).toMatchObject({ slug: 'auto-fine', presence: 'present' });
    expect(after.fullPath).toContain('auto-fine');
    expect(await t.db.privileged.repository.count({ where: { slug: 'auto-ok' } })).toBe(0);
    expect(result.staleMigrations).toBeGreaterThan(0);
    const stale = await t.db.privileged.migration.findUniqueOrThrow({
      where: { id: migration.id },
    });
    expect(stale.analysisStaleAt).not.toBeNull();
    // The Migration is the same one: no duplicate was created for the new name.
    expect(
      await t.db.privileged.migration.count({
        where: { routeId: 'r-auto', sourceRepositoryId: before.id },
      }),
    ).toBe(1);
  }, 120_000);

  it('[JOB-030][LIF-002] sets presence missing for unseen repositories and their Migrations to source_missing, then restores them', async () => {
    const hidden = await t.db.privileged.repository.findFirstOrThrow({
      where: { slug: 'open-pr' },
    });
    await t.db.privileged.migration.updateMany({
      where: { sourceRepositoryId: hidden.id },
      data: { status: 'analyzed' },
    });
    tweaks = { hideRepositories: new Set(['open-pr']) };
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run(SOURCE);
      expect(result.missing).toBe(1);
      expect(
        (await t.db.privileged.repository.findUniqueOrThrow({ where: { id: hidden.id } })).presence,
      ).toBe('missing');
      for (const m of await t.db.privileged.migration.findMany({
        where: { sourceRepositoryId: hidden.id },
      })) {
        expect(m).toMatchObject({ status: 'source_missing', statusBeforeMissing: 'analyzed' });
      }
      // Another pass changes nothing (the event is a no-op in source_missing).
      expect((await run(SOURCE)).missing).toBe(0);
    } finally {
      tweaks = {};
    }

    // It comes back: presence present again, the Migration restores its earlier status.
    const back = await run(SOURCE);
    expect(back.reappeared).toBe(1);
    expect(
      (await t.db.privileged.repository.findUniqueOrThrow({ where: { id: hidden.id } })).presence,
    ).toBe('present');
    for (const m of await t.db.privileged.migration.findMany({
      where: { sourceRepositoryId: hidden.id },
    })) {
      expect(m.status).toBe('analyzed');
    }
  }, 120_000);

  it('[JOB-030][LIF-002] defers source_missing while the Migration is running and applies it after the Run', async () => {
    const repo = await t.db.privileged.repository.findFirstOrThrow({ where: { slug: 'hooks' } });
    const migration = await t.db.privileged.migration.findFirstOrThrow({
      where: { routeId: 'r-auto', sourceRepositoryId: repo.id },
    });
    await t.db.privileged.migration.update({
      where: { id: migration.id },
      data: { status: 'running' },
    });
    tweaks = { hideRepositories: new Set(['hooks']) };
    try {
      await run(SOURCE);
      expect(
        (await t.db.privileged.migration.findUniqueOrThrow({ where: { id: migration.id } })).status,
      ).toBe('running');
      expect(
        (await t.db.privileged.repository.findUniqueOrThrow({ where: { id: repo.id } })).presence,
      ).toBe('missing');
      // The Run ends; the next pass sees the repository still missing and sends the event.
      await t.db.privileged.migration.update({
        where: { id: migration.id },
        data: { status: 'migrated' },
      });
      await run(SOURCE);
    } finally {
      tweaks = {};
    }
    expect(
      await t.db.privileged.migration.findUniqueOrThrow({ where: { id: migration.id } }),
    ).toMatchObject({ status: 'source_missing', statusBeforeMissing: 'migrated' });
    await run(SOURCE);
  }, 120_000);

  it('[JOB-030] never marks anything missing when shutdown cuts a pass short', async () => {
    const controller = new AbortController();
    tweaks = {
      hideRepositories: new Set(WORLD_REPOSITORIES.map((r) => r.slug)),
      afterListRepositories: () => controller.abort(),
    };
    try {
      await expect(
        runInventory(deps, SOURCE, { shutdown: controller.signal }),
      ).rejects.toBeInstanceOf(InventoryInterruptedError);
    } finally {
      tweaks = {};
    }
    expect(await t.db.privileged.repository.count({ where: { presence: 'missing' } })).toBe(0);
    await expect(
      runInventory(deps, SOURCE, { shutdown: controller.signal }),
    ).rejects.toBeInstanceOf(InventoryInterruptedError);
  }, 120_000);

  it('[JOB-030] registers the inventory.endpoint handler, which checks the shutdown signal', async () => {
    const handlers = inventoryHandlers(deps);
    const handler = handlers['inventory.endpoint'];
    expect(handler).toBeTypeOf('function');
    const aborted = new AbortController();
    aborted.abort();
    const context = { shutdown: aborted.signal, log } as never;
    await expect(handler?.({ endpointId: SOURCE }, context)).rejects.toBeInstanceOf(
      InventoryInterruptedError,
    );
    const live = await handler?.({ endpointId: SOURCE }, {
      shutdown: shutdown.signal,
      log,
    } as never);
    expect(live).toMatchObject({ repositories: WORLD_REPOSITORIES.length });
  }, 120_000);

  it('[FAC-DKY-003] keeps one row per (endpointId, providerId) and the right presence across hide and restore', async () => {
    const before = await t.db.privileged.repository.findMany({ where: { endpointId: SOURCE } });
    tweaks = { hideRepositories: new Set(['pipelines-simple']) };
    try {
      await run(SOURCE);
    } finally {
      tweaks = {};
    }
    await run(SOURCE);
    const after = await t.db.privileged.repository.findMany({ where: { endpointId: SOURCE } });
    expect(after).toHaveLength(before.length);
    expect(new Set(after.map((r) => r.providerId)).size).toBe(after.length);
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
    expect(after.every((r) => r.presence === 'present')).toBe(true);
  }, 120_000);

  it('[LIF-002] leaves a Migration alone when a Run starts between the read and the write', async () => {
    const repo = await t.db.privileged.repository.findFirstOrThrow({
      where: { slug: 'with-secrets' },
    });
    const [raced, other] = await Promise.all(
      ['r-auto', 'r-manual'].map((routeId) =>
        t.db.privileged.migration.findFirstOrThrow({
          where: { routeId, sourceRepositoryId: repo.id },
        }),
      ),
    );
    await t.db.privileged.migration.updateMany({
      where: { sourceRepositoryId: repo.id },
      data: { status: 'analyzed' },
    });
    const racing: InventoryDeps = {
      ...deps,
      hooks: {
        beforeTransitionWrite: async (id) => {
          if (id !== raced?.id) return;
          await t.db.privileged.migration.update({
            where: { id },
            data: { status: 'running', statusBeforeRun: 'analyzed' },
          });
        },
      },
    };
    tweaks = { hideRepositories: new Set(['with-secrets']) };
    try {
      await runInventory(racing, SOURCE, { shutdown: shutdown.signal });
    } finally {
      tweaks = {};
    }
    // The Run's state survives; the other Migration was not raced and went source_missing.
    expect(
      await t.db.privileged.migration.findUniqueOrThrow({ where: { id: raced?.id ?? '' } }),
    ).toMatchObject({ status: 'running', statusBeforeRun: 'analyzed' });
    expect(
      await t.db.privileged.migration.findUniqueOrThrow({ where: { id: other?.id ?? '' } }),
    ).toMatchObject({ status: 'source_missing', statusBeforeMissing: 'analyzed' });
    // Restore for the following tests.
    await t.db.privileged.migration.update({
      where: { id: raced?.id ?? '' },
      data: { status: 'analyzed', statusBeforeRun: null },
    });
    await run(SOURCE);
  }, 120_000);

  it('[AUTH-050] keeps an operator decision made while the pass is running', async () => {
    const withEmail = (records: IdentityRecord[]): IdentityRecord[] =>
      records.map((r) =>
        r.login === 'alice'
          ? { ...r, email: 'alice@acme.example', emailSource: 'atlassian-admin' }
          : r,
      );
    tweaks = { identities: withEmail };
    try {
      await run(SOURCE);
    } finally {
      tweaks = {};
    }
    const alice = (await mappingsOf('r-manual')).get('alice');
    expect(alice).toMatchObject({ status: 'suggested', method: 'email' });
    const racing: InventoryDeps = {
      ...deps,
      hooks: {
        beforeMappingWrite: async (id) => {
          if (id !== alice?.id) return;
          await t.db.privileged.identityMapping.update({
            where: { id },
            data: { status: 'confirmed', method: 'manual' },
          });
        },
      },
    };
    // Without the email the cascade would now rewrite the row to unmapped.
    const result = await runInventory(racing, SOURCE, { shutdown: shutdown.signal });
    expect(
      await t.db.privileged.identityMapping.findUniqueOrThrow({ where: { id: alice?.id ?? '' } }),
    ).toMatchObject({ status: 'confirmed', method: 'manual' });
    expect(result.mappingsChanged).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it('[AUTH-050] never auto-confirms one target for two sources', async () => {
    const twin = (records: IdentityRecord[]): IdentityRecord[] => [
      ...records,
      {
        providerId: 'twin-account',
        login: 'alice-twin',
        displayName: 'Alice Twin',
        email: 'alice@acme.example',
        emailSource: 'atlassian-admin',
        kind: 'user',
        isMember: true,
      },
    ];
    tweaks = { identities: twin };
    try {
      await run(SOURCE);
    } finally {
      tweaks = {};
    }
    // r-auto already confirmed the target for alice, so the twin is only suggested.
    expect((await mappingsOf('r-auto')).get('alice-twin')).toMatchObject({
      status: 'suggested',
      method: 'email',
    });
  }, 120_000);

  it('[JOB-030] marks nothing missing when the provider lists no namespaces or no repositories', async () => {
    for (const empty of [{ emptyRepositories: true }, { emptyNamespaces: true }]) {
      tweaks = empty;
      try {
        const result = await run(SOURCE);
        expect(result.suspicious).toBe(true);
        expect(result.missing).toBe(0);
      } finally {
        tweaks = {};
      }
      expect(await t.db.privileged.repository.count({ where: { presence: 'missing' } })).toBe(0);
    }
  }, 120_000);

  it('[JOB-030] stops a listing whose cursor repeats', async () => {
    tweaks = { loopNamespaces: true };
    try {
      await expect(run(SOURCE)).rejects.toThrow('cursor it had already returned');
    } finally {
      tweaks = {};
    }
  });

  it('[JOB-030] destroys the connection when the advisory lock cannot be released', async () => {
    const released: unknown[] = [];
    const appPool = {
      connect: async () => ({
        query: async (sql: string) => {
          if (sql.includes('pg_advisory_unlock')) throw new Error('connection lost');
          return { rows: [{ ok: true }] };
        },
        release: (destroy?: boolean) => released.push(destroy),
      }),
    };
    tweaks = { connectError: new Error('stop here') };
    try {
      await expect(
        runInventory({ ...deps, appPool: appPool as never }, SOURCE, { shutdown: shutdown.signal }),
      ).rejects.toThrow('stop here');
    } finally {
      tweaks = {};
    }
    expect(released).toEqual([true]);
  });

  it('[JOB-030] warns about a target namespace it cannot resolve and resolves a cleared one again', async () => {
    await t.db.privileged.route.create({
      data: {
        id: 'r-lost',
        sourceEndpointId: SOURCE,
        targetEndpointId: TARGET,
        targetNamespacePath: 'no-such-org',
        policies: {},
        defaults: {},
        configHash: 'h',
        sourcePostAction: 'read-only',
      },
    });
    await t.db.privileged.route.update({
      where: { id: 'r-auto' },
      data: { targetNamespaceId: null },
    });
    const warnings: string[] = [];
    const spy = new Proxy(log, {
      get: (target, key, receiver) =>
        key === 'warn'
          ? (_fields: unknown, message: string) => warnings.push(message)
          : Reflect.get(target, key, receiver),
    });
    await runInventory({ ...deps, log: spy }, TARGET, { shutdown: shutdown.signal });
    expect(warnings).toContain('target namespace of the Route was not found');
    expect(
      (await t.db.privileged.route.findUniqueOrThrow({ where: { id: 'r-lost' } }))
        .targetNamespaceId,
    ).toBeNull();
    expect(
      (await t.db.privileged.route.findUniqueOrThrow({ where: { id: 'r-auto' } }))
        .targetNamespaceId,
    ).not.toBeNull();
  }, 120_000);

  it('[JOB-030] skips an Endpoint that is retired or unknown, and one that another pass is running', async () => {
    expect(await run('no-such-endpoint')).toMatchObject({ skipped: 'endpoint-retired' });
    const holder = await t.db.pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
        `inventory:${SOURCE}`,
      ]);
      expect(await run(SOURCE)).toMatchObject({ skipped: 'already-running' });
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
    }
  });
});
