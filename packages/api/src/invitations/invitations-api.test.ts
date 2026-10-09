import type { AuthService } from '@git-migrator/auth';
import { issueApiKey } from '@git-migrator/auth';
import { EVENT_CHANNEL } from '@git-migrator/core';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiApp } from '../app.ts';
import { createEventHub } from '../events.ts';
import type { ApiServices } from '../services.ts';
import { asConflict, selectionToken } from './service.ts';

const ORIGIN = 'http://localhost:3000';
const ROUTE = 'r85';
const base = `/api/v1/routes/${ROUTE}`;

let t: TestDatabase;
let app: ReturnType<typeof createApiApp>;
const keys = {} as Record<'viewer' | 'operator' | 'admin', string>;
const ids = {} as Record<string, string>;
const steps: unknown[] = [];
let queueDown = false;

const services: Partial<ApiServices> = {
  jobs: {
    enqueueInvitationStep: (step: unknown) => {
      if (queueDown) return Promise.reject(new Error('queue down: secret-detail'));
      steps.push(step);
      return Promise.resolve({} as never);
    },
  } as unknown as ApiServices['jobs'],
};

beforeAll(async () => {
  t = await createTestDatabase('gm_t085a_');
  app = createApiApp({
    events: createEventHub({
      listener: { start: () => undefined, subscribe: () => () => undefined, connected: false },
    }),
    db: t.db,
    auth: {} as AuthService,
    publicUrl: ORIGIN,
    services,
  });
  const admin = await t.db.privileged.actor.create({
    data: { kind: 'human', displayName: 'Admin', role: 'admin' },
  });
  for (const role of ['viewer', 'operator', 'admin'] as const) {
    const actor = await t.db.privileged.actor.create({
      data: { kind: 'service', displayName: `svc-${role}`, role },
    });
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
  init: { method?: string; role?: keyof typeof keys; body?: unknown } = {},
) => {
  const headers: Record<string, string> = {
    authorization: `Bearer ${keys[init.role ?? 'operator']}`,
  };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  return app.request(`${ORIGIN}${path}`, { method: init.method ?? 'GET', headers, body });
};
const post = (path: string, body?: unknown, role: keyof typeof keys = 'operator') =>
  call(path, { method: 'POST', role, ...(body === undefined ? {} : { body }) });
const read = async <T>(res: Response): Promise<T> => (await res.json()) as T;

interface Batch {
  id: string;
  status: string;
  counts: Record<string, number>;
  seatPreview: { toInvite: number; seatsTotal: number | null };
  selectionToken: string;
  approvedBy: string | null;
}
interface ItemList {
  batch: Batch;
  items: {
    id: string;
    status: string;
    email: string;
    source: { id: string };
    suggestions: { id: string; login: string | null }[];
    deselectReason: string | null;
    providerIdKnown: boolean;
  }[];
  nextCursor: string | null;
}

/**
 * Source people: ann, ben, cat (candidates, cat in the group `devs`), dan (no e-mail), eve (excluded),
 * fay (confirmed), gus (pending_invite). Target members: ann-gh, fay-gh.
 */
async function seed() {
  const db = t.db.privileged;
  await db.auditEvent.deleteMany({ where: { subjectType: 'invitation_batch' } });
  await db.expectedDifference.deleteMany({});
  await db.invitation.deleteMany({});
  await db.invitationBatch.deleteMany({});
  await db.identityMapping.deleteMany({});
  await db.groupMapping.deleteMany({});
  await db.migration.updateMany({ data: { latestAnalysisId: null } });
  await db.migration.deleteMany({});
  await db.repository.deleteMany({});
  await db.namespace.deleteMany({});
  await db.identity.deleteMany({});
  await db.group.deleteMany({});
  await db.route.deleteMany({});
  await db.endpoint.deleteMany({});
  for (const id of ['src85', 'dst85']) {
    await db.endpoint.create({
      data: {
        id,
        providerType: 'type-a',
        displayName: id,
        baseUrl: `http://${id}.test`,
        status: 'active',
        configHash: 'h',
      },
    });
  }
  await db.route.create({
    data: {
      id: ROUTE,
      sourceEndpointId: 'src85',
      targetEndpointId: 'dst85',
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
    email: string | null,
    status?: 'unmapped' | 'excluded' | 'confirmed' | 'pending_invite',
  ) => {
    const row = await db.identity.create({
      data: {
        endpointId,
        providerId: `acct-${name}`,
        login: name,
        displayName: name,
        email,
        kind: 'user',
        isMember: true,
      },
    });
    ids[name] = row.id;
    if (status) {
      const mapping = await db.identityMapping.create({
        data: { routeId: ROUTE, sourceIdentityId: row.id, status },
      });
      ids[`m-${name}`] = mapping.id;
    }
  };
  await identity('ann', 'src85', 'ann@acme.test', 'unmapped');
  await identity('ben', 'src85', 'ben@acme.test', 'unmapped');
  await identity('cat', 'src85', 'cat@acme.test', 'unmapped');
  await identity('dan', 'src85', null, 'unmapped');
  await identity('eve', 'src85', 'eve@acme.test', 'excluded');
  await identity('fay', 'src85', 'fay@acme.test', 'confirmed');
  await identity('gus', 'src85', 'gus@acme.test', 'pending_invite');
  await identity('ann-gh', 'dst85', null);
  await identity('fay-gh', 'dst85', null);
  const group = await db.group.create({
    data: {
      endpointId: 'src85',
      providerId: 'g-devs',
      slug: 'devs',
      name: 'Devs',
      memberIds: [ids.cat as string, ids.ann as string],
    },
  });
  await db.groupMapping.create({
    data: { routeId: ROUTE, sourceGroupId: group.id, status: 'unmapped', plannedSlug: 'devs-x' },
  });
  const ns = await db.namespace.create({
    data: { endpointId: 'src85', providerId: 'ns', kind: 'project', slug: 'p', name: 'P' },
  });
  const repo = await db.repository.create({
    data: {
      endpointId: 'src85',
      namespaceId: ns.id,
      providerId: 'r1',
      slug: 'r1',
      name: 'r1',
      fullPath: 'p/r1',
      isPrivate: true,
      lastInventoriedAt: new Date(),
    },
  });
  ids.migration = (
    await db.migration.create({
      data: { scope: 'repository', routeId: ROUTE, sourceRepositoryId: repo.id },
    })
  ).id;
}

beforeEach(async () => {
  steps.length = 0;
  queueDown = false;
  await seed();
});

async function draft(who: string[]): Promise<Batch> {
  const res = await post(`${base}/invitation-batches`, {
    identityIds: who.map((w) => ids[w] as string),
  });
  expect(res.status).toBe(201);
  return read<Batch>(res);
}
const detail = async (id: string, query = ''): Promise<ItemList> =>
  read<ItemList>(await call(`/api/v1/invitation-batches/${id}${query}`));
const itemFor = async (batchId: string, who: string) =>
  (await detail(batchId)).items.find((i) => i.source.id === ids[who]) as ItemList['items'][number];

describe('[AUTH-060] candidates and drafts', () => {
  it('[AUTH-060] lists candidates with their team slugs; not the decided, the e-mail-less or the pending', async () => {
    const res = await call(`${base}/invitation-candidates`);
    expect(res.status).toBe(200);
    const body = await read<{
      items: { identity: { login: string }; teamSlugs: string[] }[];
    }>(res);
    expect(body.items.map((i) => i.identity.login).sort()).toEqual(['ann', 'ben', 'cat']);
    expect(body.items.find((i) => i.identity.login === 'cat')?.teamSlugs).toEqual(['devs-x']);
    const filtered = await read<typeof body>(await call(`${base}/invitation-candidates?q=BEN`));
    expect(filtered.items.map((i) => i.identity.login)).toEqual(['ben']);
  });

  it('[AUTH-060] creates a draft with the e-mail and team slugs, a seat preview and a queued seat read', async () => {
    const batch = await draft(['ann', 'cat']);
    expect(batch).toMatchObject({
      status: 'draft',
      counts: { selected: 2 },
      seatPreview: { toInvite: 2, seatsTotal: null },
    });
    expect(steps).toEqual([{ step: 'seats', batchId: batch.id }]);
    const d = await detail(batch.id);
    expect(d.items.find((i) => i.email === 'cat@acme.test')).toBeDefined();
    const row = await t.db.privileged.invitation.findFirstOrThrow({
      where: { batchId: batch.id, sourceIdentityId: ids.cat as string },
    });
    expect(row.teamSlugs).toEqual(['devs-x']);
  });

  it('[AUTH-060] a draft from all candidates', async () => {
    const res = await post(`${base}/invitation-batches`, { all: true });
    expect(res.status).toBe(201);
    expect((await read<Batch>(res)).counts.selected).toBe(3);
  });

  it('[AUTH-060] refuses a draft that names nobody, both ways, or someone who is not a candidate', async () => {
    expect((await post(`${base}/invitation-batches`, {})).status).toBe(422);
    expect(
      (await post(`${base}/invitation-batches`, { all: true, identityIds: [ids.ann] })).status,
    ).toBe(422);
    for (const who of ['dan', 'eve', 'fay', 'gus']) {
      expect((await post(`${base}/invitation-batches`, { identityIds: [ids[who]] })).status).toBe(
        422,
      );
    }
    // Someone in another open batch is not a candidate either.
    await draft(['ann']);
    expect((await post(`${base}/invitation-batches`, { identityIds: [ids.ann] })).status).toBe(422);
    expect((await post(`/api/v1/routes/nope/invitation-batches`, { all: true })).status).toBe(404);
  });

  it('[AUTH-060] a draft is created even when the queue is down, and the fault is not shown', async () => {
    queueDown = true;
    const res = await post(`${base}/invitation-batches`, { identityIds: [ids.ann] });
    expect(res.status).toBe(201);
    expect(await res.clone().text()).not.toContain('secret-detail');
  });

  it('[AUTH-021] a viewer reads batches but cannot create, change or approve them', async () => {
    const batch = await draft(['ann']);
    expect((await call(`${base}/invitation-candidates`, { role: 'viewer' })).status).toBe(200);
    expect((await call('/api/v1/invitation-batches', { role: 'viewer' })).status).toBe(200);
    expect((await call(`/api/v1/invitation-batches/${batch.id}`, { role: 'viewer' })).status).toBe(
      200,
    );
    expect((await post(`${base}/invitation-batches`, { all: true }, 'viewer')).status).toBe(403);
    const item = await itemFor(batch.id, 'ann');
    for (const action of ['select', 'deselect', 'revoke']) {
      expect(
        (
          await post(
            `/api/v1/invitation-batches/${batch.id}/items/${item.id}/${action}`,
            { reason: 'x' },
            'viewer',
          )
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await post(
          `/api/v1/invitation-batches/${batch.id}/approve`,
          { expectedToken: 'x' },
          'viewer',
        )
      ).status,
    ).toBe(403);
    expect(
      (await t.db.privileged.invitationBatch.findUniqueOrThrow({ where: { id: batch.id } })).status,
    ).toBe('draft');
  });

  it('[AUTH-060] lists batches newest first with paging, and filters by status', async () => {
    const one = await draft(['ann']);
    const two = await draft(['ben']);
    const list = await read<{ items: Batch[]; nextCursor: string | null }>(
      await call('/api/v1/invitation-batches?limit=1'),
    );
    expect(list.items.map((b) => b.id)).toEqual([two.id]);
    expect(list.nextCursor).toBe(two.id);
    const next = await read<typeof list>(
      await call(`/api/v1/invitation-batches?limit=1&cursor=${list.nextCursor}`),
    );
    expect(next.items.map((b) => b.id)).toEqual([one.id]);
    const none = await read<typeof list>(await call('/api/v1/invitation-batches?status=sent'));
    expect(none.items).toEqual([]);
    expect((await call('/api/v1/invitation-batches/missing')).status).toBe(404);
  });

  it('[AUTH-060] pages the entries of a batch and filters them by status', async () => {
    const batch = await draft(['ann', 'ben', 'cat']);
    const first = await detail(batch.id, '?limit=2');
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items[1]?.id);
    const rest = await detail(batch.id, `?limit=2&cursor=${first.nextCursor}`);
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
    expect((await detail(batch.id, '?status=sent')).items).toEqual([]);
  });
});

describe('[AUTH-060] select and deselect', () => {
  const act = (batchId: string, itemId: string, action: string, body?: unknown) =>
    post(`/api/v1/invitation-batches/${batchId}/items/${itemId}/${action}`, body);

  it('[AUTH-060] deselecting needs a reason, updates the seat preview and creates the exclusions', async () => {
    const batch = await draft(['ann', 'ben']);
    const item = await itemFor(batch.id, 'ann');
    expect((await act(batch.id, item.id, 'deselect')).status).toBe(422);
    expect((await act(batch.id, item.id, 'deselect', { reason: ' ' })).status).toBe(422);
    expect((await act(batch.id, item.id, 'deselect', { reason: 'x'.repeat(1100) })).status).toBe(
      422,
    );
    const res = await act(batch.id, item.id, 'deselect', { reason: 'left the company' });
    expect(res.status).toBe(200);
    expect(await read<{ status: string }>(res)).toEqual({ status: 'deselected' });
    const after = await detail(batch.id);
    expect(after.batch.seatPreview.toInvite).toBe(1);
    expect(after.items.find((i) => i.id === item.id)).toMatchObject({
      status: 'deselected',
      deselectReason: 'left the company',
    });
    const eds = await t.db.privileged.expectedDifference.findMany({
      where: { invitationId: item.id, revokedAt: null },
    });
    expect(eds.map((e) => e.facetKey).sort()).toEqual([
      'access-control',
      'branch-rules',
      'branch-rules',
      'branch-rules',
      'branch-rules',
      'code-ownership',
      'members',
      'teams',
    ]);
    expect(
      eds.every((e) => e.note === 'left the company' && e.reason === 'identity_excluded'),
    ).toBe(true);
    expect(eds.every((e) => e.identityMappingId === ids['m-ann'])).toBe(true);
    // Deselecting again changes nothing.
    expect((await act(batch.id, item.id, 'deselect', { reason: 'other' })).status).toBe(200);
    expect(
      await t.db.privileged.expectedDifference.count({ where: { invitationId: item.id } }),
    ).toBe(8);
  });

  it('[AUTH-060] reselecting revokes the deselection and restores the count', async () => {
    const batch = await draft(['ann']);
    const item = await itemFor(batch.id, 'ann');
    await act(batch.id, item.id, 'deselect', { reason: 'r' });
    const res = await act(batch.id, item.id, 'select');
    expect(await read<{ status: string }>(res)).toEqual({ status: 'selected' });
    expect(
      await t.db.privileged.expectedDifference.count({
        where: { invitationId: item.id, revokedAt: null },
      }),
    ).toBe(0);
    expect((await detail(batch.id)).batch.seatPreview.toInvite).toBe(1);
    expect((await act(batch.id, item.id, 'select')).status).toBe(200);
  });

  it('[AUTH-060] a deselection masks nobody who is already decided, and a decided person cannot be reselected', async () => {
    const batch = await draft(['ann']);
    const item = await itemFor(batch.id, 'ann');
    await t.db.privileged.identityMapping.update({
      where: { id: ids['m-ann'] as string },
      data: { status: 'confirmed', targetIdentityId: ids['ann-gh'] as string },
    });
    await act(batch.id, item.id, 'deselect', { reason: 'mapped meanwhile' });
    expect(
      await t.db.privileged.expectedDifference.count({ where: { invitationId: item.id } }),
    ).toBe(0);
    expect((await act(batch.id, item.id, 'select')).status).toBe(409);
  });

  it('[AUTH-060] confirming or excluding the mapping revokes the deselection with it', async () => {
    const batch = await draft(['ben']);
    const item = await itemFor(batch.id, 'ben');
    await act(batch.id, item.id, 'deselect', { reason: 'r' });
    expect(
      (await post(`${base}/identity-mappings/${ids['m-ben']}/exclude`, { reason: 'gone' })).status,
    ).toBe(200);
    const rows = await t.db.privileged.expectedDifference.findMany({
      where: { identityMappingId: ids['m-ben'] as string, revokedAt: null },
    });
    // Only the exclusion's own eight differences remain.
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.invitationId === null)).toBe(true);
  });

  it('[AUTH-060] 404 for an entry of another batch, 409 after approval', async () => {
    const batch = await draft(['ann']);
    const other = await draft(['ben']);
    const item = await itemFor(batch.id, 'ann');
    expect((await act(other.id, item.id, 'deselect', { reason: 'r' })).status).toBe(404);
    expect((await act(batch.id, 'nope', 'select')).status).toBe(404);
    await post(`/api/v1/invitation-batches/${batch.id}/approve`, {
      expectedToken: await tokenFor(batch.id),
    });
    expect((await act(batch.id, item.id, 'deselect', { reason: 'r' })).status).toBe(409);
    expect((await act(batch.id, item.id, 'select')).status).toBe(409);
  });

  it('[AUTH-060] deselecting does not mark Analyses stale (nothing resolves differently)', async () => {
    const batch = await draft(['ann']);
    const before = (
      await t.db.privileged.migration.findUniqueOrThrow({ where: { id: ids.migration as string } })
    ).staleGeneration;
    await act(batch.id, (await itemFor(batch.id, 'ann')).id, 'deselect', { reason: 'r' });
    expect(
      (
        await t.db.privileged.migration.findUniqueOrThrow({
          where: { id: ids.migration as string },
        })
      ).staleGeneration,
    ).toBe(before);
  });
});

const tokenFor = async (batchId: string) =>
  selectionToken(
    (
      await t.db.privileged.invitation.findMany({
        where: { batchId, status: 'selected' },
        select: { id: true },
      })
    ).map((i) => i.id),
  );

describe('[AUTH-060] approval', () => {
  const approve = async (
    batchId: string,
    body: Record<string, unknown> = {},
    role: keyof typeof keys = 'operator',
  ) =>
    post(
      `/api/v1/invitation-batches/${batchId}/approve`,
      { expectedToken: await tokenFor(batchId), ...body },
      role,
    );

  it('[AUTH-060] records the approver and enqueues the send step', async () => {
    const batch = await draft(['ann', 'ben']);
    steps.length = 0;
    const res = await approve(batch.id, { expectedCount: 2 });
    expect(res.status).toBe(202);
    const body = await read<{ approved: number; dropped: number; batch: Batch }>(res);
    expect(body).toMatchObject({
      approved: 2,
      dropped: 0,
      batch: { status: 'approved', approvedBy: 'svc-operator' },
    });
    expect(steps).toEqual([{ step: 'send', batchId: batch.id }]);
    const row = await t.db.privileged.invitationBatch.findUniqueOrThrow({
      where: { id: batch.id },
    });
    expect(row.approvedById).not.toBeNull();
    expect(row.approvedAt).not.toBeNull();
    const audit = await t.db.privileged.auditEvent.findFirst({
      where: { subjectId: batch.id, action: 'invitation-batch.approve' },
    });
    expect(audit?.data).toMatchObject({ approved: 2 });
  });

  it('[AUTH-061] a second approval and a wrong final count are 409 and change nothing', async () => {
    const batch = await draft(['ann', 'ben']);
    expect((await approve(batch.id, { expectedCount: 5 })).status).toBe(409);
    expect(
      (await t.db.privileged.invitationBatch.findUniqueOrThrow({ where: { id: batch.id } })).status,
    ).toBe('draft');
    expect((await approve(batch.id)).status).toBe(202);
    steps.length = 0;
    expect((await approve(batch.id)).status).toBe(409);
    expect(steps).toEqual([]);
  });

  it('[AUTH-061] two approvals at once: one is accepted, one is 409, one send step', async () => {
    const batch = await draft(['ann']);
    steps.length = 0;
    const statuses = (await Promise.all([approve(batch.id), approve(batch.id)])).map(
      (r) => r.status,
    );
    expect(statuses.sort()).toEqual([202, 409]);
    expect(steps).toHaveLength(1);
  });

  it('[AUTH-061] the selection token is required to approve', async () => {
    const batch = await draft(['ann']);
    expect((await post(`/api/v1/invitation-batches/${batch.id}/approve`, {})).status).toBe(422);
    expect((await post(`/api/v1/invitation-batches/${batch.id}/approve`)).status).toBe(422);
    expect(
      (await t.db.privileged.invitationBatch.findUniqueOrThrow({ where: { id: batch.id } })).status,
    ).toBe('draft');
  });

  it('[AUTH-061] a write that reaches an outstanding-invitation index is a 409, not a server error', async () => {
    const duplicate = Object.assign(
      new Error(
        'duplicate key value violates unique constraint "invitation_outstanding_person_key"',
      ),
      { code: '23505' },
    );
    await expect(asConflict(() => Promise.reject(duplicate))).rejects.toMatchObject({
      status: 409,
    });
    await expect(asConflict(() => Promise.reject(new Error('other')))).rejects.toThrow('other');
  });

  it('[AUTH-060] a batch with nothing selected cannot be approved', async () => {
    const batch = await draft(['ann']);
    const item = await itemFor(batch.id, 'ann');
    await post(`/api/v1/invitation-batches/${batch.id}/items/${item.id}/deselect`, { reason: 'r' });
    expect((await approve(batch.id)).status).toBe(409);
  });

  it('[AUTH-061] people decided since the draft are dropped at approval, without an exclusion', async () => {
    const batch = await draft(['ann', 'ben']);
    await t.db.privileged.identityMapping.update({
      where: { id: ids['m-ben'] as string },
      data: { status: 'excluded' },
    });
    expect((await approve(batch.id, { expectedCount: 2 })).status).toBe(409);
    const res = await approve(batch.id, { expectedCount: 1 });
    expect(await read<{ approved: number; dropped: number }>(res)).toMatchObject({
      approved: 1,
      dropped: 1,
    });
    const dropped = await itemFor(batch.id, 'ben');
    expect(dropped).toMatchObject({ status: 'deselected' });
    expect(dropped.deselectReason).toMatch(/no longer a candidate \(excluded\)/);
    expect(
      await t.db.privileged.expectedDifference.count({ where: { invitationId: dropped.id } }),
    ).toBe(0);
  });

  it('[AUTH-060] the approval stands when the queue is down; the fault is not shown', async () => {
    const batch = await draft(['ann']);
    queueDown = true;
    const res = await approve(batch.id);
    expect(res.status).toBe(202);
    expect(await res.clone().text()).not.toContain('secret-detail');
    expect(
      (await t.db.privileged.invitationBatch.findUniqueOrThrow({ where: { id: batch.id } })).status,
    ).toBe('approved');
  });

  it('[AUTH-060] publishes invitation.updated for the batch after commit', async () => {
    const listener = await t.db.pool.connect();
    await listener.query(`LISTEN ${EVENT_CHANNEL}`);
    const received: { type: string; ids: Record<string, string> }[] = [];
    listener.on('notification', (n) => {
      if (n.payload) received.push(JSON.parse(n.payload));
    });
    try {
      const batch = await draft(['ann']);
      await approve(batch.id);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(received.filter((e) => e.type === 'invitation.updated')).toHaveLength(2);
      expect(received.every((e) => e.ids.invitation === batch.id)).toBe(true);
      received.length = 0;
      await approve(batch.id);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(received).toEqual([]);
    } finally {
      listener.release();
    }
  });
});

describe('[AUTH-060] revoke and the mapping', () => {
  async function sentBatch() {
    const batch = await draft(['ann']);
    const item = await itemFor(batch.id, 'ann');
    await post(`/api/v1/invitation-batches/${batch.id}/approve`, {
      expectedToken: await tokenFor(batch.id),
    });
    // What the send job leaves behind.
    await t.db.privileged.invitation.update({
      where: { id: item.id },
      data: { status: 'sent', providerInvitationId: '77', sentAt: new Date() },
    });
    await t.db.privileged.identityMapping.update({
      where: { id: ids['m-ann'] as string },
      data: { status: 'pending_invite', method: 'invite' },
    });
    return { batch, item };
  }

  it('[AUTH-060] revoking a sent invitation queues the job; anything else is 409', async () => {
    const { batch, item } = await sentBatch();
    steps.length = 0;
    const res = await post(`/api/v1/invitation-batches/${batch.id}/items/${item.id}/revoke`);
    expect(res.status).toBe(202);
    expect(steps).toEqual([{ step: 'revoke', batchId: batch.id, invitationId: item.id }]);
    const draftBatch = await draft(['ben']);
    const ben = await itemFor(draftBatch.id, 'ben');
    expect(
      (await post(`/api/v1/invitation-batches/${draftBatch.id}/items/${ben.id}/revoke`)).status,
    ).toBe(409);
    queueDown = true;
    expect(
      (await post(`/api/v1/invitation-batches/${batch.id}/items/${item.id}/revoke`)).status,
    ).toBe(503);
  });

  it('[AUTH-060] unmapping a pending_invite mapping is still refused: the revoke flow owns it', async () => {
    await sentBatch();
    const res = await post(`${base}/identity-mappings/${ids['m-ann']}/unmap`);
    expect(res.status).toBe(409);
  });

  it('[AUTH-061] exclude, CSV map/exclude and the candidate list all respect a pending invitation', async () => {
    const { batch } = await sentBatch();
    const res = await post(`${base}/identity-mappings/${ids['m-ann']}/exclude`, { reason: 'gone' });
    expect(res.status).toBe(409);
    expect((await read<{ code: string }>(res)).code).toBe('revoke_first');
    for (const action of ['map', 'exclude']) {
      const csv = `source,target,action\nacct-ann,${action === 'map' ? 'ann-gh' : ''},${action}\n`;
      const imported = await app.request(
        `${ORIGIN}/api/v1/routes/${ROUTE}/identity-mappings/import`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${keys.operator}`, 'content-type': 'text/csv' },
          body: csv,
        },
      );
      expect(imported.status).toBe(422);
      expect(JSON.stringify(await imported.json())).toContain('invite_pending');
    }
    expect(
      (
        await t.db.privileged.identityMapping.findUniqueOrThrow({
          where: { id: ids['m-ann'] as string },
        })
      ).status,
    ).toBe('pending_invite');
    const cands = await read<{ items: { identity: { login: string } }[] }>(
      await call(`${base}/invitation-candidates`),
    );
    expect(cands.items.map((i) => i.identity.login)).not.toContain('ann');
    expect((await post(`${base}/invitation-batches`, { identityIds: [ids.ann] })).status).toBe(422);
    expect(batch.id).toBeTruthy();
  });

  it('[AUTH-061] approval is refused when the reviewed selection changed (token), and reselecting a held person is a 409', async () => {
    const batch = await draft(['ann', 'ben']);
    const item = await itemFor(batch.id, 'ben');
    const res = await post(`/api/v1/invitation-batches/${batch.id}/approve`, {
      expectedToken: batch.selectionToken,
    });
    expect(res.status).toBe(202);
    const second = await draft(['cat']);
    expect(second.selectionToken).not.toBe(batch.selectionToken);
    const stale = await post(`/api/v1/invitation-batches/${second.id}/approve`, {
      expectedToken: batch.selectionToken,
    });
    expect(stale.status).toBe(409);
    expect(item.id).toBeTruthy();
  });

  it('[AUTH-060] a refused revoke leaves no audit trace; an accepted one is audited after it is queued', async () => {
    const { batch, item } = await sentBatch();
    queueDown = true;
    await post(`/api/v1/invitation-batches/${batch.id}/items/${item.id}/revoke`);
    expect(await t.db.privileged.auditEvent.count({ where: { action: 'invitation.revoke' } })).toBe(
      0,
    );
    queueDown = false;
    await post(`/api/v1/invitation-batches/${batch.id}/items/${item.id}/revoke`);
    expect(await t.db.privileged.auditEvent.count({ where: { action: 'invitation.revoke' } })).toBe(
      1,
    );
  });

  it('[AUTH-060] a sent entry lists the new members that might be the invitee, e-mail match first', async () => {
    const { batch } = await sentBatch();
    const sentAt = new Date(Date.now() - 1000);
    await t.db.privileged.invitation.updateMany({ where: { batchId: batch.id }, data: { sentAt } });
    const db = t.db.privileged;
    // The members that were there before the invitation went out are not new.
    await db.identity.updateMany({
      where: { endpointId: 'dst85' },
      data: { createdAt: new Date(Date.now() - 86_400_000) },
    });
    await db.identity.create({
      data: {
        endpointId: 'dst85',
        providerId: 'acct-zed',
        login: 'zed',
        email: null,
        kind: 'user',
        isMember: true,
      },
    });
    await db.identity.create({
      data: {
        endpointId: 'dst85',
        providerId: 'acct-ann2',
        login: 'ann2',
        email: 'ANN@acme.test',
        kind: 'user',
        isMember: true,
      },
    });
    const d = await detail(batch.id);
    const suggestions = d.items[0]?.suggestions ?? [];
    expect(suggestions.map((s) => s.login)).toEqual(['ann2', 'zed']);
    // A member already confirmed for someone is not offered again.
    await db.identityMapping.update({
      where: { id: ids['m-fay'] as string },
      data: {
        targetIdentityId: (await db.identity.findFirstOrThrow({ where: { login: 'zed' } })).id,
      },
    });
    expect(((await detail(batch.id)).items[0]?.suggestions ?? []).map((s) => s.login)).toEqual([
      'ann2',
    ]);
  });

  it('[AUTH-060] an operator who confirms a suggestion for a pending_invite mapping accepts the invitation', async () => {
    const { batch, item } = await sentBatch();
    const res = await post(`${base}/identity-mappings/${ids['m-ann']}/confirm`, {
      targetIdentityId: ids['ann-gh'],
    });
    expect(res.status).toBe(200);
    expect((await detail(batch.id)).items.find((i) => i.id === item.id)?.status).toBe('accepted');
  });
});

describe('[AUTH-061] resolving an unknown outcome', () => {
  async function unknownItem() {
    const batch = await draft(['ann']);
    const item = await itemFor(batch.id, 'ann');
    await post(`/api/v1/invitation-batches/${batch.id}/approve`, {
      expectedToken: await tokenFor(batch.id),
    });
    // What the send job leaves behind when it cannot tell whether the invitation went out.
    await t.db.privileged.invitation.update({
      where: { id: item.id },
      data: { status: 'unknown', error: 'unknown_outcome', sendStartedAt: new Date() },
    });
    await t.db.privileged.identityMapping.update({
      where: { id: ids['m-ann'] as string },
      data: { status: 'pending_invite', method: 'invite' },
    });
    return { batch, item };
  }
  const resolve = (
    batchId: string,
    itemId: string,
    body: unknown,
    role: keyof typeof keys = 'operator',
  ) => post(`/api/v1/invitation-batches/${batchId}/items/${itemId}/resolve`, body, role);
  const mappingStatus = async () =>
    (
      await t.db.privileged.identityMapping.findUniqueOrThrow({
        where: { id: ids['m-ann'] as string },
      })
    ).status;
  const candidateLogins = async () =>
    (
      await read<{ items: { identity: { login: string } }[] }>(
        await call(`${base}/invitation-candidates`),
      )
    ).items.map((i) => i.identity.login);

  it('[AUTH-061] the person and the address stay held while the outcome is unknown', async () => {
    await unknownItem();
    expect(await candidateLogins()).not.toContain('ann');
    expect((await post(`${base}/invitation-batches`, { identityIds: [ids.ann] })).status).toBe(422);
    // A second identity with the same address (another case, a stray space) is held too.
    await t.db.privileged.identity.update({
      where: { id: ids.ben as string },
      data: { email: 'ANN@acme.test ' },
    });
    expect((await post(`${base}/invitation-batches`, { identityIds: [ids.ben] })).status).toBe(422);
    expect(await mappingStatus()).toBe('pending_invite');
  });

  it('[AUTH-061] resolving as invited makes it sent and keeps the person held', async () => {
    const { batch, item } = await unknownItem();
    expect((await resolve(batch.id, item.id, { outcome: 'invited' }, 'viewer')).status).toBe(403);
    expect((await resolve(batch.id, item.id, {})).status).toBe(422);
    const res = await resolve(batch.id, item.id, { outcome: 'invited' });
    expect(await read<{ status: string }>(res)).toEqual({ status: 'sent' });
    expect((await itemFor(batch.id, 'ann')).status).toBe('sent');
    // No invitation id is recorded: the UI warns before a revoke (it is looked up by address).
    expect((await itemFor(batch.id, 'ann')).providerIdKnown).toBe(false);
    expect(await mappingStatus()).toBe('pending_invite');
    expect(await candidateLogins()).not.toContain('ann');
    expect((await resolve(batch.id, item.id, { outcome: 'invited' })).status).toBe(409);
  });

  it('[AUTH-061] resolving as not invited frees the person and marks Analyses stale', async () => {
    const { batch, item } = await unknownItem();
    const generation = async () =>
      (
        await t.db.privileged.migration.findUniqueOrThrow({
          where: { id: ids.migration as string },
        })
      ).staleGeneration;
    const before = await generation();
    const res = await resolve(batch.id, item.id, { outcome: 'not_invited' });
    expect(await read<{ status: string }>(res)).toEqual({ status: 'failed' });
    expect(await mappingStatus()).toBe('unmapped');
    expect(await generation()).toBeGreaterThan(before);
    expect(await candidateLogins()).toContain('ann');
    expect(
      await t.db.privileged.auditEvent.count({ where: { action: 'invitation.resolve' } }),
    ).toBe(1);
  });

  it('[AUTH-061] an entry that is not unknown cannot be resolved', async () => {
    const batch = await draft(['ann']);
    const item = await itemFor(batch.id, 'ann');
    expect((await resolve(batch.id, item.id, { outcome: 'not_invited' })).status).toBe(409);
  });

  it('[AUTH-061] confirming a person whose send is in flight holds the entry as unknown, not freed', async () => {
    const batch = await draft(['ann']);
    const item = await itemFor(batch.id, 'ann');
    await post(`/api/v1/invitation-batches/${batch.id}/approve`, {
      expectedToken: await tokenFor(batch.id),
    });
    // What a claim leaves behind while the provider call runs (or after its response was lost).
    await t.db.privileged.invitation.update({
      where: { id: item.id },
      data: { sendStartedAt: new Date() },
    });
    await t.db.privileged.identityMapping.update({
      where: { id: ids['m-ann'] as string },
      data: { status: 'pending_invite', method: 'invite' },
    });
    const res = await post(`${base}/identity-mappings/${ids['m-ann']}/confirm`, {
      targetIdentityId: ids['ann-gh'],
    });
    expect(res.status).toBe(200);
    expect(await itemFor(batch.id, 'ann')).toMatchObject({
      status: 'unknown',
      error: 'mapping_confirmed',
    });
    // The address stays held: another person with it cannot be drafted.
    await t.db.privileged.identity.update({
      where: { id: ids.ben as string },
      data: { email: 'Ann@acme.test' },
    });
    expect((await post(`${base}/invitation-batches`, { identityIds: [ids.ben] })).status).toBe(422);
  });

  it('[AUTH-061] confirming the invitee of an unknown entry accepts it', async () => {
    const { batch, item } = await unknownItem();
    const res = await post(`${base}/identity-mappings/${ids['m-ann']}/confirm`, {
      targetIdentityId: ids['ann-gh'],
    });
    expect(res.status).toBe(200);
    expect((await detail(batch.id)).items.find((i) => i.id === item.id)?.status).toBe('accepted');
  });
});
