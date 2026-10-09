/**
 * T-096, TST-020: the "additional integration scenarios" that no other file of this tier covers,
 * driven through the same composition roots as the Phase-1 scenario (`stack.ts`): the real API, the
 * real worker, BullMQ-on-Postgres and the TST-012 fakes (TST-006). The other scenarios of the list
 * live in the files named by the coverage table in `testing/integration/README.md`.
 *
 * - secrets post-task completion leading to verified (`plat/with-secrets`, LIF-061, LIF-062);
 * - an invitation batch with a deselection, plus parity (AUTH-060, AUTH-061);
 * - SSE events emitted for a Run (JOB-060);
 * - the quota ledger throttling with the fake's 429 (JOB-044, JOB-045).
 */
import { formatFieldPath, itemSeg, matchesPattern } from '@git-migrator/core';
import { WORLD_ORG } from '@git-migrator/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTE, SOURCE, type Stack, startStack, TARGET, until } from './stack.ts';

let s: Stack;

beforeAll(async () => {
  s = await startStack('t096');
  await s.prepare();
}, 480_000);

afterAll(async () => {
  await s?.close();
}, 120_000);

interface Frame {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/** Reads an SSE body in the background and keeps the frames it has seen. */
function collect(response: Response): {
  frames: Frame[];
  /** Cancels the read and waits (bounded) for the reader loop to end. */
  stop: () => Promise<void>;
} {
  const frames: Frame[] = [];
  const decoder = new TextDecoder();
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const done = (async () => {
    let buffer = '';
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event !== undefined && data !== undefined) {
          frames.push({ event, data: JSON.parse(data) as Record<string, unknown> });
        }
      }
    }
  })();
  const stop = async () => {
    await reader.cancel().catch(() => undefined);
    await Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  };
  return { frames, stop };
}

/** The Migration of a repository, migrated by a Run of its own when it has not been yet. */
async function migrated(key: string) {
  const migration = await s.migrationOf(key);
  if (migration.status === 'analyzed') {
    const run = await s.runAndWait(migration.id, 'migrate');
    expect(run.status, `the migrate Run of ${key}`).toBe('succeeded');
    await s.idle(`the follow-up jobs of the Run of ${key}`);
  }
  return s.migrationOf(key);
}

describe('additional scenarios of TST-020', () => {
  it('[TST-020] [JOB-060] SSE events emitted for a Run: run.updated and migration.updated reach a stream subscribed to them, then the Run finishes', async () => {
    // Its own Migration, so that no other test depends on this one having run.
    const migration = await s.migrationOf('plat/auto-ok');
    expect(migration).toMatchObject({ status: 'analyzed', readiness: 'ready' });

    const abort = new AbortController();
    const response = await s.open(
      `/api/v1/events?topics=${encodeURIComponent(`migration:${migration.id},list:migrations,list:runs`)}`,
      abort.signal,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const stream = collect(response);
    try {
      // The hub sends `resync` once its LISTEN connection is up: events from now on are not missed.
      await until(
        'the event stream to report its listener connected (resync frame)',
        () => stream.frames.some((f) => f.event === 'resync'),
        30_000,
      );
      const before = stream.frames.length;

      const run = await s.runAndWait(migration.id, 'migrate');
      expect(run.status).toBe('succeeded');
      await s.idle('the follow-up jobs of the Run');

      // The Run was subscribed through its Migration topic (a Run change reaches `migration:<id>`).
      // Events are delivered through Postgres NOTIFY after the commit: wait for the last one.
      const runEventsOf = () =>
        stream.frames
          .slice(before)
          .filter(
            (f) =>
              f.event === 'gm' &&
              f.data.type === 'run.updated' &&
              (f.data.ids as Record<string, string>).run === run.runId,
          );
      await until(
        'the last run.updated event of the Run on the stream',
        async () => {
          const finished = await s.db.privileged.run.findUniqueOrThrow({
            where: { id: run.runId },
            select: { finishedAt: true },
          });
          const last = runEventsOf().at(-1);
          return finished.finishedAt !== null && last !== undefined && last;
        },
        30_000,
      );
      const events = stream.frames.slice(before).filter((f) => f.event === 'gm');
      const types = new Set(events.map((f) => f.data.type));
      expect(types).toContain('run.updated');
      expect(types).toContain('migration.updated');
      // Events carry identifiers only (JOB-060), and name the topics that matched.
      for (const event of events) {
        expect(Object.keys(event.data).sort()).toEqual(['at', 'ids', 'topics', 'type']);
      }
      const runEvents = runEventsOf();
      // Every Run Step change publishes run.updated (JOB-060): at least one event per Step, and
      // one more for the Run itself.
      const steps = await s.db.privileged.runStep.count({ where: { runId: run.runId } });
      expect(steps).toBeGreaterThan(1);
      expect(runEvents.length).toBeGreaterThanOrEqual(steps);
      expect(runEvents[0]?.data.topics).toContain(`migration:${migration.id}`);
    } finally {
      abort.abort();
      await stream.stop();
    }
    // The sum of the waits above is at most 30 + 240 + 90 + 30 s.
  }, 600_000);

  it('[TST-020] [LIF-061] secrets post-task completion leading to verified: the Run leaves plat/with-secrets migrated with its secrets.set-value task open; once the value is set on the target, a verify Run completes the task and verifies the Migration', async () => {
    const afterRun = await migrated('plat/with-secrets');
    const migrationId = afterRun.id;
    expect(afterRun.status).toBe('migrated');
    const open = await s.db.privileged.manualTask.findMany({
      where: { migrationId, status: 'open' },
    });
    expect(open.map((t) => `${t.phase}:${t.code}`)).toEqual(['post:secrets.set-value']);
    // The name is migrated, the value is not: parity sees the secret as missing on the target.
    const before = await s.db.privileged.parityResult.findMany({
      where: { migrationId },
    });
    expect(before.filter((r) => r.status !== 'equal').map((r) => r.facetKey)).toEqual(['secrets']);

    // The operator sets the value on the target, outside the framework.
    const github = s.fakes.github;
    const repo = github?.state.repos.get(`${WORLD_ORG}/plat-with-secrets`);
    if (!github || !repo) throw new Error('the target repository of plat/with-secrets is missing');
    github.state.addSecret(repo, 'API_TOKEN');

    // A Parity Check (here a verify Run) finds the task satisfied and completes it itself (LIF-061).
    const run = await s.runAndWait(migrationId, 'verify');
    expect(run.status).toBe('succeeded');
    await s.idle('the follow-up jobs of the verify Run');
    await until('the Migration to be verified', async () =>
      (await s.migrationOf('plat/with-secrets')).status === 'verified' ? true : false,
    );

    const task = await s.db.privileged.manualTask.findUniqueOrThrow({
      where: { id: (open[0] as { id: string }).id },
    });
    expect(task).toMatchObject({
      status: 'done',
      completedById: null,
      note: 'parity.auto-completed',
    });
    expect(
      await s.db.privileged.auditEvent.count({
        where: { action: 'task.auto_complete', actorId: null },
      }),
    ).toBe(1);
    expect((await s.migrationOf('plat/with-secrets')).status).toBe('verified');
    const after = await s.db.privileged.parityResult.findMany({
      where: { migrationId: migrationId },
    });
    expect(after.filter((r) => r.status !== 'equal')).toEqual([]);
    const dashboard = await s.call('GET', '/api/v1/dashboard');
    const route = (
      dashboard.body as { routes: { routeId: string; byStatus: Record<string, number> }[] }
    ).routes.find((r) => r.routeId === ROUTE);
    expect(route?.byStatus.verified).toBeGreaterThanOrEqual(1);
  }, 240_000);

  it('[TST-020] [AUTH-060] invitation batch with a deselection, plus parity: only the selected person is invited, the deselected one is masked, and the members Facet of the endpoint Migration is equal', async () => {
    const db = s.db.privileged;
    // The fixture world has no candidates: two source people with a known e-mail and no decision.
    const people = [];
    for (const name of ['invitee-keep', 'invitee-drop']) {
      const identity = await db.identity.create({
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
      await db.identityMapping.create({
        data: { routeId: ROUTE, sourceIdentityId: identity.id, status: 'unmapped' },
      });
      people.push(identity);
    }
    const [keep, drop] = people as [(typeof people)[number], (typeof people)[number]];

    const candidates = await s.call('GET', `/api/v1/routes/${ROUTE}/invitation-candidates`);
    // The fixture world has no candidates of its own (every member matches), so these two are all.
    expect(
      (candidates.body as { items: { identity: { id: string } }[] }).items
        .map((c) => c.identity.id)
        .sort(),
    ).toEqual([keep.id, drop.id].sort());
    const created = await s.call('POST', `/api/v1/routes/${ROUTE}/invitation-batches`, {
      identityIds: [keep.id, drop.id],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const batchId = (created.body as { id: string }).id;
    const read = async () =>
      (await s.call('GET', `/api/v1/invitation-batches/${batchId}`)).body as {
        batch: { status: string; selectionToken: string };
        items: { id: string; status: string; source: { id: string } }[];
      };
    const dropItem = (await read()).items.find((i) => i.source.id === drop.id);
    const deselected = await s.call(
      'POST',
      `/api/v1/invitation-batches/${batchId}/items/${dropItem?.id}/deselect`,
      { reason: 'contractor, not joining GitHub' },
    );
    expect(deselected.body).toEqual({ status: 'deselected' });

    // Approval names the count and the token of the selection it saw (AUTH-061); sending is a job.
    const approved = await s.call('POST', `/api/v1/invitation-batches/${batchId}/approve`, {
      expectedCount: 1,
      expectedToken: (await read()).batch.selectionToken,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(202);
    await until('the batch to be sent', async () =>
      (await read()).batch.status === 'sent' ? true : false,
    );
    await s.idle('the jobs after the send');

    const invitations = s.fakes.github?.state.requireOrg(WORLD_ORG).invitations ?? [];
    expect(invitations.map((i) => i.email)).toEqual(['invitee-keep@acme.example']);
    expect((await read()).items.map((i) => [i.source.id, i.status]).sort()).toEqual(
      [
        [keep.id, 'sent'],
        [drop.id, 'deselected'],
      ].sort(),
    );
    expect(
      (await db.identityMapping.findFirstOrThrow({ where: { sourceIdentityId: keep.id } })).status,
    ).toBe('pending_invite');
    expect(
      (await db.identityMapping.findFirstOrThrow({ where: { sourceIdentityId: drop.id } })).status,
    ).toBe('unmapped');

    // Parity: the deselection is an Expected Difference of the members Facet, the invitation is not.
    const masked = await db.expectedDifference.findMany({
      where: { routeId: ROUTE, reason: 'identity_excluded', revokedAt: null, facetKey: 'members' },
    });
    const pathOf = (providerId: string) =>
      formatFieldPath([itemSeg('members', 'principal', `identity:${providerId}`)]);
    expect(masked.some((ed) => matchesPattern(ed.path, pathOf(drop.providerId)))).toBe(true);
    expect(masked.some((ed) => matchesPattern(ed.path, pathOf(keep.providerId)))).toBe(false);

    const endpoint = await db.migration.findFirstOrThrow({
      where: { routeId: ROUTE, scope: 'endpoint' },
    });
    const verifyStartedAt = Date.now();
    const run = await s.runAndWait(endpoint.id, 'verify');
    expect(run.status).toBe('succeeded');
    await s.idle('the follow-up jobs of the verify Run');
    const members = await db.parityResult.findFirstOrThrow({
      where: { migrationId: endpoint.id, facetKey: 'members' },
    });
    expect(members.status).toBe('equal');
    // The check is the one this test asked for, made after the invitations were sent. Nothing of
    // the deselected person is left to exclude: the comparison simply never sees them as a difference.
    expect(members.checkedAt.getTime()).toBeGreaterThanOrEqual(verifyStartedAt);
    expect(JSON.stringify(members.diffs)).not.toContain(drop.providerId);
  }, 480_000);

  it("[TST-020] [JOB-044] the quota ledger throttles with the fake's 429: the bucket is blocked until Retry-After, the provider is not called meanwhile, and the work then completes", async () => {
    const github = s.fakes.github;
    if (!github) throw new Error('the fake GitHub did not start');
    await s.idle('the jobs left by the earlier scenarios');
    const RETRY_AFTER_SECONDS = 8;
    const ORG_READS = new RegExp(`^/orgs/${WORLD_ORG}`);
    github.clearRequests();
    // The next inventory read of the organization is answered 429 with Retry-After.
    github.state.config.forced = {
      requests: 1,
      status: 429,
      retryAfterSeconds: RETRY_AFTER_SECONDS,
      match: `^GET /orgs/${WORLD_ORG}`,
    };

    const refresh = await s.call('POST', '/api/v1/inventory/refresh');
    expect(refresh.status).toBe(202);

    // The ledger records the block on the target's bucket.
    const blocked = await until('a blocked bucket of the target Endpoint', async () => {
      const rows = await s.db.privileged.quotaState.findMany({
        where: { blockedUntil: { gt: new Date() } },
      });
      return rows.find((r) => r.bucketKey.includes(TARGET)) ?? false;
    });
    const blockedUntil = (blocked.blockedUntil as Date).getTime();
    expect(github.requests().filter((r) => r.status === 429)).toHaveLength(1);
    expect(github.state.config.forced?.requests).toBe(0);

    // Visible to operators: GET /quota reports the block (JOB-047).
    const quota = await s.call('GET', '/api/v1/quota');
    expect(quota.status).toBe(200);
    const bucket = (
      quota.body as { buckets: { bucketKey: string; blockedUntil: string | null }[] }
    ).buckets.find((b) => b.bucketKey === blocked.bucketKey);
    expect(bucket?.blockedUntil).not.toBeNull();
    expect(new Date(bucket?.blockedUntil as string).getTime()).toBe(blockedUntil);

    // Throttled: while the block lasts, nothing reaches the provider through that bucket.
    // Only the throttled path is counted: other buckets and jobs are not blocked.
    const orgReads = () => github.requests().filter((r) => ORG_READS.test(r.path)).length;
    const sent = orgReads();
    await until(
      'the block to run out',
      () => {
        expect(orgReads(), 'organization reads while the bucket is blocked').toBe(sent);
        return Date.now() >= blockedUntil - 500;
      },
      30_000,
    );

    // The work waits the block out and completes: the inventory of the target succeeds.
    // A delayed enqueue is not counted by `idle`, so wait for the effect itself: a 200 read.
    await until(
      'a successful organization read after the block',
      () =>
        github.requests().some((r) => ORG_READS.test(r.path) && r.status === 200) &&
        Date.now() >= blockedUntil - 500,
      90_000,
    );
    await s.idle('the inventory jobs after the block');
    expect(github.requests().filter((r) => r.status === 429)).toHaveLength(1);
  }, 240_000);
});
