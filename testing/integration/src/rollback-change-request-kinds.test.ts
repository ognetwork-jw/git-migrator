/**
 * Guard (LIF-077, ADR-0465): the code-ownership driver has no `undo`, so every record it yields for
 * the Change Request writer must be one rollback reverts by its resource kind (closed or left), never
 * through the driver fallback, which would fail `rollback.undo-unsupported`.
 */
import { generateKeyPairSync } from 'node:crypto';
import { createGitHubAdapter } from '@git-migrator/adapter-github';
import {
  type AdapterContext,
  type DriverContext,
  type FacetTarget,
  type MutationRecord,
  noopLogger,
} from '@git-migrator/adapter-sdk';
import type { CodeOwnership } from '@git-migrator/canonical';
import { dispositionOf } from '@git-migrator/jobs';
import { createFakeGitHub } from '@git-migrator/provider-fakes';
import { describe, expect, it } from 'vitest';

const BASE = 'http://localhost:4020';

async function connect() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const fake = createFakeGitHub({ appPublicKeyPem: publicKey, gitBaseUrl: BASE });
  const git = { lsRemote: async () => ({ refs: [] }) };
  const adapterCtx: AdapterContext = {
    quota: {
      acquire: async () => ({ granted: true, at: new Date('2026-01-01T00:00:00Z'), buckets: [] }),
      recordFeedback: async () => {},
      recordRateLimited: async () => new Date(Date.now() + 60_000),
      recordSecondaryLimit: async () => new Date(Date.now() + 60_000),
      adjust: async () => {},
    },
    leases: { acquire: async () => 1n, release: async () => {} },
    capture: { save: async () => 'raw' },
    logger: noopLogger,
    fetch: ((input: URL | string | Request, init?: RequestInit) =>
      fake.app.fetch(new Request(input, init))) as typeof fetch,
    environment: 'test',
    git,
    pool: 'interactive',
    signal: new AbortController().signal,
  };
  const conn = await createGitHubAdapter().connect(
    {
      id: 'gh',
      baseUrl: BASE,
      config: {
        org: 'acme',
        appId: fake.state.ownApp.id,
        installationId: [...fake.state.installations.keys()][0] as number,
        gitBaseUrl: BASE,
      },
      credential: privateKey,
      accountKey: 'acct',
    },
    adapterCtx,
  );
  const ctx: DriverContext = {
    http: conn.http,
    git,
    logger: noopLogger,
    pool: 'interactive',
    signal: adapterCtx.signal,
  };
  return { fake, conn, ctx };
}

describe('code-ownership records and rollback (LIF-077)', () => {
  it('[LIF-077] every record the code-ownership driver yields through the Change Request writer is closed or left by rollback, never sent to the missing driver undo', async () => {
    const { fake, conn, ctx } = await connect();
    const s = fake.state;
    const bob = s.addMember('acme', 'bob');
    const team = s.addTeam('acme', { name: 'devs' });
    s.addRepository('acme', { name: 'r', files: { 'README.md': '# hi\n' } });
    const org = { providerId: '', slug: 'acme' };
    const target: FacetTarget = {
      scope: 'repository',
      repository: { providerId: '', namespace: org, slug: 'r' },
      namespace: org,
    };
    const owners = (id: string, kind: 'group' | 'identity'): CodeOwnership => ({
      owners: [{ pattern: '*', principals: [{ principal: { kind, id } }] }],
    });
    const driver = conn.facets['code-ownership'];
    expect(driver?.undo).toBeUndefined(); // the premise of this guard
    const writer = conn.changeRequests;
    if (!driver?.apply || !writer) throw new Error('no code-ownership writer');
    const records: MutationRecord[] = [];
    const apply = async (desired: CodeOwnership) => {
      for await (const m of driver.apply?.(ctx, target, desired, null, []) ?? []) records.push(m);
    };

    await apply(owners(String(team.id), 'group')); // creates the branch and the Change Request
    await apply(owners(String(bob.id), 'identity')); // a new commit on the open request's branch
    await writer.close(target.repository, 'codeowners');
    await apply(owners(String(team.id), 'group')); // adopts the framework branch, opens again

    const kinds = new Set(records.map((m) => `${m.action}:${String(m.resourceRef.kind)}`));
    expect([...kinds]).toEqual(
      expect.arrayContaining(['create:ref', 'update:ref', 'create:change-request']),
    );
    const routed = records.map((m) => [
      `${m.action}:${String(m.resourceRef.kind)}`,
      dispositionOf({ action: m.action, resourceRef: m.resourceRef }),
    ]);
    expect(routed.filter(([, how]) => how === 'driver')).toEqual([]);
  }, 60_000);
});
