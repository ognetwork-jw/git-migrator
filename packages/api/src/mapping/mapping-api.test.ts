import type { AuthService } from '@git-migrator/auth';
import { issueApiKey } from '@git-migrator/auth';
import { EVENT_CHANNEL } from '@git-migrator/core';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiApp, isTimeout } from '../app.ts';
import { createEventHub } from '../events.ts';
import { MAX_CSV_ROWS } from './csv.ts';
import { MAPPING_TIMEOUTS } from './service.ts';

const ORIGIN = 'http://localhost:3000';
const inertEvents = () =>
  createEventHub({
    listener: { start: () => undefined, subscribe: () => () => undefined, connected: false },
  });

let t: TestDatabase;
let app: ReturnType<typeof createApiApp>;
const keys = {} as Record<'viewer' | 'operator' | 'admin', string>;
let operatorId = '';

/** Seeded ids by name. */
const ids = {} as Record<string, string>;

beforeAll(async () => {
  t = await createTestDatabase('gm_t084_');
  // Only API keys are used, so Better Auth is not needed.
  app = createApiApp({
    events: inertEvents(),
    db: t.db,
    auth: {} as AuthService,
    publicUrl: ORIGIN,
  });
  const admin = await t.db.privileged.actor.create({
    data: { kind: 'human', displayName: 'Admin', role: 'admin' },
  });
  for (const role of ['viewer', 'operator', 'admin'] as const) {
    const actor = await t.db.privileged.actor.create({
      data: { kind: 'service', displayName: `svc-${role}`, role },
    });
    if (role === 'operator') operatorId = actor.id;
    keys[role] = (
      await issueApiKey(t.db.privileged, { actorId: actor.id, name: role, issuedBy: admin.id })
    ).key;
  }
}, 120_000);

afterAll(async () => {
  await t?.drop();
});

const call = (
  path: string,
  init: {
    method?: string;
    role?: keyof typeof keys;
    body?: unknown;
    csv?: string;
    type?: string;
  } = {},
) => {
  const headers: Record<string, string> = {
    authorization: `Bearer ${keys[init.role ?? 'operator']}`,
  };
  let body: string | undefined;
  if (init.csv !== undefined) {
    headers['content-type'] = init.type ?? 'text/csv';
    body = init.csv;
  } else if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  return app.request(`${ORIGIN}${path}`, { method: init.method ?? 'GET', headers, body });
};

const post = (path: string, body?: unknown, role: keyof typeof keys = 'operator') =>
  call(path, { method: 'POST', role, ...(body === undefined ? {} : { body }) });

const ROUTE = 'r84';
const base = `/api/v1/routes/${ROUTE}`;

/**
 * One Route with: source users alice (suggested -> bob-gh), bob (unmapped), carol (unmapped),
 * dave (confirmed -> dave-gh); target users alice-gh, bob-gh, dave-gh; Migrations with Analyses in
 * the three staleness states; two source groups and two target teams.
 */
async function seed() {
  const db = t.db.privileged;
  await db.auditEvent.deleteMany({
    where: { subjectType: { in: ['identity_mapping', 'group_mapping'] } },
  });
  await db.expectedDifference.deleteMany({});
  await db.identityMapping.deleteMany({});
  await db.groupMapping.deleteMany({});
  await db.migration.updateMany({ data: { latestAnalysisId: null } });
  await db.analysis.deleteMany({});
  await db.migration.deleteMany({});
  await db.repository.deleteMany({});
  await db.namespace.deleteMany({});
  await db.identity.deleteMany({});
  await db.group.deleteMany({});
  await db.route.deleteMany({});
  await db.endpoint.deleteMany({});
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
  await endpoint('src84');
  await endpoint('dst84');
  await endpoint('other84');
  await db.route.create({
    data: {
      id: ROUTE,
      sourceEndpointId: 'src84',
      targetEndpointId: 'dst84',
      targetNamespacePath: 'acme',
      policies: {},
      defaults: {},
      configHash: 'h',
      sourcePostAction: 'read-only',
    },
  });
  const identity = async (
    name: string,
    endpointId: string,
    extra: { email?: string; emailSource?: string } = {},
  ) => {
    const row = await db.identity.create({
      data: {
        endpointId,
        providerId: `{${name}}`,
        login: name,
        displayName: name,
        kind: 'user',
        isMember: true,
        ...extra,
      },
    });
    ids[name] = row.id;
    return row;
  };
  await identity('alice', 'src84');
  await identity('bob', 'src84', { email: 'bob@old.test', emailSource: 'atlassian-admin' });
  await identity('carol', 'src84');
  await identity('dave', 'src84');
  await identity('-minus', 'src84');
  await identity('alice-gh', 'dst84', { email: 'alice@example.test' });
  await identity('bob-gh', 'dst84');
  await identity('dave-gh', 'dst84');
  await identity('stranger', 'other84');
  const mapping = async (
    name: string,
    status: 'suggested' | 'confirmed' | 'unmapped',
    target?: string,
  ) => {
    const row = await db.identityMapping.create({
      data: {
        routeId: ROUTE,
        sourceIdentityId: ids[name] as string,
        status,
        targetIdentityId: target ? (ids[target] as string) : null,
        method: status === 'unmapped' ? null : 'login',
        confidence: status === 'suggested' ? 0.9 : null,
      },
    });
    ids[`m-${name}`] = row.id;
  };
  await mapping('alice', 'suggested', 'alice-gh');
  await mapping('bob', 'unmapped');
  await mapping('carol', 'unmapped');
  await mapping('dave', 'confirmed', 'dave-gh');

  const ns = await db.namespace.create({
    data: { endpointId: 'src84', providerId: 'ns', kind: 'project', slug: 'p', name: 'P' },
  });
  const future = new Date(Date.now() + 86_400_000);
  const past = new Date(Date.now() - 86_400_000);
  for (const [name, stale] of [
    ['fresh', null],
    ['expiring', future],
    ['stale-before', past],
  ] as const) {
    const repo = await db.repository.create({
      data: {
        endpointId: 'src84',
        namespaceId: ns.id,
        providerId: name,
        slug: name,
        name,
        fullPath: `p/${name}`,
        isPrivate: true,
        lastInventoriedAt: new Date(),
      },
    });
    const migration = await db.migration.create({
      data: { scope: 'repository', routeId: ROUTE, sourceRepositoryId: repo.id },
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
    await db.migration.update({
      where: { id: migration.id },
      data: { latestAnalysisId: analysis.id, analysisStaleAt: stale },
    });
    ids[`mig-${name}`] = migration.id;
  }
  // A Migration without an Analysis has nothing to mark.
  const repo = await db.repository.create({
    data: {
      endpointId: 'src84',
      namespaceId: ns.id,
      providerId: 'none',
      slug: 'none',
      name: 'none',
      fullPath: 'p/none',
      isPrivate: true,
      lastInventoriedAt: new Date(),
    },
  });
  ids['mig-none'] = (
    await db.migration.create({
      data: { scope: 'repository', routeId: ROUTE, sourceRepositoryId: repo.id },
    })
  ).id;

  const group = async (endpointId: string, slug: string, members: number) => {
    const row = await db.group.create({
      data: {
        endpointId,
        providerId: `g-${endpointId}-${slug}`,
        slug,
        name: slug.toUpperCase(),
        memberIds: Array.from({ length: members }, (_, i) => `m${i}`),
      },
    });
    ids[`g-${endpointId}-${slug}`] = row.id;
    return row;
  };
  await group('src84', 'devs', 3);
  await group('src84', 'ops', 2);
  await group('dst84', 'devs', 5);
  await group('dst84', 'qa', 1);
  const gmap = async (slug: string, status: 'suggested' | 'unmapped', target?: string) => {
    const row = await db.groupMapping.create({
      data: {
        routeId: ROUTE,
        sourceGroupId: ids[`g-src84-${slug}`] as string,
        targetGroupId: target ? (ids[target] as string) : null,
        plannedSlug: slug,
        status,
      },
    });
    ids[`gm-${slug}`] = row.id;
  };
  await gmap('devs', 'suggested', 'g-dst84-devs');
  await gmap('ops', 'unmapped');
}

beforeEach(seed);

const stateOf = async () => {
  const rows = await t.db.privileged.migration.findMany({
    where: { routeId: ROUTE },
    select: { id: true, analysisStaleAt: true, staleGeneration: true },
  });
  return new Map(rows.map((r) => [r.id, r.analysisStaleAt]));
};

const generationOf = async (name: string): Promise<number> => {
  const row = await t.db.privileged.migration.findUniqueOrThrow({
    where: { id: ids[`mig-${name}`] as string },
    select: { staleGeneration: true },
  });
  return Number(row.staleGeneration);
};

const mappingOf = (name: string) =>
  t.db.privileged.identityMapping.findUniqueOrThrow({ where: { id: ids[`m-${name}`] as string } });

const activeEds = () =>
  t.db.privileged.expectedDifference.findMany({
    where: { routeId: ROUTE, reason: 'identity_excluded', revokedAt: null },
    orderBy: [{ facetKey: 'asc' }, { path: 'asc' }],
  });

async function expectAllAnalysesStale(before: Date) {
  const state = await stateOf();
  // Fresh, expiring (a future value is an expiry, not a mark) and already stale.
  expect((state.get(ids['mig-fresh'] as string) as Date).getTime()).toBeGreaterThanOrEqual(
    before.getTime(),
  );
  expect((state.get(ids['mig-expiring'] as string) as Date).getTime()).toBeLessThanOrEqual(
    Date.now(),
  );
  expect((state.get(ids['mig-expiring'] as string) as Date).getTime()).toBeGreaterThanOrEqual(
    before.getTime(),
  );
  // Already stale keeps its earlier mark.
  expect((state.get(ids['mig-stale-before'] as string) as Date).getTime()).toBeLessThan(
    before.getTime(),
  );
  // The generation of every Migration of the Route moves by one, also the never analyzed one and
  // the one that was stale already (shared markAnalysesStale, ADR-0310).
  for (const name of ['fresh', 'expiring', 'stale-before', 'none']) {
    expect(await generationOf(name), name).toBe(1);
  }
  expect(state.get(ids['mig-none'] as string)).toBeNull();
}

async function expectNothingMarked() {
  const state = await stateOf();
  expect(state.get(ids['mig-fresh'] as string)).toBeNull();
  expect((state.get(ids['mig-expiring'] as string) as Date).getTime()).toBeGreaterThan(Date.now());
  for (const name of ['fresh', 'expiring', 'stale-before', 'none']) {
    expect(await generationOf(name), name).toBe(0);
  }
}

describe('[API-020] [AUTH-050] reading mappings', () => {
  it('[API-020] lists Routes, Identity Mappings with source and target, and filters by status and text', async () => {
    const routes = await call('/api/v1/routes', { role: 'viewer' });
    expect(routes.status).toBe(200);
    expect(((await routes.json()) as { items: { id: string }[] }).items.map((r) => r.id)).toEqual([
      ROUTE,
    ]);

    const res = await call(`${base}/identity-mappings`, { role: 'viewer' });
    expect(res.status).toBe(200);
    const page = (await res.json()) as {
      items: { status: string; source: { login: string }; target: { login: string } | null }[];
      nextCursor: string | null;
    };
    expect(page.items).toHaveLength(4);
    expect(page.nextCursor).toBeNull();
    const alice = page.items.find((m) => m.source.login === 'alice');
    expect(alice).toMatchObject({ status: 'suggested', target: { login: 'alice-gh' } });

    const suggested = await call(`${base}/identity-mappings?status=suggested`, { role: 'viewer' });
    expect(((await suggested.json()) as { items: unknown[] }).items).toHaveLength(1);
    const search = await call(`${base}/identity-mappings?q=CAROL`, { role: 'viewer' });
    expect(((await search.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it('[API-020] pages with a cursor', async () => {
    const first = await call(`${base}/identity-mappings?limit=3`, { role: 'viewer' });
    const page1 = (await first.json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(page1.items).toHaveLength(3);
    expect(page1.nextCursor).toBe(page1.items[2]?.id);
    const second = await call(
      `${base}/identity-mappings?limit=3&cursor=${page1.nextCursor as string}`,
      { role: 'viewer' },
    );
    const page2 = (await second.json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
  });

  it('[API-020] lists target Identities for choosing a target, filtered by text', async () => {
    const all = await call(`${base}/target-identities`, { role: 'viewer' });
    const items = ((await all.json()) as { items: { login: string }[] }).items;
    expect(items.map((i) => i.login)).toEqual(['alice-gh', 'bob-gh', 'dave-gh']);
    const some = await call(`${base}/target-identities?q=BOB&limit=1`, { role: 'viewer' });
    expect(
      ((await some.json()) as { items: { login: string }[] }).items.map((i) => i.login),
    ).toEqual(['bob-gh']);
  });

  it('[API-020] an unknown Route is a 404', async () => {
    expect((await call('/api/v1/routes/nope/identity-mappings', { role: 'viewer' })).status).toBe(
      404,
    );
    expect((await call('/api/v1/routes/nope/group-mappings', { role: 'viewer' })).status).toBe(404);
    expect((await call('/api/v1/routes/nope/target-identities', { role: 'viewer' })).status).toBe(
      404,
    );
  });
});

describe('[API-021] [AUTH-020] roles', () => {
  it('[API-021] every mapping write is 403 for a viewer and changes nothing', async () => {
    const m = ids['m-alice'];
    const cases: [string, unknown][] = [
      [`${base}/identity-mappings/${m}/confirm`, {}],
      [`${base}/identity-mappings/${m}/exclude`, { reason: 'x' }],
      [`${base}/identity-mappings/${m}/unmap`, {}],
      [`${base}/group-mappings/${ids['gm-devs']}/confirm`, {}],
      [`${base}/group-mappings/${ids['gm-ops']}/rename`, { plannedSlug: 'x' }],
    ];
    for (const [path, body] of cases) {
      expect((await post(path, body, 'viewer')).status, path).toBe(403);
    }
    const csv = await call(`${base}/identity-mappings/import?dryRun=true`, {
      method: 'POST',
      role: 'viewer',
      csv: 'source,target,action\n',
    });
    expect(csv.status).toBe(403);
    expect((await mappingOf('alice')).status).toBe('suggested');
    await expectNothingMarked();
  });

  it('[API-021] an operator and an admin may decide', async () => {
    expect(
      (await post(`${base}/identity-mappings/${ids['m-bob']}/unmap`, {}, 'admin')).status,
    ).toBe(200);
    expect(
      (await post(`${base}/identity-mappings/${ids['m-alice']}/confirm`, {}, 'operator')).status,
    ).toBe(200);
  });

  it('[API-021] without a credential the answer is 401', async () => {
    const res = await app.request(`${ORIGIN}${base}/identity-mappings`);
    expect(res.status).toBe(401);
  });
});

describe('[AUTH-050] confirm', () => {
  it('[AUTH-050] confirming a suggestion keeps its method, records the decision and marks Analyses stale', async () => {
    const before = new Date();
    const res = await post(`${base}/identity-mappings/${ids['m-alice']}/confirm`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'confirmed',
      method: 'login',
      confidence: 0.9,
      decidedBy: 'svc-operator',
      target: { login: 'alice-gh' },
    });
    const row = await mappingOf('alice');
    expect(row.decidedById).toBe(operatorId);
    expect(row.decidedAt).not.toBeNull();
    await expectAllAnalysesStale(before);
  });

  it('[AUTH-050] choosing another target is a manual decision', async () => {
    const res = await post(`${base}/identity-mappings/${ids['m-alice']}/confirm`, {
      targetIdentityId: ids['bob-gh'],
    });
    expect(await res.json()).toMatchObject({
      status: 'confirmed',
      method: 'manual',
      confidence: null,
      target: { login: 'bob-gh' },
    });
  });

  it('[AUTH-050] a mapping without a target needs one; a target of another endpoint is refused', async () => {
    const none = await post(`${base}/identity-mappings/${ids['m-bob']}/confirm`);
    expect(none.status).toBe(422);
    const foreign = await post(`${base}/identity-mappings/${ids['m-bob']}/confirm`, {
      targetIdentityId: ids.stranger,
    });
    expect(foreign.status).toBe(422);
    const source = await post(`${base}/identity-mappings/${ids['m-bob']}/confirm`, {
      targetIdentityId: ids.alice,
    });
    expect(source.status).toBe(422);
    expect((await mappingOf('bob')).status).toBe('unmapped');
    await expectNothingMarked();
  });

  it('[AUTH-050] a target confirmed for another source is a 409', async () => {
    const res = await post(`${base}/identity-mappings/${ids['m-alice']}/confirm`, {
      targetIdentityId: ids['dave-gh'],
    });
    expect(res.status).toBe(409);
    expect((await mappingOf('alice')).status).toBe('suggested');
  });

  it('[AUTH-050] a mapping of another Route is not found', async () => {
    const res = await post(`/api/v1/routes/other/identity-mappings/${ids['m-alice']}/confirm`);
    expect(res.status).toBe(404);
  });
});

describe('[AUTH-050] exclude', () => {
  it('[AUTH-050] an exclusion needs a reason', async () => {
    for (const body of [undefined, {}, { reason: '   ' }, { reason: 'x'.repeat(1001) }]) {
      const res = await post(`${base}/identity-mappings/${ids['m-bob']}/exclude`, body);
      expect(res.status).toBe(422);
    }
    expect((await mappingOf('bob')).status).toBe('unmapped');
    expect(await activeEds()).toHaveLength(0);
    await expectNothingMarked();
  });

  it('[AUTH-050] an exclusion creates Route-scoped identity_excluded Expected Differences and marks Analyses stale', async () => {
    const before = new Date();
    const res = await post(`${base}/identity-mappings/${ids['m-bob']}/exclude`, {
      reason: '  Left the company  ',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'excluded',
      target: null,
      reason: 'Left the company',
      method: 'manual',
    });
    const eds = await activeEds();
    expect(eds.map((e) => [e.facetKey, e.path])).toEqual([
      ['access-control', '/grants[principal=identity:{bob}]'],
      ['branch-rules', '/rules[pattern=*]/deletionExempt[principal=identity:{bob}]'],
      ['branch-rules', '/rules[pattern=*]/forcePushExempt[principal=identity:{bob}]'],
      ['branch-rules', '/rules[pattern=*]/restrictMerges[principal=identity:{bob}]'],
      ['branch-rules', '/rules[pattern=*]/restrictPushes[principal=identity:{bob}]'],
      ['code-ownership', '/owners[pattern=*]/principals[principal=identity:{bob}]'],
      ['members', '/members[principal=identity:{bob}]'],
      ['teams', '/teams[slug=*]/members[principal=identity:{bob}]'],
    ]);
    expect(eds.every((e) => e.migrationId === null && e.createdById === operatorId)).toBe(true);
    expect(eds.every((e) => e.note?.endsWith('Left the company'))).toBe(true);
    await expectAllAnalysesStale(before);

    const list = await call(`${base}/identity-mappings?status=excluded`, { role: 'viewer' });
    expect(((await list.json()) as { items: { reason: string }[] }).items[0]?.reason).toBe(
      'Left the company',
    );
  });

  it('[AUTH-050] excluding a confirmed mapping also covers the former target', async () => {
    await post(`${base}/identity-mappings/${ids['m-dave']}/exclude`, { reason: 'bot' });
    const paths = (await activeEds()).map((e) => e.path);
    expect(paths).toContain('/grants[principal=identity:{dave}]');
    expect(paths).toContain('/grants[principal=identity:{dave-gh}]');
    expect(paths).toHaveLength(16);
    expect((await mappingOf('dave')).targetIdentityId).toBeNull();
  });

  it('[AUTH-050] excluding twice replaces the reason without piling up differences', async () => {
    await post(`${base}/identity-mappings/${ids['m-bob']}/exclude`, { reason: 'first' });
    await post(`${base}/identity-mappings/${ids['m-bob']}/exclude`, { reason: 'second' });
    const eds = await activeEds();
    expect(eds).toHaveLength(8);
    expect(eds.every((e) => e.note?.endsWith('second'))).toBe(true);
    const revoked = await t.db.privileged.expectedDifference.count({
      where: { routeId: ROUTE, revokedAt: { not: null } },
    });
    expect(revoked).toBe(8);
  });

  it('[AUTH-050] confirming or unmapping an excluded mapping revokes its differences', async () => {
    await post(`${base}/identity-mappings/${ids['m-bob']}/exclude`, { reason: 'x' });
    await post(`${base}/identity-mappings/${ids['m-bob']}/confirm`, {
      targetIdentityId: ids['bob-gh'],
    });
    expect(await activeEds()).toHaveLength(0);
    await post(`${base}/identity-mappings/${ids['m-carol']}/exclude`, { reason: 'y' });
    expect(await activeEds()).toHaveLength(8);
    const res = await post(`${base}/identity-mappings/${ids['m-carol']}/unmap`);
    expect(await res.json()).toMatchObject({ status: 'unmapped', reason: null });
    expect(await activeEds()).toHaveLength(0);
  });
});

describe('[AUTH-050] unmap', () => {
  it('[AUTH-050] unmapping removes the decision and marks Analyses stale', async () => {
    const before = new Date();
    const res = await post(`${base}/identity-mappings/${ids['m-dave']}/unmap`);
    expect(await res.json()).toMatchObject({
      status: 'unmapped',
      method: null,
      target: null,
      decidedAt: null,
      decidedBy: null,
    });
    await expectAllAnalysesStale(before);
  });
});

describe('[AUTH-050] CSV import', () => {
  const header = 'source,target,action\n';

  const importCsv = (csv: string, dryRun?: boolean, type?: string) =>
    call(`${base}/identity-mappings/import${dryRun === undefined ? '' : `?dryRun=${dryRun}`}`, {
      method: 'POST',
      csv,
      ...(type ? { type } : {}),
    });

  it('[AUTH-050] a dry run reports every row and writes nothing', async () => {
    const res = await importCsv(
      `${header}alice,alice-gh,map\ncarol,carol@example.test,invite\n{bob},,exclude\nnobody,x,map\n-minus,@evil,map\n`,
      true,
    );
    expect(res.status).toBe(200);
    const report = (await res.json()) as {
      dryRun: boolean;
      ok: boolean;
      summary: Record<string, number>;
      rows: {
        line: number;
        ok: boolean;
        outcome: string | null;
        errors: string[];
        source: string;
        target: string;
      }[];
    };
    expect(report.dryRun).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.summary).toMatchObject({
      total: 5,
      valid: 3,
      invalid: 2,
      mapped: 1,
      invited: 1,
      excluded: 1,
    });
    expect(report.rows.map((r) => [r.line, r.ok, r.outcome])).toEqual([
      [2, true, 'mapped'],
      [3, true, 'invited'],
      [4, true, 'excluded'],
      [5, false, null],
      [6, false, null],
    ]);
    expect(report.rows[3]?.errors).toContain('source_not_found');
    expect(report.rows[4]).toMatchObject({ source: "'-minus", target: "'@evil" });
    expect(report.rows[4]?.errors).toContain('formula_prefix');

    // Nothing changed.
    expect((await mappingOf('alice')).status).toBe('suggested');
    expect((await mappingOf('bob')).status).toBe('unmapped');
    expect(await activeEds()).toHaveLength(0);
    await expectNothingMarked();
    const carol = await t.db.privileged.identity.findUniqueOrThrow({
      where: { id: ids.carol as string },
    });
    expect(carol.email).toBeNull();
  });

  it('[AUTH-050] malformed files and rows are reported, not applied', async () => {
    const wrongHeader = (await (await importCsv('a,b,c\n1,2,3\n', true)).json()) as {
      ok: boolean;
      fileErrors: string[];
    };
    expect(wrongHeader).toMatchObject({ ok: false, fileErrors: ['header_invalid'] });
    const empty = (await (await importCsv('', true)).json()) as { fileErrors: string[] };
    expect(empty.fileErrors).toEqual(['file_empty']);
    const broken = (await (
      await importCsv(`${header}alice,alice-gh\nalice,x,teleport\n,y,map\n"open,z,map`, true)
    ).json()) as { fileErrors: string[]; rows: { errors: string[] }[] };
    expect(broken.fileErrors).toEqual(['unterminated_quote']);
    const rows = (await (
      await importCsv(`${header}alice,alice-gh\nalice,x,teleport\n,y,map\nbob,,exclude\n`, true)
    ).json()) as { rows: { errors: string[] }[] };
    expect(rows.rows.map((r) => r.errors[0])).toEqual([
      'column_count',
      'action_invalid',
      'source_missing',
      undefined,
    ]);
  });

  it('[AUTH-050] apply maps, invites and excludes, creating Expected Differences and marking Analyses stale', async () => {
    const before = new Date();
    const res = await importCsv(
      `${header}alice,alice-gh,map\ncarol,carol@example.test,invite\n{bob},,exclude\n{dave},DAVE-GH,map\n`,
    );
    expect(res.status).toBe(200);
    const report = (await res.json()) as {
      ok: boolean;
      dryRun: boolean;
      summary: Record<string, number>;
    };
    expect(report).toMatchObject({
      ok: true,
      dryRun: false,
      summary: { mapped: 1, invited: 1, excluded: 1, unchanged: 1 },
    });
    expect(await mappingOf('alice')).toMatchObject({
      status: 'confirmed',
      method: 'csv',
      targetIdentityId: ids['alice-gh'],
      decidedById: operatorId,
    });
    expect(await mappingOf('carol')).toMatchObject({ status: 'unmapped', method: 'csv' });
    const carol = await t.db.privileged.identity.findUniqueOrThrow({
      where: { id: ids.carol as string },
    });
    expect(carol).toMatchObject({ email: 'carol@example.test', emailSource: 'csv' });
    expect(await mappingOf('bob')).toMatchObject({ status: 'excluded', method: 'csv' });
    const eds = await activeEds();
    expect(eds).toHaveLength(8);
    expect(eds.every((e) => e.path.includes('{bob}') && e.note?.includes('CSV import'))).toBe(true);
    await expectAllAnalysesStale(before);
    const audits = await t.db.privileged.auditEvent.findMany({
      where: { action: { startsWith: 'identity-mapping.import.' } },
    });
    expect(audits).toHaveLength(3);
  });

  it('[AUTH-050] apply creates a mapping row for an Identity that has none', async () => {
    await t.db.privileged.identityMapping.delete({ where: { id: ids['m-carol'] as string } });
    const before = new Date();
    const res = await importCsv(`${header}carol,bob-gh,map\n`);
    expect(res.status).toBe(200);
    const row = await t.db.privileged.identityMapping.findUniqueOrThrow({
      where: {
        routeId_sourceIdentityId: { routeId: ROUTE, sourceIdentityId: ids.carol as string },
      },
    });
    expect(row).toMatchObject({
      status: 'confirmed',
      method: 'csv',
      targetIdentityId: ids['bob-gh'],
    });
    await expectAllAnalysesStale(before);
  });

  it('[AUTH-050] apply validates in full first: one bad row rejects the whole file', async () => {
    const res = await importCsv(`${header}alice,alice-gh,map\ncarol,,exclude\nnobody,x,map\n`);
    expect(res.status).toBe(422);
    const problem = (await res.json()) as {
      code: string;
      errors: { path: string; message: string }[];
    };
    expect(problem.code).toBe('validation_failed');
    expect(problem.errors).toContainEqual({ path: 'line 4', message: 'source_not_found' });
    expect((await mappingOf('alice')).status).toBe('suggested');
    expect((await mappingOf('carol')).status).toBe('unmapped');
    expect(await activeEds()).toHaveLength(0);
    await expectNothingMarked();
  });

  it('[AUTH-050] two sources for one target is an error', async () => {
    const res = await importCsv(`${header}alice,alice-gh,map\ncarol,alice-gh,map\n`, true);
    const report = (await res.json()) as { rows: { errors: string[] }[] };
    expect(report.rows[1]?.errors).toEqual(['target_taken']);
  });

  it('[AUTH-050] an import with nothing to change does not mark Analyses stale', async () => {
    const res = await importCsv(`${header}dave,dave-gh,map\n`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { summary: { unchanged: number } }).summary.unchanged).toBe(1);
    await expectNothingMarked();
  });

  it('[API-020] the body must be CSV text', async () => {
    const res = await call(`${base}/identity-mappings/import`, {
      method: 'POST',
      body: { csv: 'x' },
    });
    expect(res.status).toBe(415);
    expect((await importCsv(header, true, 'text/plain')).status).toBe(200);
  });

  it('[AUTH-050] a large import applies in one go', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `ghost${i},x,map`).join('\n');
    const res = await importCsv(`${header}${lines}`, true);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { summary: { invalid: number } }).summary.invalid).toBe(300);
  });
});

describe('[AUTH-050] events', () => {
  it('[AUTH-050] a mapping change that marks Analyses stale publishes migration.updated after commit', async () => {
    const listener = await t.db.pool.connect();
    await listener.query(`LISTEN ${EVENT_CHANNEL}`);
    const received: string[] = [];
    listener.on('notification', (n) => {
      if (n.payload) received.push(n.payload);
    });
    try {
      await post(`${base}/identity-mappings/${ids['m-alice']}/confirm`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(received.map((p) => (JSON.parse(p) as { type: string }).type)).toEqual([
        'migration.updated',
      ]);
      // A failed request publishes nothing.
      received.length = 0;
      await post(`${base}/identity-mappings/${ids['m-bob']}/exclude`, {});
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(received).toEqual([]);
    } finally {
      listener.release(true);
    }
  });
});

describe('[AUTH-022] audit', () => {
  it('[AUTH-022] every decision writes an audit event without emails or free text beyond the reason', async () => {
    await post(`${base}/identity-mappings/${ids['m-alice']}/confirm`);
    await post(`${base}/identity-mappings/${ids['m-bob']}/exclude`, { reason: 'gone' });
    await post(`${base}/identity-mappings/${ids['m-dave']}/unmap`);
    const events = await t.db.privileged.auditEvent.findMany({
      where: { subjectType: 'identity_mapping' },
      orderBy: { at: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual([
      'identity-mapping.confirm',
      'identity-mapping.exclude',
      'identity-mapping.unmap',
    ]);
    expect(events.every((e) => e.actorId === operatorId)).toBe(true);
    expect(JSON.stringify(events.map((e) => e.data))).not.toContain('@');
  });
});

describe('[UI-028] [AUTH-050] group mappings', () => {
  type Group = {
    id: string;
    plannedSlug: string;
    status: string;
    collision: boolean;
    sourceGroup: { memberCount: number };
    targetGroup: { slug: string; memberCount: number } | null;
  };
  const list = async () =>
    (
      (await (await call(`${base}/group-mappings`, { role: 'viewer' })).json()) as {
        items: Group[];
      }
    ).items;

  it('[UI-028] lists planned slug, status, member counts and collisions', async () => {
    const items = await list();
    const devs = items.find((g) => g.plannedSlug === 'devs');
    expect(devs).toMatchObject({
      status: 'suggested',
      collision: false,
      sourceGroup: { memberCount: 3 },
      targetGroup: { slug: 'devs', memberCount: 5 },
    });
    expect(items.find((g) => g.plannedSlug === 'ops')).toMatchObject({
      status: 'unmapped',
      targetGroup: null,
    });
  });

  it('[UI-028] a planned slug that an unrelated team holds, or that two mappings plan, collides', async () => {
    const qa = await post(`${base}/group-mappings/${ids['gm-ops']}/rename`, { plannedSlug: 'qa' });
    // The team exists, so the mapping becomes a suggestion for it.
    expect(await qa.json()).toMatchObject({ status: 'suggested', collision: false });
    await t.db.privileged.groupMapping.update({
      where: { id: ids['gm-ops'] as string },
      data: { plannedSlug: 'devs', targetGroupId: null, status: 'unmapped' },
    });
    const items = await list();
    expect(
      items
        .filter((g) => g.collision)
        .map((g) => g.id)
        .sort(),
    ).toEqual([ids['gm-ops'], ids['gm-devs']].sort());
  });

  it('[AUTH-050] confirm ties the mapping to the suggested or chosen team and marks Analyses stale', async () => {
    const before = new Date();
    const res = await post(`${base}/group-mappings/${ids['gm-devs']}/confirm`);
    expect(await res.json()).toMatchObject({ status: 'confirmed', targetGroup: { slug: 'devs' } });
    await expectAllAnalysesStale(before);
    const other = await post(`${base}/group-mappings/${ids['gm-ops']}/confirm`, {
      targetGroupId: ids['g-dst84-devs'],
    });
    expect(other.status).toBe(409);
    expect((await post(`${base}/group-mappings/${ids['gm-ops']}/confirm`)).status).toBe(422);
    const foreign = await post(`${base}/group-mappings/${ids['gm-ops']}/confirm`, {
      targetGroupId: ids['g-src84-devs'],
    });
    expect(foreign.status).toBe(422);
  });

  it('[AUTH-050] rename validates the slug, plans creation when no team has it, and refuses confirmed mappings', async () => {
    const before = new Date();
    const res = await post(`${base}/group-mappings/${ids['gm-ops']}/rename`, {
      plannedSlug: 'site-reliability',
    });
    expect(await res.json()).toMatchObject({
      plannedSlug: 'site-reliability',
      status: 'unmapped',
      targetGroup: null,
    });
    await expectAllAnalysesStale(before);
    for (const bad of ['', 'Has Space', 'UPPER', '-lead', 'trail-', 'a--b', 'x'.repeat(101)]) {
      expect(
        (await post(`${base}/group-mappings/${ids['gm-ops']}/rename`, { plannedSlug: bad })).status,
        bad,
      ).toBe(422);
    }
    await post(`${base}/group-mappings/${ids['gm-devs']}/confirm`);
    expect(
      (await post(`${base}/group-mappings/${ids['gm-devs']}/rename`, { plannedSlug: 'other' }))
        .status,
    ).toBe(409);
  });
});

describe('[AUTH-050] review fixes', () => {
  const header = 'source,target,action\n';
  const importCsv = (csv: string, dryRun?: boolean) =>
    call(`${base}/identity-mappings/import${dryRun === undefined ? '' : `?dryRun=${dryRun}`}`, {
      method: 'POST',
      csv,
    });
  const auditCount = () =>
    t.db.privileged.auditEvent.count({ where: { subjectType: 'identity_mapping' } });

  it('[AUTH-050] CSV invite never overwrites a confirmed or excluded decision', async () => {
    await post(`${base}/identity-mappings/${ids['m-carol']}/exclude`, { reason: 'x' });
    const csv = `${header}dave,dave@example.test,invite\ncarol,carol@example.test,invite\nbob,bob@old.test,invite\n`;
    const dry = (await (await importCsv(csv, true)).json()) as {
      ok: boolean;
      rows: { ok: boolean; errors: string[] }[];
    };
    expect(dry.ok).toBe(false);
    expect(dry.rows.map((r) => r.errors)).toEqual([['already_decided'], ['already_decided'], []]);
    const edsBefore = await activeEds();
    const res = await importCsv(csv);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { errors: { message: string }[] }).errors[0]?.message).toBe(
      'already_decided',
    );
    expect(await mappingOf('dave')).toMatchObject({ status: 'confirmed', method: 'login' });
    expect((await mappingOf('carol')).status).toBe('excluded');
    expect(await activeEds()).toHaveLength(edsBefore.length);
    // After unmapping, the same row is accepted.
    await post(`${base}/identity-mappings/${ids['m-dave']}/unmap`);
    const ok = await importCsv(`${header}dave,dave@example.test,invite\n`);
    expect(ok.status).toBe(200);
    expect(await mappingOf('dave')).toMatchObject({ status: 'unmapped', method: 'csv' });
  });

  it('[AUTH-050] invite is still allowed for suggested and pending_invite mappings', async () => {
    await t.db.privileged.identityMapping.update({
      where: { id: ids['m-bob'] as string },
      data: { status: 'pending_invite' },
    });
    const res = await importCsv(
      `${header}alice,alice2@example.test,invite\nbob,bob@old.test,invite\n`,
    );
    expect(res.status).toBe(200);
    expect((await mappingOf('alice')).status).toBe('unmapped');
    expect((await mappingOf('bob')).status).toBe('pending_invite');
  });

  it('[AUTH-050] the report echoes only a known action', async () => {
    const report = (await (
      await importCsv(`${header}alice,x,=HYPERLINK("http://x")\n`, true)
    ).json()) as { rows: { action: string }[] };
    expect(report.rows[0]?.action).toBe('invalid');
  });

  it('[AUTH-050] exclusion Expected Differences are linked to their mapping, not found by note text', async () => {
    await post(`${base}/identity-mappings/${ids['m-bob']}/exclude`, {
      reason: '[mapping:other] sneaky',
    });
    const eds = await activeEds();
    expect(eds).toHaveLength(8);
    expect(eds.every((e) => e.identityMappingId === ids['m-bob'])).toBe(true);
    expect(eds[0]?.note).toBe('[mapping:other] sneaky');
    await post(`${base}/identity-mappings/${ids['m-bob']}/unmap`);
    expect(await activeEds()).toHaveLength(0);
  });

  it('[AUTH-050] unmapping a pending invitation is a 409 and changes nothing', async () => {
    await t.db.privileged.identityMapping.update({
      where: { id: ids['m-bob'] as string },
      data: { status: 'pending_invite' },
    });
    const res = await post(`${base}/identity-mappings/${ids['m-bob']}/unmap`);
    expect(res.status).toBe(409);
    expect((await mappingOf('bob')).status).toBe('pending_invite');
    await expectNothingMarked();
  });

  it('[AUTH-050] a decision that changes nothing writes no audit event, marks nothing and publishes nothing', async () => {
    await post(`${base}/identity-mappings/${ids['m-dave']}/confirm`);
    await post(`${base}/identity-mappings/${ids['m-bob']}/unmap`);
    expect(await auditCount()).toBe(0);
    await expectNothingMarked();
    await post(`${base}/identity-mappings/${ids['m-carol']}/exclude`, { reason: 'same' });
    expect(await auditCount()).toBe(1);
    // Put staleness back as it was, then repeat the same exclusion.
    await t.db.privileged.migration.updateMany({ data: { staleGeneration: 0n } });
    await t.db.privileged.migration.update({
      where: { id: ids['mig-fresh'] as string },
      data: { analysisStaleAt: null },
    });
    await t.db.privileged.migration.update({
      where: { id: ids['mig-expiring'] as string },
      data: { analysisStaleAt: new Date(Date.now() + 86_400_000) },
    });
    const again = await post(`${base}/identity-mappings/${ids['m-carol']}/exclude`, {
      reason: 'same',
    });
    expect(again.status).toBe(200);
    expect(await auditCount()).toBe(1);
    expect(await activeEds()).toHaveLength(8);
    await expectNothingMarked();
    const group = await post(`${base}/group-mappings/${ids['gm-ops']}/rename`, {
      plannedSlug: 'ops',
    });
    expect(group.status).toBe(200);
    await expectNothingMarked();
  });

  it('[AUTH-050] two applies on one Route run one after the other with a consistent result', async () => {
    const [a, b] = await Promise.all([
      importCsv(`${header}alice,alice-gh,map\n`),
      importCsv(`${header}bob,alice-gh,map\n`),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 422]);
    const holders = await t.db.privileged.identityMapping.findMany({
      where: { routeId: ROUTE, status: 'confirmed', targetIdentityId: ids['alice-gh'] as string },
    });
    expect(holders).toHaveLength(1);
  });

  it('[AUTH-050] confirm and exclude on one mapping end in one consistent state', async () => {
    await Promise.all([
      post(`${base}/identity-mappings/${ids['m-alice']}/confirm`),
      post(`${base}/identity-mappings/${ids['m-alice']}/exclude`, { reason: 'race' }),
    ]);
    const row = await mappingOf('alice');
    const eds = await activeEds();
    // Excluded means exactly the Expected Differences of the source and of the target it had when
    // the exclusion ran (16); confirmed means the exclusion was revoked or never happened (0).
    if (row.status === 'excluded') expect(eds).toHaveLength(16);
    else {
      expect(row.status).toBe('confirmed');
      expect(eds).toHaveLength(0);
    }
  });

  it('[AUTH-050] a failure in the middle of an apply rolls everything back and publishes nothing', async () => {
    const listener = await t.db.pool.connect();
    await listener.query(`LISTEN ${EVENT_CHANNEL}`);
    const received: string[] = [];
    listener.on('notification', (n) => {
      if (n.payload) received.push(n.payload);
    });
    // Breaks the write of the audit rows, the last step before marking and publishing.
    await t.db.privileged.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION app.fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit down'; END $$`,
    );
    await t.db.privileged.$executeRawUnsafe(
      `CREATE TRIGGER fail_audit BEFORE INSERT ON app.audit_event FOR EACH ROW EXECUTE FUNCTION app.fail_audit()`,
    );
    try {
      const res = await importCsv(`${header}alice,alice-gh,map\ncarol,,exclude\n`);
      expect(res.status).toBe(500);
      expect((await mappingOf('alice')).status).toBe('suggested');
      expect((await mappingOf('carol')).status).toBe('unmapped');
      expect(await activeEds()).toHaveLength(0);
      await expectNothingMarked();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(received).toEqual([]);
    } finally {
      await t.db.privileged.$executeRawUnsafe(`DROP TRIGGER fail_audit ON app.audit_event`);
      listener.release(true);
    }
  });

  it('[AUTH-050] a large import is applied in batches', async () => {
    const db = t.db.privileged;
    const many = Array.from({ length: 400 }, (_, i) => ({
      endpointId: 'src84',
      providerId: `bulk${i}`,
      login: `bulk${i}`,
      kind: 'user',
      isMember: true,
    }));
    await db.identity.createMany({ data: many });
    const csv = `${header}${many.map((m) => `${m.login},,exclude`).join('\n')}\n`;
    const res = await importCsv(csv);
    expect(res.status).toBe(200);
    expect(await db.identityMapping.count({ where: { routeId: ROUTE, status: 'excluded' } })).toBe(
      400,
    );
    expect(await activeEds()).toHaveLength(400 * 8);
  });
});

describe('[AUTH-050] limits, timeouts and replaced decisions', () => {
  const header = 'source,target,action\n';
  const importCsv = (csv: string, dryRun?: boolean) =>
    call(`${base}/identity-mappings/import${dryRun === undefined ? '' : `?dryRun=${dryRun}`}`, {
      method: 'POST',
      csv,
    });
  const bulkIdentities = (count: number, prefix: string) =>
    Array.from({ length: count }, (_, i) => ({
      endpointId: 'src84',
      providerId: `${prefix}${i}`,
      login: `${prefix}${i}`,
      kind: 'user',
      isMember: true,
    }));

  it('[AUTH-050] an import of the largest size (5,000 exclusions, 40,000 Expected Differences) is applied', async () => {
    const db = t.db.privileged;
    const many = bulkIdentities(MAX_CSV_ROWS, 'big');
    await db.identity.createMany({ data: many });
    const res = await importCsv(`${header}${many.map((m) => `${m.login},,exclude`).join('\n')}\n`);
    expect(res.status).toBe(200);
    expect(await db.identityMapping.count({ where: { routeId: ROUTE, status: 'excluded' } })).toBe(
      MAX_CSV_ROWS,
    );
    expect(await activeEds()).toHaveLength(MAX_CSV_ROWS * 8);
    expect(
      await db.auditEvent.count({ where: { action: 'identity-mapping.import.exclude' } }),
    ).toBe(MAX_CSV_ROWS);
  }, 120_000);

  it('[AUTH-050] 5,000 existing mappings are updated in batches', async () => {
    const db = t.db.privileged;
    const many = bulkIdentities(MAX_CSV_ROWS, 'old');
    await db.identity.createMany({ data: many });
    const created = await db.identity.findMany({
      where: { endpointId: 'src84', login: { startsWith: 'old' } },
      select: { id: true },
    });
    await db.identityMapping.createMany({
      data: created.map((i) => ({ routeId: ROUTE, sourceIdentityId: i.id, status: 'unmapped' })),
    });
    const res = await importCsv(`${header}${many.map((m) => `${m.login},,exclude`).join('\n')}\n`);
    expect(res.status).toBe(200);
    expect(
      await db.identityMapping.count({
        where: { routeId: ROUTE, status: 'excluded', method: 'csv', decidedById: operatorId },
      }),
    ).toBe(MAX_CSV_ROWS);
    expect(await activeEds()).toHaveLength(MAX_CSV_ROWS * 8);
  }, 120_000);

  it('[AUTH-050] emails of invitations are written in batches', async () => {
    const db = t.db.privileged;
    const many = bulkIdentities(300, 'inv');
    await db.identity.createMany({ data: many });
    const res = await importCsv(
      `${header}${many.map((m) => `${m.login},${m.login}@example.test,invite`).join('\n')}\n`,
    );
    expect(res.status).toBe(200);
    const row = await db.identity.findFirstOrThrow({ where: { login: 'inv7' } });
    expect(row).toMatchObject({ email: 'inv7@example.test', emailSource: 'csv' });
  });

  it('[AUTH-050] a writer waiting longer than the lock timeout gets 503 busy with Retry-After', async () => {
    const holder = await t.db.pool.connect();
    const saved = { ...MAPPING_TIMEOUTS };
    MAPPING_TIMEOUTS.lockMs = 300;
    try {
      await holder.query('BEGIN');
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtext('identity-mapping:' || $1)::bigint)",
        [ROUTE],
      );
      const res = await post(`${base}/identity-mappings/${ids['m-alice']}/confirm`);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('5');
      expect(((await res.json()) as { code: string }).code).toBe('busy');
      expect((await mappingOf('alice')).status).toBe('suggested');
    } finally {
      Object.assign(MAPPING_TIMEOUTS, saved);
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('[AUTH-050] a statement timeout is also 503 busy', () => {
    expect(isTimeout({ cause: { code: '57014' } })).toBe(true);
    expect(isTimeout({ dbErrorCode: '55P03' })).toBe(true);
    expect(isTimeout(new Error('x'))).toBe(false);
  });

  it('[AUTH-050] CSV map and exclude may replace an earlier decision, and the dry run says so', async () => {
    await post(`${base}/identity-mappings/${ids['m-carol']}/exclude`, { reason: 'x' });
    const csv = `${header}dave,bob-gh,map\ncarol,,exclude\nbob,,exclude\n`;
    const dry = (await (await importCsv(csv, true)).json()) as {
      ok: boolean;
      summary: { replaced: number; excluded: number; mapped: number };
      rows: { outcome: string }[];
    };
    // dave: confirmed -> another target; carol: already excluded, same state; bob: new decision.
    expect(dry.ok).toBe(true);
    expect(dry.rows.map((r) => r.outcome)).toEqual(['replaces_decision', 'unchanged', 'excluded']);
    expect(dry.summary).toMatchObject({ replaced: 1, excluded: 1, mapped: 0 });
    expect(await mappingOf('dave')).toMatchObject({ status: 'confirmed', method: 'login' });
    const res = await importCsv(csv);
    expect(res.status).toBe(200);
    expect(await mappingOf('dave')).toMatchObject({
      status: 'confirmed',
      method: 'csv',
      targetIdentityId: ids['bob-gh'],
    });
    // The other direction: a confirmed mapping excluded by CSV replaces the decision and its target.
    const res2 = await importCsv(`${header}dave,,exclude\n`, true);
    const dry2 = (await res2.json()) as { rows: { outcome: string }[] };
    expect(dry2.rows[0]?.outcome).toBe('replaces_decision');
    await importCsv(`${header}dave,,exclude\n`);
    expect(await mappingOf('dave')).toMatchObject({ status: 'excluded', targetIdentityId: null });
    const audits = await t.db.privileged.auditEvent.findMany({
      where: { subjectId: ids['m-dave'] as string },
    });
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['identity-mapping.import.map', 'identity-mapping.import.exclude']),
    );
  });
});
