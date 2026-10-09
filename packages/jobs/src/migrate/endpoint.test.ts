import { diffDocuments } from '@git-migrator/core';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { createBuiltinRegistry } from '@git-migrator/registry';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { liveGroupRows } from '../analysis/analysis.ts';
import { seedBasics } from '../world.fixture.ts';
import { createdTeamSlugs, type EndpointWorld, settleTeams } from './endpoint.ts';
import { ledgerSafe } from './facets.ts';
import type { MigrationContext } from './services.ts';

vi.setConfig({ testTimeout: 30_000 });

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t086u_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
}, 60_000);

let counter = 0;

/** A Route with source groups, and a Run whose ledger can hold team records. */
async function seed(slugs: readonly string[]) {
  const db = t.db.privileged;
  const world = await seedBasics(db);
  const n = ++counter;
  const run = await db.run.create({
    data: {
      migrationId: world.migrationId,
      kind: 'migrate',
      triggeredById: world.actorId,
      options: {},
      status: 'running',
    },
  });
  const groups = [];
  for (const slug of slugs) {
    const g = await db.group.create({
      data: {
        endpointId: world.sourceEndpointId,
        providerId: `${slug}-${n}`,
        slug,
        name: slug,
        memberIds: [],
      },
    });
    const mapping = await db.groupMapping.create({
      data: { routeId: world.routeId, sourceGroupId: g.id, plannedSlug: slug, status: 'unmapped' },
    });
    groups.push(mapping);
  }
  const record = (
    action: string,
    resourceRef: Record<string, string>,
    before: object | null,
    after: object,
    paths: string[] = [],
  ) =>
    db.mutation.create({
      data: {
        migration: { connect: { id: world.migrationId } },
        run: { connect: { id: run.id } },
        side: 'target',
        facetKey: 'teams',
        action,
        resourceRef,
        paths,
        ...(before ? { before: before as never } : {}),
        after: after as never,
        state: 'recorded',
      },
    });
  return { db, world, groups, record };
}

function contextOf(
  db: MigrationContextDb,
  tasks: Record<string, unknown>[],
  logs: unknown[][] = [],
  assertLease: () => Promise<void> = async () => undefined,
) {
  return {
    services: { db, pool: undefined },
    run: { id: 'run-1' },
    signal: new AbortController().signal,
    checkpoint: () => undefined,
    assertLease,
    runLog: async (...args: unknown[]) => void logs.push(args),
    findings: { addTask: async (f: Record<string, unknown>) => void tasks.push(f) },
  } as unknown as MigrationContext;
}
type MigrationContextDb = TestDatabase['db']['privileged'];

const targetOf = (teams: { id: string; slug: string }[]) =>
  ({
    connection: {
      inventory: {
        listGroups: async () => ({
          items: teams.map((x) => ({
            providerId: x.id,
            slug: x.slug,
            name: x.slug,
            memberProviderIds: [],
          })),
        }),
      },
    },
  }) as never;

const endpointWorld = (w: { routeId: string; targetEndpointId: string; migrationId: string }) =>
  ({
    migrationId: w.migrationId,
    routeId: w.routeId,
    targetEndpointId: w.targetEndpointId,
  }) as unknown as EndpointWorld;

describe('settling created teams (LIF-080, AUTH-050)', () => {
  it('[LIF-080] a recovered write counts a team it added, not a member-only change to a team that was there (paths from diffDocuments)', async () => {
    const def = createBuiltinRegistry().facets.get('teams');
    const schema = { collections: def.collections, sets: def.sets ?? [] };
    const member = (id: string) => ({ principal: { kind: 'identity', id }, role: 'member' });
    const team = (slug: string, members: ReturnType<typeof member>[]) => ({
      slug,
      name: slug,
      members,
    });
    const before = { teams: [team('dev', []), team('old', [])] };
    const after = {
      teams: [team('dev', [member('5')]), team('old', []), team('new', [member('6')])],
    };
    const paths = diffDocuments(after, before, schema).map((d) => d.path);
    expect(paths.some((p) => p.startsWith('/teams[slug=dev]/members'))).toBe(true);
    const { db, world, record } = await seed([]);
    await record(
      'update',
      { kind: 'recovered-write', umbrella: 'facet-apply' },
      before,
      after,
      paths,
    );
    expect([...(await createdTeamSlugs(db, world.migrationId))]).toEqual(['new']);
  });

  it('[LIF-080] a team the ledger does not show as created is not confirmed', async () => {
    const { db, world, groups } = await seed(['devs']);
    const tasks: Record<string, unknown>[] = [];
    const n = await settleTeams(
      contextOf(db, tasks),
      endpointWorld(world),
      targetOf([{ id: '9', slug: 'devs' }]),
    );
    expect(n).toBe(0);
    const row = await db.groupMapping.findUniqueOrThrow({ where: { id: groups[0]?.id as string } });
    expect(row.status).toBe('unmapped');
  });

  it('[LIF-080] a created team confirms its mapping, and a mapping an operator excluded meanwhile stays', async () => {
    const { db, world, groups, record } = await seed(['devs', 'ops']);
    await record('create', { kind: 'team', slug: 'devs' }, null, { slug: 'devs' });
    await record('create', { kind: 'team', slug: 'ops' }, null, { slug: 'ops' });
    await db.groupMapping.update({
      where: { id: groups[1]?.id as string },
      data: { status: 'excluded' },
    });
    const n = await settleTeams(
      contextOf(db, []),
      endpointWorld(world),
      targetOf([
        { id: '1', slug: 'devs' },
        { id: '2', slug: 'ops' },
      ]),
    );
    expect(n).toBe(1);
    const devs = await db.groupMapping.findUniqueOrThrow({
      where: { id: groups[0]?.id as string },
    });
    const ops = await db.groupMapping.findUniqueOrThrow({ where: { id: groups[1]?.id as string } });
    expect(devs.status).toBe('confirmed');
    expect(devs.targetGroupId).not.toBeNull();
    expect(ops.status).toBe('excluded');
  });

  it('[LIF-080] two mappings that plan one slug are not confirmed to one team, and a task asks for a decision', async () => {
    const { db, world, groups, record } = await seed(['a']);
    // A second source group planned for the same slug.
    const other = await db.group.create({
      data: {
        endpointId: world.sourceEndpointId,
        providerId: 'a2',
        slug: 'a2',
        name: 'a2',
        memberIds: [],
      },
    });
    await db.groupMapping.create({
      data: {
        routeId: world.routeId,
        sourceGroupId: other.id,
        plannedSlug: 'a',
        status: 'unmapped',
      },
    });
    await record('create', { kind: 'team', slug: 'a' }, null, { slug: 'a' });
    const tasks: Record<string, unknown>[] = [];
    const n = await settleTeams(
      contextOf(db, tasks),
      endpointWorld(world),
      targetOf([{ id: '5', slug: 'a' }]),
    );
    expect(n).toBe(0);
    expect(
      await db.manualTask.findMany({ where: { migrationId: world.migrationId } }),
    ).toMatchObject([
      { code: 'teams.unmapped-principal', phase: 'pre', params: { principal: 'group:a' } },
    ]);
    const row = await db.groupMapping.findUniqueOrThrow({ where: { id: groups[0]?.id as string } });
    expect(row.status).toBe('unmapped');
  });

  it('[LIF-080] a confirmed mapping whose team is gone is pointed at the re-created team', async () => {
    const { db, world, groups, record } = await seed(['devs']);
    const old = await db.group.create({
      data: {
        endpointId: world.targetEndpointId,
        providerId: 'old-id',
        slug: 'devs-old',
        name: 'devs-old',
        memberIds: [],
      },
    });
    await db.groupMapping.update({
      where: { id: groups[0]?.id as string },
      data: { status: 'confirmed', targetGroupId: old.id },
    });
    await record('create', { kind: 'team', slug: 'devs' }, null, { slug: 'devs' });
    const n = await settleTeams(
      contextOf(db, []),
      endpointWorld(world),
      targetOf([{ id: '7', slug: 'devs' }]),
    );
    expect(n).toBe(1);
    const row = await db.groupMapping.findUniqueOrThrow({
      where: { id: groups[0]?.id as string },
      include: { targetGroup: true },
    });
    expect(row.targetGroup?.providerId).toBe('7');
  });

  it('[LIF-080] a team renamed on the target keeps its mapping and carries the live slug, a deleted team makes the mapping unmapped', async () => {
    const { db, world, groups, record } = await seed(['devs']);
    const old = await db.group.create({
      data: {
        endpointId: world.targetEndpointId,
        providerId: 'renamed-1',
        slug: 'devs-old',
        name: 'devs-old',
        memberIds: [],
      },
    });
    await db.groupMapping.update({
      where: { id: groups[0]?.id as string },
      data: { status: 'confirmed', targetGroupId: old.id },
    });
    await record('create', { kind: 'team', slug: 'devs' }, null, { slug: 'devs' });
    // The provider lists the same id under a new slug, and a created team `devs` with another id.
    const n = await settleTeams(
      contextOf(db, []),
      endpointWorld(world),
      targetOf([
        { id: 'renamed-1', slug: 'devs-new' },
        { id: '77', slug: 'devs' },
      ]),
    );
    expect(n).toBe(0);
    const row = await db.groupMapping.findUniqueOrThrow({
      where: { id: groups[0]?.id as string },
      include: { targetGroup: true },
    });
    expect(row.targetGroup?.providerId).toBe('renamed-1');
    expect(row.targetGroup?.slug).toBe('devs-new');
    expect(await db.auditEvent.count({ where: { subjectId: row.id } })).toBe(0);
    expect(await db.manualTask.count({ where: { migrationId: world.migrationId } })).toBe(0);
  });

  it('[LIF-080] [AUTH-050] a confirmed mapping repointed after its team was deleted leaves an audit event and a Run warning naming both teams, and no task', async () => {
    const { db, world, groups, record } = await seed(['devs']);
    const old = await db.group.create({
      data: {
        endpointId: world.targetEndpointId,
        providerId: 'gone-1',
        slug: 'devs-old',
        name: 'devs-old',
        memberIds: [],
      },
    });
    const id = groups[0]?.id as string;
    await db.groupMapping.update({
      where: { id },
      data: { status: 'confirmed', targetGroupId: old.id },
    });
    await record('create', { kind: 'team', slug: 'devs' }, null, { slug: 'devs' });
    const logs: unknown[][] = [];
    const n = await settleTeams(
      contextOf(db, [], logs),
      endpointWorld(world),
      targetOf([{ id: '7', slug: 'devs' }]),
    );
    expect(n).toBe(1);
    const row = await db.groupMapping.findUniqueOrThrow({
      where: { id },
      include: { targetGroup: true },
    });
    expect(row.targetGroup?.providerId).toBe('7');
    const audit = await db.auditEvent.findMany({ where: { subjectId: id } });
    expect(audit).toMatchObject([
      {
        action: 'group-mapping.confirm',
        actorId: null,
        data: { origin: 'run', repointedFrom: 'devs-old', repointedTo: 'devs' },
      },
    ]);
    expect(await db.manualTask.count({ where: { migrationId: world.migrationId } })).toBe(0);
    expect(logs.filter((l) => l[0] === 'warn')).toMatchObject([
      ['warn', expect.stringContaining('devs-old'), { from: 'devs-old', to: 'devs' }],
    ]);
  });

  it('[LIF-080] [LIF-046] a worker that lost the lease writes nothing', async () => {
    const { db, world, groups, record } = await seed(['devs']);
    await record('create', { kind: 'team', slug: 'devs' }, null, { slug: 'devs' });
    const lost = async () => {
      throw new Error('Run lease lost');
    };
    await expect(
      settleTeams(
        contextOf(db, [], [], lost),
        endpointWorld(world),
        targetOf([{ id: '9', slug: 'devs' }]),
      ),
    ).rejects.toThrow('lease lost');
    const row = await db.groupMapping.findUniqueOrThrow({ where: { id: groups[0]?.id as string } });
    expect(row.status).toBe('unmapped');
    expect(await db.group.count({ where: { endpointId: world.targetEndpointId } })).toBe(0);
  });

  it('[LIF-080] [FAC-ACL-004] liveGroupRows tells a renamed team from a deleted one by provider id', () => {
    const rows = [
      { status: 'confirmed', sourceProviderId: 'a', targetProviderId: '1', targetSlug: 'old' },
      { status: 'confirmed', sourceProviderId: 'b', targetProviderId: '2', targetSlug: 'here' },
      { status: 'suggested', sourceProviderId: 'c', targetProviderId: null, targetSlug: null },
    ];
    const live = new Map([['1', 'renamed']]);
    expect(liveGroupRows(rows, live)).toEqual([
      { status: 'confirmed', sourceProviderId: 'a', targetProviderId: '1', targetSlug: 'renamed' },
      { status: 'unmapped', sourceProviderId: 'b', targetProviderId: '2', targetSlug: 'here' },
      rows[2],
    ]);
    expect(liveGroupRows(rows, null)).toEqual(rows);
  });
});

describe('the ledger holds no webhook credentials (FAC-WEB-002)', () => {
  it('[FAC-WEB-002] only hooks[].url is reduced to its origin, the hook key stays so recovery can tell hooks apart, other Facets are untouched', () => {
    const doc = {
      hooks: [
        {
          key: 'https://hooks.example#aaaa1111aaaa1111',
          url: 'https://user:pw@hooks.example/path/abcdef?token=s3cr3t',
        },
        {
          key: 'https://hooks.example#bbbb2222bbbb2222',
          url: 'https://hooks.example/ghp_secrettoken',
        },
      ],
    };
    for (const facet of ['webhooks', 'org-webhooks']) {
      const safe = ledgerSafe(facet, doc) as { hooks: { key: string; url: string }[] };
      expect(safe.hooks.map((h) => h.key)).toEqual(doc.hooks.map((h) => h.key));
      const text = JSON.stringify(safe);
      expect(text).not.toMatch(/s3cr3t|pw@|abcdef|ghp_|token=/);
      expect(text).toContain('hooks.example');
    }
    expect(ledgerSafe('variables', { variables: [] })).toEqual({ variables: [] });
  });
});
