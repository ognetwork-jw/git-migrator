/**
 * T-085: invitation batches against the TST-012 fixture world. The real GitHub adapter (through
 * the registry) talks to the fake GitHub over loopback; Postgres is a throw-away database. The
 * job clock is injected, so expiry is decided without waiting (TST-006).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdapterError, type EndpointConnection } from '@git-migrator/adapter-sdk';
import {
  approveBatch,
  createBatch,
  deselectItem,
  listCandidates,
  resolveItem,
  selectItem,
  selectionToken,
} from '@git-migrator/api';
import { type Config, resolveConfig } from '@git-migrator/config';
import { formatFieldPath, itemSeg, matchesPattern } from '@git-migrator/core';
import { hashConfig, syncConfig } from '@git-migrator/db';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import {
  resetWorld,
  startWorldFakes,
  WORLD_MEMBERS,
  WORLD_WORKSPACE,
} from '@git-migrator/fixtures';
import {
  createEndpointConnector,
  createProviderEnvironment,
  type EndpointConnector,
  type InvitationDeps,
  type InvitationStep,
  invitationHandlers,
  noGitClient,
  runInventory,
  runInvitationRevoke,
  runInvitationSend,
  runSeatPreview,
} from '@git-migrator/jobs';
import { createLogger, createMetrics } from '@git-migrator/observability';
import type { RunningFakes } from '@git-migrator/provider-fakes';
import { QuotaLeases, QuotaService } from '@git-migrator/quota';
import { createBuiltinRegistry } from '@git-migrator/registry';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const PEM = readFileSync(join(here, '../../fixtures/fake-github-app.pem'), 'utf8');
const SOURCE = 'bb-inv';
const TARGET = 'gh-inv';
const ROUTE = 'r-inv';
const ROUTE_2 = 'r-inv2';
const DAY = 24 * 3600 * 1000;
const log = createLogger({ level: 'silent' });
const registry = createBuiltinRegistry();
const shutdown = new AbortController();

let fakes: RunningFakes;
let t: TestDatabase;
let config: Config;
let connector: EndpointConnector;
let quota: QuotaService;
let operator: string;
/** The injected job clock (TST-006). */
let nowMs = Date.now();
const now = () => new Date(nowMs);
/** A fault the next lookups of pending invitations raise (undefined: none). */
let lookupFault: AdapterError | undefined;
/** How many times the send job asked the provider to invite. */
let inviteCalls = 0;
const scheduled: Array<{ step: InvitationStep; delayMs: number }> = [];

const github = () => {
  if (!fakes.github) throw new Error('the fake GitHub did not start');
  return fakes.github;
};
const org = () => github().state.requireOrg('acme');
const db = () => t.db.privileged;

const deps = (hooks?: InvitationDeps['hooks']): InvitationDeps => ({
  db: db(),
  appPool: t.db.pool,
  connector,
  schedule: async (step, delayMs) => {
    scheduled.push({ step, delayMs });
  },
  log,
  now,
  ...(hooks ? { hooks } : {}),
});
const send = (batchId: string, hooks?: InvitationDeps['hooks']) =>
  runInvitationSend(deps(hooks), batchId, { shutdown: shutdown.signal });
const inventory = (endpointId: string) =>
  runInventory(
    {
      db: db(),
      appPool: t.db.pool,
      connector,
      registry,
      config,
      log,
      now,
      scheduleInvitation: async (step, delayMs) => {
        scheduled.push({ step, delayMs });
      },
    },
    endpointId,
    { shutdown: shutdown.signal },
  );

let counter = 0;
/** A source person with a known e-mail and an `unmapped` mapping: an invitation candidate. */
async function person(extra: { groupSlug?: string } = {}) {
  const name = `invitee${++counter}`;
  const identity = await db().identity.create({
    data: {
      endpointId: SOURCE,
      providerId: `acct-${name}`,
      login: name,
      displayName: name,
      email: `${name}@acme.example`,
      emailSource: 'atlassian-admin',
      kind: 'user',
      isMember: true,
    },
  });
  await db().identityMapping.create({
    data: { routeId: ROUTE, sourceIdentityId: identity.id, status: 'unmapped' },
  });
  if (extra.groupSlug) {
    const group = await db().group.findFirstOrThrow({
      where: { endpointId: SOURCE, slug: extra.groupSlug },
    });
    await db().group.update({
      where: { id: group.id },
      data: { memberIds: [...group.memberIds, identity.id] },
    });
  }
  return identity;
}

const draft = (ids: string[]) =>
  createBatch(t.db, ROUTE, { identityIds: ids }, { actorId: operator, now: now() });
const approve = async (batchId: string, expectedCount?: number) => {
  const selected = await db().invitation.findMany({
    where: { batchId, status: 'selected' },
    select: { id: true },
  });
  return approveBatch(
    t.db,
    batchId,
    { expectedCount, expectedToken: selectionToken(selected.map((i) => i.id)) },
    { actorId: operator, now: now() },
  );
};
const itemOf = (batchId: string, sourceIdentityId: string) =>
  db().invitation.findFirstOrThrow({ where: { batchId, sourceIdentityId } });
const mappingOf = (sourceIdentityId: string) =>
  db().identityMapping.findFirstOrThrow({ where: { routeId: ROUTE, sourceIdentityId } });
const pendingEmails = () =>
  org()
    .invitations.map((i) => i.email)
    .sort();
const staleGeneration = async () =>
  (await db().migration.findFirstOrThrow({ where: { routeId: ROUTE, scope: 'endpoint' } }))
    .staleGeneration;

beforeAll(async () => {
  t = await createTestDatabase('gm_t085_');
  fakes = await startWorldFakes({ bitbucketPort: 0, githubPort: 0, gitPort: 0 });
  await resetWorld(fakes);
  const gh = github();
  const installationId = [...gh.state.installations.keys()][0] as number;
  const gitBase = fakes.git?.baseUrl ?? 'http://127.0.0.1:1';
  config = resolveConfig({
    text: `
environment: test
endpoints:
  - id: ${SOURCE}
    provider: bitbucket-cloud
    baseUrl: http://127.0.0.1:${fakes.bitbucket.port}
    gitBaseUrl: ${gitBase}/source
    options: { workspace: ${WORLD_WORKSPACE} }
  - id: ${TARGET}
    provider: github
    baseUrl: http://127.0.0.1:${gh.port}
    gitBaseUrl: ${gitBase}/target
    options: { org: acme, appId: ${gh.state.ownApp.id}, installationId: ${installationId} }
routes:
  - id: ${ROUTE}
    source: ${SOURCE}
    target: ${TARGET}
    targetNamespace: acme
  # A second Route into the same organization (AUTH-061 holds per target organization).
  - id: ${ROUTE_2}
    source: ${SOURCE}
    target: ${TARGET}
    targetNamespace: acme
`,
    env: {},
  });
  await syncConfig(db(), {
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
  quota = new QuotaService({ pool: t.db.pool });
  const real = createEndpointConnector({
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
    environment: createProviderEnvironment({
      quota,
      leases: new QuotaLeases({ pool: t.db.pool }),
      db: db(),
      recorders: createMetrics().recorders,
      logger: log,
      environment: 'test',
    }),
    git: noGitClient,
  });
  // The Atlassian Admin enrichment is not built (T-060 follow-up): the source Identities get the
  // e-mails the TST-012 table assumes.
  connector = {
    async connect(endpointId, options) {
      const connection = await real.connect(endpointId, options);
      if (endpointId !== SOURCE) {
        const writer = connection.invitations;
        if (!writer) return connection;
        // A fault in the lookup of pending invitations, injected by a test (PROBE-L).
        return {
          ...connection,
          invitations: {
            ...writer,
            async listPending() {
              if (lookupFault) throw lookupFault;
              return writer.listPending();
            },
            invite: (req) => {
              inviteCalls++;
              return writer.invite(req);
            },
          },
        };
      }
      const inventoryApi: EndpointConnection['inventory'] = {
        ...connection.inventory,
        async listIdentities(cursor) {
          const page = await connection.inventory.listIdentities(cursor);
          return {
            ...page,
            items: page.items.map((i) => {
              const member = WORLD_MEMBERS.find((m) => m.accountId === i.providerId);
              return member?.email
                ? { ...i, email: member.email, emailSource: 'atlassian-admin' }
                : i;
            }),
          };
        },
      };
      return { ...connection, inventory: inventoryApi };
    },
  };
  operator = (
    await db().actor.create({ data: { kind: 'human', displayName: 'Op', role: 'operator' } })
  ).id;
  // A team on the target, so teamSlugs resolve to a provider team id.
  gh.state.addTeam('acme', { name: 'platform-team' });
  await inventory(SOURCE);
  await inventory(TARGET);
}, 180_000);

afterAll(async () => {
  await fakes?.close();
  await t?.drop();
}, 60_000);

beforeEach(() => {
  // No state shared between tests: the clock, the provider's daily log and the schedule start clean.
  nowMs = Date.now();
  lookupFault = undefined;
  inviteCalls = 0;
  org().invitationLog = [];
  scheduled.length = 0;
});

describe('candidates and the draft', () => {
  it('[AUTH-060] candidates are people with a known e-mail and no decision, with their team slugs', async () => {
    const p = await person({ groupSlug: 'platform-team' });
    const list = await listCandidates(db(), ROUTE, { limit: 200 });
    const ids = list.rows.map((r) => r.identity.id);
    expect(ids).toContain(p.id);
    // alice is confirmed by e-mail and bob has no e-mail: neither is a candidate.
    const logins = list.rows.map((r) => r.identity.login);
    expect(logins).not.toContain('alice');
    expect(logins).not.toContain('bob');
    expect(list.rows.find((r) => r.identity.id === p.id)?.teamSlugs).toEqual(['platform-team']);
  });

  it('[AUTH-060] the seat preview reads the plan seats where the provider tells', async () => {
    const p = await person();
    const batch = await draft([p.id]);
    expect(batch.seatPreview).toMatchObject({ toInvite: 1, seatsTotal: null });
    org().plan.seats = 25;
    const result = await runSeatPreview(deps(), batch.id, { shutdown: shutdown.signal });
    expect(result.read).toBe(true);
    const stored = await db().invitationBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(stored.seatPreview).toMatchObject({ toInvite: 1, seatsTotal: 25 });
    org().plan.seats = null;
  });
});

describe('a deselection is excluded from parity', () => {
  it('[AUTH-060] deselecting needs a reason and masks the person in parity; reselecting unmasks', async () => {
    const keep = await person();
    const drop = await person();
    const batch = await draft([keep.id, drop.id]);
    const dropItem = await itemOf(batch.id, drop.id);
    await expect(
      deselectItem(t.db, batch.id, dropItem.id, '  ', { actorId: operator }),
    ).rejects.toMatchObject({ status: 422 });

    await deselectItem(t.db, batch.id, dropItem.id, 'contractor, not joining GitHub', {
      actorId: operator,
    });
    const masked = async (providerId: string) => {
      const eds = await db().expectedDifference.findMany({
        where: {
          routeId: ROUTE,
          reason: 'identity_excluded',
          revokedAt: null,
          facetKey: 'members',
        },
      });
      const path = formatFieldPath([itemSeg('members', 'principal', `identity:${providerId}`)]);
      return eds.some((ed) => matchesPattern(ed.path, path));
    };
    expect(await masked(drop.providerId)).toBe(true);
    expect(await masked(keep.providerId)).toBe(false);
    const rows = await db().expectedDifference.findMany({ where: { invitationId: dropItem.id } });
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.identityMappingId !== null && r.migrationId === null)).toBe(true);

    await selectItem(t.db, batch.id, dropItem.id, { actorId: operator });
    expect(await masked(drop.providerId)).toBe(false);
  });

  it('[AUTH-060] an exclusion made on the mapping survives reselecting the invitation entry', async () => {
    const p = await person();
    const batch = await draft([p.id]);
    const item = await itemOf(batch.id, p.id);
    await deselectItem(t.db, batch.id, item.id, 'later', { actorId: operator });
    const mapping = await mappingOf(p.id);
    await db().expectedDifference.create({
      data: {
        routeId: ROUTE,
        facetKey: 'members',
        path: '/members[principal=identity:x]',
        reason: 'identity_excluded',
        identityMappingId: mapping.id,
      },
    });
    await selectItem(t.db, batch.id, item.id, { actorId: operator });
    const kept = await db().expectedDifference.findMany({
      where: { identityMappingId: mapping.id, revokedAt: null },
    });
    expect(kept).toHaveLength(1);
  });
});

describe('nothing is invited outside an approved batch', () => {
  it('[AUTH-061] the send job does nothing for a draft batch', async () => {
    const p = await person();
    const batch = await draft([p.id]);
    const before = org().invitations.length;
    const result = await send(batch.id);
    expect(result).toMatchObject({ skipped: 'not-approved', sent: 0 });
    expect(org().invitations.length).toBe(before);
    expect((await itemOf(batch.id, p.id)).status).toBe('selected');
  });

  it('[AUTH-061] the database refuses an invitation to become sent in a draft batch', async () => {
    const p = await person();
    const batch = await draft([p.id]);
    const item = await itemOf(batch.id, p.id);
    await expect(
      db().invitation.update({ where: { id: item.id }, data: { status: 'sent' } }),
    ).rejects.toThrow();
    await expect(
      t.db.pool.query("UPDATE app.invitation_batch SET status = 'approved' WHERE id = $1", [
        batch.id,
      ]),
    ).rejects.toThrow(/approver/);
  });

  it('[AUTH-061] a draft batch cannot be sent by a forged approval without an approver', async () => {
    const p = await person();
    const batch = await draft([p.id]);
    await expect(
      t.db.pool.query(
        "UPDATE app.invitation_batch SET status = 'sending', approved_at = now() WHERE id = $1",
        [batch.id],
      ),
    ).rejects.toThrow();
  });

  it('[AUTH-061] two approvals at once: exactly one wins', async () => {
    const p = await person();
    const batch = await draft([p.id]);
    const results = await Promise.allSettled([approve(batch.id, 1), approve(batch.id, 1)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ status: 409 });
    const stored = await db().invitationBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(stored).toMatchObject({ status: 'approved', approvedById: operator });
  });

  it('[AUTH-061] an approved batch cannot be edited, and the final count is confirmed', async () => {
    const a = await person();
    const b = await person();
    const batch = await draft([a.id, b.id]);
    const itemB = await itemOf(batch.id, b.id);
    await deselectItem(t.db, batch.id, itemB.id, 'not yet', { actorId: operator });
    await expect(approve(batch.id, 2)).rejects.toMatchObject({ status: 409 });
    expect(await approve(batch.id, 1)).toMatchObject({ approved: 1 });
    await expect(selectItem(t.db, batch.id, itemB.id, { actorId: operator })).rejects.toMatchObject(
      { status: 409 },
    );
    await expect(
      t.db.pool.query("UPDATE app.invitation SET status = 'selected' WHERE id = $1", [itemB.id]),
    ).rejects.toThrow();
  });
});

describe('sending', () => {
  it('[AUTH-060] sends only the approved, non-deselected entries, records ids and sets pending_invite', async () => {
    const a = await person({ groupSlug: 'platform-team' });
    const b = await person();
    const skipped = await person();
    const batch = await draft([a.id, b.id, skipped.id]);
    await deselectItem(t.db, batch.id, (await itemOf(batch.id, skipped.id)).id, 'no', {
      actorId: operator,
    });
    await approve(batch.id, 2);
    const generation = await staleGeneration();

    const result = await send(batch.id);
    expect(result).toMatchObject({ sent: 2, failed: 0, remaining: 0, batchStatus: 'sent' });
    expect(pendingEmails()).toEqual(expect.arrayContaining([a.email, b.email] as string[]));
    expect(pendingEmails()).not.toContain(skipped.email);
    const team = org().teams.find((x) => x.slug === 'platform-team');
    const sentToA = org().invitations.find((i) => i.email === a.email);
    expect(sentToA?.teamIds).toEqual([team?.id]);
    expect(sentToA?.role).toBe('direct_member');

    const itemA = await itemOf(batch.id, a.id);
    expect(itemA).toMatchObject({ status: 'sent', error: null });
    expect(itemA.providerInvitationId).toBe(String(sentToA?.id));
    expect(itemA.sentAt).not.toBeNull();
    const mapping = await mappingOf(a.id);
    expect(mapping).toMatchObject({
      status: 'pending_invite',
      targetIdentityId: null,
      method: 'invite',
    });
    expect((await mappingOf(skipped.id)).status).toBe('unmapped');
    expect((await itemOf(batch.id, skipped.id)).status).toBe('deselected');
    // FAC-006: a mapping that resolves differently marks the Route's Analyses stale (ADR-0310).
    expect(await staleGeneration()).toBeGreaterThan(generation);
  });

  it('[AUTH-061] a retry never invites twice', async () => {
    const a = await person();
    const batch = await draft([a.id]);
    await approve(batch.id);
    await send(batch.id);
    const before = org().invitations.length;
    const again = await send(batch.id);
    expect(again).toMatchObject({ sent: 0, failed: 0 });
    expect(org().invitations.length).toBe(before);
    // Even a stale replay of the same job after the batch is done sends nothing.
    await send(batch.id);
    expect(org().invitations.filter((i) => i.email === a.email)).toHaveLength(1);
  });

  it('[AUTH-061] a crash after the provider call is repaired by the retry without a second invitation', async () => {
    const people = [await person(), await person(), await person()];
    const batch = await draft(people.map((p) => p.id));
    await approve(batch.id, 3);
    let calls = 0;
    await expect(
      send(batch.id, {
        afterProviderCall: () => {
          calls++;
          if (calls === 2) throw new Error('crash between the call and the record');
        },
      }),
    ).rejects.toThrow(/crash/);
    // The provider holds two invitations; one of them is not recorded yet.
    const emails = people.map((p) => p.email as string);
    expect(org().invitations.filter((i) => emails.includes(i.email as string))).toHaveLength(2);
    const unrecorded = await db().invitation.findMany({
      where: { batchId: batch.id, status: 'selected' },
    });
    expect(unrecorded).toHaveLength(2);
    expect(unrecorded.some((i) => i.sendStartedAt !== null)).toBe(true);

    const result = await send(batch.id);
    expect(result).toMatchObject({ sent: 2, remaining: 0, batchStatus: 'sent' });
    const held = org().invitations.filter((i) => emails.includes(i.email as string));
    expect(held).toHaveLength(3);
    expect(new Set(held.map((i) => i.email)).size).toBe(3);
    const items = await db().invitation.findMany({ where: { batchId: batch.id } });
    expect(items.every((i) => i.status === 'sent' && i.providerInvitationId !== null)).toBe(true);
    expect(new Set(items.map((i) => i.providerInvitationId)).size).toBe(3);
  });

  it('[AUTH-061] concurrent send jobs for one batch invite each person once', async () => {
    const people = [await person(), await person()];
    const batch = await draft(people.map((p) => p.id));
    await approve(batch.id);
    const results = await Promise.all([send(batch.id), send(batch.id), send(batch.id)]);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(2);
    for (const p of people) {
      expect(org().invitations.filter((i) => i.email === p.email)).toHaveLength(1);
    }
  });

  it('[AUTH-061] a person decided after approval is not invited', async () => {
    const a = await person();
    const b = await person();
    const batch = await draft([a.id, b.id]);
    await approve(batch.id, 2);
    await db().identityMapping.updateMany({
      where: { routeId: ROUTE, sourceIdentityId: a.id },
      data: { status: 'excluded', method: 'manual' },
    });
    const result = await send(batch.id);
    expect(result).toMatchObject({ sent: 1, failed: 1, batchStatus: 'partial' });
    expect(pendingEmails()).not.toContain(a.email);
    expect(await itemOf(batch.id, a.id)).toMatchObject({
      status: 'failed',
      error: 'mapping_excluded',
    });
  });

  it('[AUTH-060] the provider refusing one entry fails only that entry', async () => {
    const a = await person();
    const b = await person();
    const batch = await draft([a.id, b.id]);
    await approve(batch.id);
    // A pending invitation made outside the migrator makes the provider answer 422 for `a`; the
    // adapter finds it by e-mail and returns it, so use a member e-mail to force a refusal.
    github().state.addUser({ login: 'already-member', email: a.email, publicEmail: a.email });
    github().state.addMember('acme', 'already-member');
    const result = await send(batch.id);
    expect(result).toMatchObject({ sent: 1, failed: 1 });
    const failed = await itemOf(batch.id, a.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/^invalid \(422\)$/);
    // The error never carries provider text or a URL.
    expect(failed.error).not.toMatch(/http|acme/);
    expect((await mappingOf(a.id)).status).toBe('unmapped');
  });

  it('[AUTH-060] the daily cap leaves the rest selected and reschedules 24 h later', async () => {
    const people = [await person(), await person()];
    const batch = await draft(people.map((p) => p.id));
    await approve(batch.id);
    org().invitationLog = Array.from({ length: 1000 }, () => Date.now());
    scheduled.length = 0;

    const first = await send(batch.id);
    expect(first).toMatchObject({ sent: 0, remaining: 2 });
    expect(first.retryAt).toBeDefined();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.step).toEqual({ step: 'send', batchId: batch.id });
    expect(scheduled[0]?.delayMs).toBeGreaterThan(DAY - 60_000);
    expect((await db().invitationBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe(
      'sending',
    );
    expect((await itemOf(batch.id, people[0]?.id as string)).status).toBe('selected');

    // Woken early, the job does nothing, and it schedules itself again for the rest of the wait.
    scheduled.length = 0;
    expect(await send(batch.id)).toMatchObject({ skipped: 'not-due', sent: 0 });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBeGreaterThan(DAY - 120_000);

    org().invitationLog = [];
    nowMs += DAY + 60_000;
    const later = await send(batch.id);
    expect(later).toMatchObject({ sent: 2, remaining: 0, batchStatus: 'sent' });
  });
});

describe('acceptance and expiry through inventory', () => {
  async function sentPerson() {
    const p = await person();
    const batch = await draft([p.id]);
    await approve(batch.id);
    await send(batch.id);
    return { p, batch, item: await itemOf(batch.id, p.id) };
  }
  const accept = (email: string, login: string, publicEmail: string | null = email) => {
    const gh = github().state;
    org().invitations = org().invitations.filter((i) => i.email !== email);
    gh.addUser({ login, email, ...(publicEmail ? { publicEmail } : {}) });
    gh.addMember('acme', login);
  };

  it('[AUTH-060] a member with the invited e-mail confirms the mapping at the next inventory', async () => {
    const { p, batch, item } = await sentPerson();
    expect((await mappingOf(p.id)).status).toBe('pending_invite');
    // Still pending: an inventory changes nothing.
    await inventory(TARGET);
    expect((await itemOf(batch.id, p.id)).status).toBe('sent');

    accept(p.email as string, `${p.login}-gh`);
    const generation = await staleGeneration();
    await inventory(TARGET);
    expect((await db().invitation.findUniqueOrThrow({ where: { id: item.id } })).status).toBe(
      'accepted',
    );
    const mapping = await mappingOf(p.id);
    const target = await db().identity.findFirstOrThrow({
      where: { endpointId: TARGET, login: `${p.login}-gh` },
    });
    expect(mapping).toMatchObject({
      status: 'confirmed',
      method: 'invite',
      targetIdentityId: target.id,
    });
    expect(await staleGeneration()).toBeGreaterThan(generation);
  });

  it('[AUTH-060] the invitee login GitHub reported while pending links the member without a public e-mail', async () => {
    const { p, batch, item } = await sentPerson();
    const inv = org().invitations.find((i) => i.email === p.email);
    if (inv) inv.login = `${p.login}-hub`;
    await inventory(TARGET);
    expect((await db().invitation.findUniqueOrThrow({ where: { id: item.id } })).inviteeLogin).toBe(
      `${p.login}-hub`,
    );
    accept(p.email as string, `${p.login}-hub`, null);
    await inventory(TARGET);
    expect((await itemOf(batch.id, p.id)).status).toBe('accepted');
    expect((await mappingOf(p.id)).status).toBe('confirmed');
  });

  it('[AUTH-060] an invitation GitHub reports as failed is expired and the person is a candidate again', async () => {
    const { p, batch } = await sentPerson();
    const inv = org().invitations.find((i) => i.email === p.email);
    if (!inv) throw new Error('the invitation is missing');
    inv.failedAt = Date.now();
    inv.failedReason = 'Unable to send email';
    await inventory(TARGET);
    expect(await itemOf(batch.id, p.id)).toMatchObject({
      status: 'expired',
      error: 'failed:other',
    });
    expect((await mappingOf(p.id)).status).toBe('unmapped');
    const list = await listCandidates(db(), ROUTE, { limit: 200 });
    expect(list.rows.map((r) => r.identity.id)).toContain(p.id);
    // A new batch can invite them again.
    const again = await draft([p.id]);
    expect(again.counts.selected).toBe(1);
  });

  it('[AUTH-060] an invitation the provider lists as expired is expired; one that is merely gone is not', async () => {
    const { p, batch } = await sentPerson();
    const gone = await sentPerson();
    // Gone without a trace (it may have been accepted by someone we cannot see): never guessed.
    org().invitations = org().invitations.filter((i) => i.email !== gone.p.email);
    // Ran out: the provider moves it to its failed list (7 days).
    const lapsing = org().invitations.find((i) => i.email === p.email);
    if (!lapsing) throw new Error('the invitation is missing');
    lapsing.expiresAt = Date.now() - 1000;
    await inventory(TARGET);
    expect(await itemOf(batch.id, p.id)).toMatchObject({
      status: 'expired',
      error: 'failed:expired',
    });
    expect((await mappingOf(p.id)).status).toBe('unmapped');
    expect((await itemOf(gone.batch.id, gone.p.id)).status).toBe('sent');
    expect((await db().invitationBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe(
      'partial',
    );
  });

  it('[AUTH-060] an accepted invitation is never expired: after a week with no signal it is reported unresolved', async () => {
    const { p, batch } = await sentPerson();
    // Accepted by a member whose address is private: nothing links it to the person.
    org().invitations = org().invitations.filter((i) => i.email !== p.email);
    github().state.addUser({ login: `${p.login}-private` });
    github().state.addMember('acme', `${p.login}-private`);
    nowMs += 8 * DAY;
    const generation = await staleGeneration();
    await inventory(TARGET);
    await inventory(TARGET);
    expect(await itemOf(batch.id, p.id)).toMatchObject({ status: 'sent', error: 'unresolved' });
    expect((await mappingOf(p.id)).status).toBe('pending_invite');
    expect(await staleGeneration()).toBe(generation);
  });

  it('[AUTH-060] without autoConfirmEmail a matching member is offered, not linked, and never called expired', async () => {
    const { p, batch } = await sentPerson();
    const route = await db().route.findUniqueOrThrow({ where: { id: ROUTE } });
    await db().route.update({
      where: { id: ROUTE },
      data: { policies: { identityMatch: { autoConfirmEmail: false } } },
    });
    try {
      accept(p.email as string, `${p.login}-quiet`);
      nowMs += 8 * DAY;
      await inventory(TARGET);
      expect((await itemOf(batch.id, p.id)).status).toBe('sent');
      expect((await mappingOf(p.id)).status).toBe('pending_invite');
    } finally {
      await db().route.update({
        where: { id: ROUTE },
        data: { policies: route.policies as Record<string, never> },
      });
    }
  });

  it('[AUTH-060] revoking an invitation the provider no longer has links a member who accepted it', async () => {
    const { p, batch, item } = await sentPerson();
    org().invitations = org().invitations.filter((i) => i.email !== p.email);
    // The member is known to the inventory but the correlation has not linked it yet.
    await db().identity.create({
      data: {
        endpointId: TARGET,
        providerId: `member-${p.login}`,
        login: `${p.login}-here`,
        email: p.email,
        kind: 'user',
        isMember: true,
      },
    });
    const result = await runInvitationRevoke(deps(), batch.id, item.id, {
      shutdown: shutdown.signal,
    });
    expect(result).toMatchObject({ cancelled: false });
    expect(await itemOf(batch.id, p.id)).toMatchObject({ status: 'accepted' });
    expect((await mappingOf(p.id)).status).toBe('confirmed');
  });

  it('[AUTH-060] revoking an invitation the provider no longer has, with no member, expires it and the batch is partial', async () => {
    const { p, batch, item } = await sentPerson();
    org().invitations = org().invitations.filter((i) => i.email !== p.email);
    await runInvitationRevoke(deps(), batch.id, item.id, { shutdown: shutdown.signal });
    expect(await itemOf(batch.id, p.id)).toMatchObject({
      status: 'expired',
      error: 'revoked_not_found',
    });
    expect((await mappingOf(p.id)).status).toBe('unmapped');
    expect((await db().invitationBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe(
      'partial',
    );
  });

  it('[AUTH-060] two members sharing the invited address are never linked automatically, by the inventory or by revoke', async () => {
    const { p, batch, item } = await sentPerson();
    org().invitations = org().invitations.filter((i) => i.email !== p.email);
    for (const suffix of ['one', 'two']) {
      await db().identity.create({
        data: {
          endpointId: TARGET,
          providerId: `member-${p.login}-${suffix}`,
          login: `${p.login}-${suffix}`,
          email: p.email,
          kind: 'user',
          isMember: true,
        },
      });
    }
    await inventory(TARGET);
    expect((await itemOf(batch.id, p.id)).status).toBe('sent');
    expect((await mappingOf(p.id)).status).toBe('pending_invite');
    await runInvitationRevoke(deps(), batch.id, item.id, { shutdown: shutdown.signal });
    expect(await itemOf(batch.id, p.id)).toMatchObject({
      status: 'expired',
      error: 'revoked_not_found',
    });
  });

  it('[AUTH-060] revoking withdraws the invitation and returns the person to candidates', async () => {
    const { p, batch, item } = await sentPerson();
    const result = await runInvitationRevoke(deps(), batch.id, item.id, {
      shutdown: shutdown.signal,
    });
    expect(result).toMatchObject({ cancelled: true });
    expect(pendingEmails()).not.toContain(p.email);
    expect(await itemOf(batch.id, p.id)).toMatchObject({ status: 'expired', error: 'revoked' });
    expect((await mappingOf(p.id)).status).toBe('unmapped');
    // A second revoke finds nothing to do.
    expect(
      await runInvitationRevoke(deps(), batch.id, item.id, { shutdown: shutdown.signal }),
    ).toMatchObject({ skipped: 'not-sent' });
  });

  it('[AUTH-060] an inventory pass schedules the send step of an approved batch again', async () => {
    const p = await person();
    const batch = await draft([p.id]);
    await approve(batch.id);
    scheduled.length = 0;
    await inventory(TARGET);
    expect(scheduled).toContainEqual({ step: { step: 'send', batchId: batch.id }, delayMs: 0 });
  });
});

describe('the job handler', () => {
  it('[AUTH-060] dispatches the seats, send and revoke steps of the invitations.batch job', async () => {
    const p = await person();
    const batch = await draft([p.id]);
    const handler = invitationHandlers(deps())['invitations.batch'];
    if (!handler) throw new Error('the handler is not registered');
    const ctx = { shutdown: shutdown.signal } as never;
    expect(await handler({ step: 'send', batchId: batch.id }, ctx)).toMatchObject({
      skipped: 'not-approved',
    });
    expect(await handler({ step: 'seats', batchId: batch.id }, ctx)).toMatchObject({ read: true });
    const item = await itemOf(batch.id, p.id);
    expect(
      await handler({ step: 'revoke', batchId: batch.id, invitationId: item.id }, ctx),
    ).toMatchObject({ skipped: 'not-sent' });
  });
});

describe('at most one outstanding invitation per person and per address', () => {
  const post = async (batchId: string) => {
    await approve(batchId);
    return send(batchId);
  };
  const countFor = (email: string) =>
    org().invitations.filter((i) => i.email?.toLowerCase() === email.toLowerCase()).length;

  it('[AUTH-061] a person in a second batch cannot be reselected in the first; one invitation is sent', async () => {
    const p = await person();
    const a = await draft([p.id]);
    const itemA = await itemOf(a.id, p.id);
    await deselectItem(t.db, a.id, itemA.id, 'later', { actorId: operator, now: now() });
    const b = await draft([p.id]);
    await expect(selectItem(t.db, a.id, itemA.id, { actorId: operator })).rejects.toMatchObject({
      status: 409,
    });
    // The database says the same, whoever writes.
    await expect(
      t.db.pool.query("UPDATE app.invitation SET status = 'selected' WHERE id = $1", [itemA.id]),
    ).rejects.toThrow(/invitation_outstanding_person_key/);
    const [first, second] = await Promise.all([
      approve(a.id).then(
        () => 'ok',
        () => 'refused',
      ),
      post(b.id).then(
        () => 'ok',
        () => 'refused',
      ),
    ]);
    expect([first, second]).toContain('ok');
    expect(countFor(p.email as string)).toBe(1);
  });

  it('[AUTH-061] the database refuses a second outstanding item for a person, by any writer', async () => {
    const p = await person();
    await draft([p.id]);
    const other = await person();
    const second = await draft([other.id]);
    await expect(
      t.db.pool.query(
        "INSERT INTO app.invitation (id, batch_id, source_identity_id, email, team_slugs, updated_at) VALUES ($1, $2, $3, $4, '{}', now())",
        [`manual-${counter}`, second.id, p.id, p.email],
      ),
    ).rejects.toThrow(/invitation_outstanding_person_key/);
  });

  it('[AUTH-061] the same address under two identities, even in another case, is invited once', async () => {
    const one = await person();
    const two = await person();
    await db().identity.update({
      where: { id: one.id },
      data: { email: 'Shared.Pair@Acme.example' },
    });
    await db().identity.update({
      where: { id: two.id },
      data: { email: 'shared.pair@acme.example ' },
    });
    await expect(draft([one.id, two.id])).rejects.toMatchObject({ status: 422 });
    const first = await draft([one.id]);
    // The second identity is no longer a candidate, and cannot be drafted.
    const list = await listCandidates(db(), ROUTE, { limit: 200 });
    expect(list.rows.map((r) => r.identity.id)).not.toContain(two.id);
    await expect(draft([two.id])).rejects.toMatchObject({ status: 422 });
    await post(first.id);
    expect(countFor('shared.pair@acme.example')).toBe(1);
    // Still not a candidate while the invitation is outstanding (sent).
    const after = await listCandidates(db(), ROUTE, { limit: 200 });
    expect(after.rows.map((r) => r.identity.id)).not.toContain(two.id);
    expect(after.rows.map((r) => r.identity.id)).not.toContain(one.id);
    // The database backstop, for a writer that skips the API.
    const third = await person();
    await db().identity.update({
      where: { id: third.id },
      data: { email: 'SHARED.pair@acme.example' },
    });
    const draftBatch = await draft([(await person()).id]);
    await expect(
      t.db.pool.query(
        "INSERT INTO app.invitation (id, batch_id, source_identity_id, email, team_slugs, updated_at) VALUES ($1, $2, $3, $4, '{}', now())",
        [`manual-addr-${counter}`, draftBatch.id, third.id, 'SHARED.pair@acme.example'],
      ),
    ).rejects.toThrow(/invitation_outstanding_address_key/);
  });

  it('[AUTH-061] a person with an outstanding invitation is not a candidate and cannot be drafted again', async () => {
    const p = await person();
    await post((await draft([p.id])).id);
    const list = await listCandidates(db(), ROUTE, { limit: 200 });
    expect(list.rows.map((r) => r.identity.id)).not.toContain(p.id);
    await expect(draft([p.id])).rejects.toMatchObject({ status: 422 });
    // Forcing the mapping back does not help: the outstanding item still holds the person.
    await db().identityMapping.updateMany({
      where: { routeId: ROUTE, sourceIdentityId: p.id },
      data: { status: 'unmapped' },
    });
    const forced = await listCandidates(db(), ROUTE, { limit: 200 });
    expect(forced.rows.map((r) => r.identity.id)).not.toContain(p.id);
    expect(countFor(p.email as string)).toBe(1);
  });

  it('[AUTH-061] a suggested person is not invited: dropped at approval, refused at drafting', async () => {
    const p = await person();
    const q = await person();
    const batch = await draft([p.id, q.id]);
    await db().identityMapping.updateMany({
      where: { routeId: ROUTE, sourceIdentityId: p.id },
      data: { status: 'suggested' },
    });
    expect(await approve(batch.id)).toMatchObject({ approved: 1, dropped: 1 });
    const result = await send(batch.id);
    expect(result).toMatchObject({ sent: 1 });
    expect(countFor(p.email as string)).toBe(0);
    await expect(draft([p.id])).rejects.toMatchObject({ status: 422 });
  });

  it('[AUTH-061] a changed selection is refused at approval by its token', async () => {
    const a = await person();
    const b = await person();
    const batch = await draft([a.id, b.id]);
    const token = batch.selectionToken;
    await deselectItem(t.db, batch.id, (await itemOf(batch.id, b.id)).id, 'changed', {
      actorId: operator,
      now: now(),
    });
    await expect(
      approveBatch(t.db, batch.id, { expectedToken: token }, { actorId: operator }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await db().invitationBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe(
      'draft',
    );
  });

  /** A send whose call reached the provider but was never recorded (a crash after the call). */
  async function crashedAfterCall(count = 1) {
    const people = [];
    for (let i = 0; i < count; i++) people.push(await person());
    const batch = await draft(people.map((p) => p.id));
    await approve(batch.id);
    await expect(
      send(batch.id, {
        afterProviderCall: () => {
          throw new Error('connection lost after the call');
        },
      }),
    ).rejects.toThrow(/connection lost/);
    return { people, batch };
  }

  it('[AUTH-061] PROBE-U: after an unknown outcome the person and the address stay held and nothing is posted again', async () => {
    const { people, batch } = await crashedAfterCall();
    const p = people[0] as Awaited<ReturnType<typeof person>>;
    // The invitation exists at the provider but the lookup will not see it (it was withdrawn).
    org().invitations = org().invitations.filter((i) => i.email !== p.email);
    const callsBefore = inviteCalls;
    const logBefore = org().invitationLog.length;
    const result = await send(batch.id);
    expect(result).toMatchObject({ sent: 0, failed: 1, batchStatus: 'partial' });
    expect(await itemOf(batch.id, p.id)).toMatchObject({
      status: 'unknown',
      error: 'unknown_outcome',
    });
    // Still held: the mapping stays pending_invite.
    expect((await mappingOf(p.id)).status).toBe('pending_invite');
    // Not a candidate; not draftable; neither is a second identity with the same address.
    const list = await listCandidates(db(), ROUTE, { limit: 200 });
    expect(list.rows.map((r) => r.identity.id)).not.toContain(p.id);
    await expect(draft([p.id])).rejects.toMatchObject({ status: 422 });
    const twin = await person();
    await db().identity.update({
      where: { id: twin.id },
      data: { email: `  ${(p.email as string).toUpperCase()}` },
    });
    await expect(draft([twin.id])).rejects.toMatchObject({ status: 422 });
    // The database agrees, for any writer.
    const other = await draft([(await person()).id]);
    await expect(
      t.db.pool.query(
        "INSERT INTO app.invitation (id, batch_id, source_identity_id, email, team_slugs, updated_at) VALUES ($1, $2, $3, $4, '{}', now())",
        [`manual-unknown-${counter}`, other.id, twin.id, p.email],
      ),
    ).rejects.toThrow(/invitation_outstanding_address_key/);
    // Running the job again changes nothing and posts nothing.
    expect(await send(batch.id)).toMatchObject({ sent: 0 });
    expect(inviteCalls).toBe(callsBefore);
    expect(org().invitationLog.length).toBe(logBefore);
  });

  it('[AUTH-061] an operator resolves an unknown outcome: invited keeps the person held, not invited frees them', async () => {
    const first = await crashedAfterCall();
    const a = first.people[0] as Awaited<ReturnType<typeof person>>;
    org().invitations = org().invitations.filter((i) => i.email !== a.email);
    await send(first.batch.id);
    const itemA = await itemOf(first.batch.id, a.id);
    expect(itemA.status).toBe('unknown');
    const by = { actorId: operator, now: now() };
    expect(await resolveItem(t.db, first.batch.id, itemA.id, 'invited', by)).toBe('sent');
    expect((await mappingOf(a.id)).status).toBe('pending_invite');
    await expect(draft([a.id])).rejects.toMatchObject({ status: 422 });

    const second = await crashedAfterCall();
    const b = second.people[0] as Awaited<ReturnType<typeof person>>;
    org().invitations = org().invitations.filter((i) => i.email !== b.email);
    await send(second.batch.id);
    const itemB = await itemOf(second.batch.id, b.id);
    const generation = await staleGeneration();
    expect(await resolveItem(t.db, second.batch.id, itemB.id, 'not_invited', by)).toBe('failed');
    expect((await mappingOf(b.id)).status).toBe('unmapped');
    expect(await staleGeneration()).toBeGreaterThan(generation);
    expect((await draft([b.id])).counts.selected).toBe(1);
    await expect(
      resolveItem(t.db, second.batch.id, itemB.id, 'not_invited', by),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('[AUTH-061] PROBE-L: a rate limit in the retry lookup keeps the claim and posts nothing', async () => {
    const { people, batch } = await crashedAfterCall();
    const p = people[0] as Awaited<ReturnType<typeof person>>;
    lookupFault = new AdapterError({
      code: 'rate_limited',
      provider: 'test',
      message: 'limit',
      retryAfterMs: 60_000,
      retryAt: new Date(nowMs + 60_000),
    });
    scheduled.length = 0;
    const callsBefore = inviteCalls;
    const result = await send(batch.id);
    expect(result).toMatchObject({ sent: 0, remaining: 1 });
    expect(result.retryAt).toBeDefined();
    expect(scheduled).toHaveLength(1);
    const item = await itemOf(batch.id, p.id);
    expect(item.status).toBe('selected');
    expect(item.sendStartedAt).not.toBeNull();
    expect((await mappingOf(p.id)).status).toBe('pending_invite');
    expect(inviteCalls).toBe(callsBefore);
    // After the wait the lookup works, finds the invitation and records it; still no new post.
    lookupFault = undefined;
    nowMs += 120_000;
    expect(await send(batch.id)).toMatchObject({ sent: 1, batchStatus: 'sent' });
    expect(inviteCalls).toBe(callsBefore);
    expect(org().invitations.filter((i) => i.email === p.email)).toHaveLength(1);
  });

  it('[AUTH-061] PROBE-L: any other fault in the retry lookup is retried by the job and keeps the claim', async () => {
    const { people, batch } = await crashedAfterCall();
    const p = people[0] as Awaited<ReturnType<typeof person>>;
    lookupFault = new AdapterError({ code: 'forbidden', provider: 'test', message: 'no access' });
    const callsBefore = inviteCalls;
    await expect(send(batch.id)).rejects.toMatchObject({ code: 'forbidden' });
    const item = await itemOf(batch.id, p.id);
    expect(item.status).toBe('selected');
    expect(item.sendStartedAt).not.toBeNull();
    expect((await mappingOf(p.id)).status).toBe('pending_invite');
    expect(inviteCalls).toBe(callsBefore);
    // Even repeated failures never post.
    await expect(send(batch.id)).rejects.toMatchObject({ code: 'forbidden' });
    expect(inviteCalls).toBe(callsBefore);
    lookupFault = undefined;
    expect(await send(batch.id)).toMatchObject({ sent: 1 });
    expect(inviteCalls).toBe(callsBefore);
  });

  it('[AUTH-061] a retry that finds the invitee among the members links them and does not invite', async () => {
    const { people, batch } = await crashedAfterCall();
    const p = people[0] as Awaited<ReturnType<typeof person>>;
    // The invitee accepted before the retry: no pending invitation, a member with that address.
    org().invitations = org().invitations.filter((i) => i.email !== p.email);
    github().state.addUser({ login: `${p.login}-joined`, email: p.email, publicEmail: p.email });
    github().state.addMember('acme', `${p.login}-joined`);
    await inventory(TARGET);
    const callsBefore = inviteCalls;
    expect(await send(batch.id)).toMatchObject({ sent: 1 });
    expect(inviteCalls).toBe(callsBefore);
    expect(await itemOf(batch.id, p.id)).toMatchObject({ status: 'accepted' });
    expect((await mappingOf(p.id)).status).toBe('confirmed');
  });

  it('[AUTH-061] the database guards the batch lifecycle and the item states', async () => {
    const p = await person();
    const batch = await draft([p.id]);
    await post(batch.id);
    const item = await itemOf(batch.id, p.id);
    const q = (sql: string, args: unknown[]) => t.db.pool.query(sql, args);
    // A finished batch cannot be reopened; an item cannot become selected outside a draft.
    await expect(
      q("UPDATE app.invitation_batch SET status = 'approved' WHERE id = $1", [batch.id]),
    ).rejects.toThrow();
    await q("UPDATE app.invitation SET status = 'failed' WHERE id = $1", [item.id]);
    await expect(
      q("UPDATE app.invitation SET status = 'selected' WHERE id = $1", [item.id]),
    ).rejects.toThrow(/cannot be edited/);
    // The Route of a batch is frozen.
    await expect(
      q("UPDATE app.invitation_batch SET route_id = 'other-route' WHERE id = $1", [batch.id]),
    ).rejects.toThrow();
    // A batch starts as a draft without an approval.
    await expect(
      q(
        "INSERT INTO app.invitation_batch (id, route_id, status, seat_preview, created_by_id, approved_by_id, approved_at, updated_at) VALUES ('forged', $1, 'approved', '{}', $2, $2, now(), now())",
        [ROUTE, operator],
      ),
    ).rejects.toThrow(/starts as a draft/);
    // A batch that started sending cannot go back to approved.
    const other = await person();
    const second = await draft([other.id]);
    await approve(second.id);
    await q("UPDATE app.invitation_batch SET status = 'sending' WHERE id = $1", [second.id]);
    await expect(
      q("UPDATE app.invitation_batch SET status = 'approved' WHERE id = $1", [second.id]),
    ).rejects.toThrow(/sending/);
  });
});

describe('an invitation the system cannot account for is never taken for another', () => {
  type Person = Awaited<ReturnType<typeof person>>;
  /** A send whose call reached the provider but whose response was lost. */
  async function lostResponse(people: Person[]) {
    const batch = await draft(people.map((p) => p.id));
    await approve(batch.id);
    await expect(
      send(batch.id, {
        afterProviderCall: () => {
          throw new Error('response lost');
        },
      }),
    ).rejects.toThrow(/response lost/);
    return batch;
  }
  /** The provider's pending list misses the invitation for `email`; it is returned for later. */
  const hideFromPending = (email: string) => {
    const hidden = org().invitations.filter((i) => i.email === email);
    org().invitations = org().invitations.filter((i) => i.email !== email);
    return hidden;
  };
  /** An entry resolved `invited` by an operator: `sent`, with no provider id. */
  async function resolvedInvited() {
    const p = await person();
    const batch = await lostResponse([p]);
    const hidden = hideFromPending(p.email as string);
    await send(batch.id);
    const item = await itemOf(batch.id, p.id);
    expect(item.status).toBe('unknown');
    await resolveItem(t.db, batch.id, item.id, 'invited', { actorId: operator, now: now() });
    expect(await itemOf(batch.id, p.id)).toMatchObject({
      status: 'sent',
      providerInvitationId: null,
    });
    return { p, batch, item, hidden };
  }

  it('[AUTH-061] PROBE-A: a retry never takes an older failed invitation of the address as its own', async () => {
    const p = await person();
    const first = await draft([p.id]);
    await approve(first.id);
    await send(first.id);
    const old = org().invitations.find((i) => i.email === p.email);
    if (!old) throw new Error('the invitation is missing');
    // The first invitation runs out; the inventory expires it and frees the person.
    old.expiresAt = Date.now() - 1000;
    await inventory(TARGET);
    expect((await itemOf(first.id, p.id)).status).toBe('expired');
    expect((await mappingOf(p.id)).status).toBe('unmapped');

    // Re-drafted: the new POST succeeds, its response is lost, and the pending list misses it,
    // while the failed list still holds the old invitation for the address.
    const second = await lostResponse([p]);
    hideFromPending(p.email as string);
    const calls = inviteCalls;
    const log = org().invitationLog.length;
    await send(second.id);
    expect(await itemOf(second.id, p.id)).toMatchObject({
      status: 'unknown',
      providerInvitationId: null,
    });
    expect((await mappingOf(p.id)).status).toBe('pending_invite');
    // The inventory cannot expire what was never recorded; the person stays held.
    await inventory(TARGET);
    expect((await itemOf(second.id, p.id)).status).toBe('unknown');
    expect((await mappingOf(p.id)).status).toBe('pending_invite');
    await expect(draft([p.id])).rejects.toMatchObject({ status: 422 });
    expect(await send(second.id)).toMatchObject({ sent: 0 });
    // Counted on the writer: nothing was even attempted, so no provider dedup was involved.
    expect(inviteCalls).toBe(calls);
    expect(org().invitationLog.length).toBe(log);
  });

  it('[AUTH-061] a retry ignores a failed invitation of the address created before its first attempt', async () => {
    const p = await person();
    const batch = await lostResponse([p]);
    hideFromPending(p.email as string);
    // An invitation for the same address that failed days ago, recorded on no entry.
    const created = Date.now() - 3 * DAY;
    org().expiredInvitations.push({
      id: 990_000 + counter,
      nodeId: `OI_old_${counter}`,
      login: null,
      email: p.email,
      role: 'direct_member',
      teamIds: [],
      inviter: 'someone',
      createdAt: created,
      expiresAt: created + DAY,
      failedAt: created + DAY,
      failedReason: 'Invitation expired',
    });
    const calls = inviteCalls;
    await send(batch.id);
    expect(await itemOf(batch.id, p.id)).toMatchObject({
      status: 'unknown',
      error: 'unknown_outcome',
      providerInvitationId: null,
    });
    expect((await mappingOf(p.id)).status).toBe('pending_invite');
    expect(inviteCalls).toBe(calls);
  });

  it('[AUTH-061] PROBE-B: a retried claim whose mapping changed is held, and the shared address is not invited again', async () => {
    const x = await person();
    const y = await person();
    await db().identity.update({
      where: { id: y.id },
      data: { email: (x.email as string).toUpperCase() },
    });
    const batch = await lostResponse([x]);
    hideFromPending(x.email as string);
    // The mapping is decided under the retried claim (any writer).
    await db().identityMapping.updateMany({
      where: { routeId: ROUTE, sourceIdentityId: x.id },
      data: { status: 'excluded', method: 'manual' },
    });
    const calls = inviteCalls;
    const log = org().invitationLog.length;
    const result = await send(batch.id);
    expect(result).toMatchObject({ sent: 0, failed: 1, batchStatus: 'partial' });
    expect(await itemOf(batch.id, x.id)).toMatchObject({
      status: 'unknown',
      error: 'mapping_excluded',
    });
    // The address stays held: the other person with it is neither a candidate nor draftable.
    const list = await listCandidates(db(), ROUTE, { limit: 200 });
    expect(list.rows.map((r) => r.identity.id)).not.toContain(y.id);
    await expect(draft([y.id])).rejects.toMatchObject({ status: 422 });
    expect(inviteCalls).toBe(calls);
    expect(org().invitationLog.length).toBe(log);
  });

  it('[AUTH-061] a retried claim whose mapping changed still records the invitation it finds', async () => {
    const x = await person();
    const batch = await lostResponse([x]);
    await db().identityMapping.updateMany({
      where: { routeId: ROUTE, sourceIdentityId: x.id },
      data: { status: 'excluded', method: 'manual' },
    });
    const calls = inviteCalls;
    expect(await send(batch.id)).toMatchObject({ sent: 1 });
    const item = await itemOf(batch.id, x.id);
    expect(item.status).toBe('sent');
    expect(item.providerInvitationId).toBe(
      String(org().invitations.find((i) => i.email === x.email)?.id),
    );
    expect(inviteCalls).toBe(calls);
  });

  it('[AUTH-061] an entry resolved as invited is accepted by the inventory when its invitee joins', async () => {
    const { p, batch } = await resolvedInvited();
    github().state.addUser({ login: `${p.login}-gh`, email: p.email, publicEmail: p.email });
    github().state.addMember('acme', `${p.login}-gh`);
    await inventory(TARGET);
    expect((await itemOf(batch.id, p.id)).status).toBe('accepted');
    expect((await mappingOf(p.id)).status).toBe('confirmed');
  });

  it('[AUTH-061] an entry resolved as invited finds its own invitation at the inventory, then expires with it', async () => {
    const { p, batch, hidden } = await resolvedInvited();
    org().invitations.push(...hidden);
    await inventory(TARGET);
    const item = await itemOf(batch.id, p.id);
    expect(item.status).toBe('sent');
    expect(item.providerInvitationId).toBe(String(hidden[0]?.id));
    const inv = org().invitations.find((i) => i.email === p.email);
    if (!inv) throw new Error('the invitation is missing');
    inv.failedAt = Date.now();
    inv.failedReason = 'Unable to send email';
    await inventory(TARGET);
    expect(await itemOf(batch.id, p.id)).toMatchObject({
      status: 'expired',
      error: 'failed:other',
    });
    expect((await mappingOf(p.id)).status).toBe('unmapped');
  });

  it('[AUTH-061] an entry resolved as invited whose invitation failed is expired by the inventory', async () => {
    const { p, batch, hidden } = await resolvedInvited();
    const inv = hidden[0];
    if (!inv) throw new Error('the invitation is missing');
    org().expiredInvitations.push({
      ...inv,
      failedAt: Date.now(),
      failedReason: 'Invitation expired',
    });
    await inventory(TARGET);
    expect(await itemOf(batch.id, p.id)).toMatchObject({
      status: 'expired',
      error: 'failed:expired',
      providerInvitationId: String(inv.id),
    });
  });

  it('[AUTH-061] an entry resolved as invited with no signal is reported unresolved, and stays held', async () => {
    const { p, batch } = await resolvedInvited();
    nowMs += 8 * DAY;
    await inventory(TARGET);
    expect(await itemOf(batch.id, p.id)).toMatchObject({ status: 'sent', error: 'unresolved' });
    expect((await mappingOf(p.id)).status).toBe('pending_invite');
  });

  it('[AUTH-061] revoking an entry without a provider id cancels its own invitation found by address', async () => {
    const { p, batch, item, hidden } = await resolvedInvited();
    org().invitations.push(...hidden);
    const result = await runInvitationRevoke(deps(), batch.id, item.id, {
      shutdown: shutdown.signal,
    });
    expect(result).toMatchObject({ cancelled: true });
    expect(pendingEmails()).not.toContain(p.email);
    expect(await itemOf(batch.id, p.id)).toMatchObject({
      status: 'expired',
      error: 'revoked',
      providerInvitationId: String(hidden[0]?.id),
    });
    expect((await mappingOf(p.id)).status).toBe('unmapped');
  });

  it('[AUTH-061] revoking an entry without a provider id and nothing to cancel takes the member check', async () => {
    const { p, batch, item } = await resolvedInvited();
    expect(
      await runInvitationRevoke(deps(), batch.id, item.id, { shutdown: shutdown.signal }),
    ).toMatchObject({ cancelled: false });
    expect(await itemOf(batch.id, p.id)).toMatchObject({
      status: 'expired',
      error: 'revoked_not_found',
    });

    const joined = await resolvedInvited();
    await db().identity.create({
      data: {
        endpointId: TARGET,
        providerId: `member-${joined.p.login}`,
        login: `${joined.p.login}-here`,
        email: joined.p.email,
        kind: 'user',
        isMember: true,
      },
    });
    await runInvitationRevoke(deps(), joined.batch.id, joined.item.id, {
      shutdown: shutdown.signal,
    });
    expect((await itemOf(joined.batch.id, joined.p.id)).status).toBe('accepted');
    expect((await mappingOf(joined.p.id)).status).toBe('confirmed');
  });
});

describe('one target organization, several Routes', () => {
  /** The person's mapping on the second Route, `unmapped` (inventory may have created it). */
  async function onSecondRoute(identityId: string) {
    const existing = await db().identityMapping.findFirst({
      where: { routeId: ROUTE_2, sourceIdentityId: identityId },
    });
    if (existing) {
      await db().identityMapping.update({
        where: { id: existing.id },
        data: { status: 'unmapped', targetIdentityId: null, method: null },
      });
    } else {
      await db().identityMapping.create({
        data: { routeId: ROUTE_2, sourceIdentityId: identityId, status: 'unmapped' },
      });
    }
  }
  const draftOn2 = (ids: string[]) =>
    createBatch(t.db, ROUTE_2, { identityIds: ids }, { actorId: operator, now: now() });
  /** The problem body a refused call answers with. */
  async function problemOf(call: Promise<unknown>) {
    const error = await call.then(
      () => {
        throw new Error('the call was not refused');
      },
      (e: { status?: number; getResponse?: () => Response }) => e,
    );
    const body = (await error.getResponse?.().json()) as {
      detail?: string;
      errors?: { message: string }[];
    };
    return { status: error.status, ...body };
  }
  const candidatesOn2 = async () =>
    (await listCandidates(db(), ROUTE_2, { limit: 1000 })).rows.map((r) => r.identity.id);

  it('[AUTH-061] PROBE-C: one person on two Routes to the same organization is invited once', async () => {
    const p = await person();
    await onSecondRoute(p.id);
    const first = await draft([p.id]);
    await approve(first.id);
    await send(first.id);
    expect(inviteCalls).toBe(1);
    // The other Route sees the person as held, and names the batch that holds them.
    expect(await candidatesOn2()).not.toContain(p.id);
    const refused = await problemOf(draftOn2([p.id]));
    expect(refused.status).toBe(422);
    expect(refused.errors?.[0]?.message).toContain(`Route ${ROUTE}, batch ${first.id}`);
    // The database agrees, for any writer.
    const q = await person();
    await onSecondRoute(q.id);
    const other = await draftOn2([q.id]);
    await expect(
      t.db.pool.query(
        "INSERT INTO app.invitation (id, batch_id, source_identity_id, email, team_slugs, updated_at) VALUES ($1, $2, $3, $4, '{}', now())",
        [`cross-route-${counter}`, other.id, p.id, `other-${counter}@acme.example`],
      ),
    ).rejects.toThrow(/invitation_outstanding_person_key/);
    expect(inviteCalls).toBe(1);
    expect(org().invitations.filter((i) => i.email === p.email)).toHaveLength(1);
  });

  it('[AUTH-061] one address under two people on two Routes to the same organization is invited once', async () => {
    const x = await person();
    const y = await person();
    await db().identity.update({
      where: { id: y.id },
      data: { email: ` ${(x.email as string).toUpperCase()}` },
    });
    await onSecondRoute(y.id);
    // y is drafted on the second Route, then left out, so x can be drafted on the first one.
    const second = await draftOn2([y.id]);
    const itemY = await itemOf(second.id, y.id);
    await deselectItem(t.db, second.id, itemY.id, 'later', { actorId: operator, now: now() });
    const first = await draft([x.id]);
    await approve(first.id);
    await send(first.id);
    // Reselecting y is refused and names the batch that holds the address.
    const refused = await problemOf(
      selectItem(t.db, second.id, itemY.id, { actorId: operator, now: now() }),
    );
    expect(refused.status).toBe(409);
    expect(refused.detail).toContain(`Route ${ROUTE}, batch ${first.id}`);
    expect(await candidatesOn2()).not.toContain(y.id);
    await expect(draftOn2([y.id])).rejects.toMatchObject({ status: 422 });
    expect(inviteCalls).toBe(1);
  });

  it('[AUTH-061] drafts on two Routes to the same organization at once: only one holds the address', async () => {
    const x = await person();
    const y = await person();
    await db().identity.update({ where: { id: y.id }, data: { email: x.email } });
    await onSecondRoute(y.id);
    const results = await Promise.allSettled([draft([x.id]), draftOn2([y.id])]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('[AUTH-061] a revoke on one Route frees the person for the other, with no ghost entry left behind', async () => {
    const p = await person();
    await onSecondRoute(p.id);
    const first = await draft([p.id]);
    await approve(first.id);
    await send(first.id);
    const item = await itemOf(first.id, p.id);
    await runInvitationRevoke(deps(), first.id, item.id, { shutdown: shutdown.signal });
    expect(await itemOf(first.id, p.id)).toMatchObject({ status: 'expired', error: 'revoked' });
    expect(org().invitations.filter((i) => i.email === p.email)).toHaveLength(0);

    const second = await draftOn2([p.id]);
    const selected = await db().invitation.findMany({
      where: { batchId: second.id, status: 'selected' },
      select: { id: true },
    });
    await approveBatch(
      t.db,
      second.id,
      { expectedToken: selectionToken(selected.map((i) => i.id)) },
      { actorId: operator, now: now() },
    );
    expect(await send(second.id)).toMatchObject({ sent: 1 });
    // One invitation at the provider, one outstanding entry across both Routes.
    expect(org().invitations.filter((i) => i.email === p.email)).toHaveLength(1);
    const outstanding = await db().invitation.findMany({
      where: { sourceIdentityId: p.id, status: { in: ['selected', 'sent', 'unknown'] } },
    });
    expect(outstanding.map((i) => i.routeId)).toEqual([ROUTE_2]);
    expect(inviteCalls).toBe(2);
  });

  it('[AUTH-061] an entry keeps the organization it was drafted for when its Route moves', async () => {
    const p = await person();
    const batch = await draft([p.id]);
    const item = await itemOf(batch.id, p.id);
    expect(item.targetEndpointId).toBe(TARGET);
    // A writer cannot move it.
    await expect(
      t.db.pool.query('UPDATE app.invitation SET target_endpoint_id = $1 WHERE id = $2', [
        SOURCE,
        item.id,
      ]),
    ).resolves.toBeDefined();
    expect((await itemOf(batch.id, p.id)).targetEndpointId).toBe(TARGET);
    const q = await person();
    const approved = await draft([q.id]);
    await approve(approved.id);
    // The Route now targets another Endpoint: entries drafted for the old organization are never
    // sent to the new one. A draft drops them at approval; an approved batch fails them unsent.
    await db().route.update({ where: { id: ROUTE }, data: { targetEndpointId: SOURCE } });
    try {
      expect((await problemOf(approve(batch.id))).status).toBe(409);
      expect((await itemOf(batch.id, p.id)).status).toBe('selected');
      await send(approved.id);
      expect(await itemOf(approved.id, q.id)).toMatchObject({
        status: 'failed',
        error: 'target_changed',
      });
    } finally {
      await db().route.update({ where: { id: ROUTE }, data: { targetEndpointId: TARGET } });
    }
    expect(inviteCalls).toBe(0);
  });
});
