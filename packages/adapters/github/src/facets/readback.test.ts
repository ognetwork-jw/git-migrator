import type { FacetDriver, MutationRecord } from '@git-migrator/adapter-sdk';
import { type BranchRules, type FacetKey, webhookKey } from '@git-migrator/canonical';
import { describe, expect, it } from 'vitest';
import { type Harness, setup } from '../harness.test.ts';

const FILES = { 'README.md': '# hi\n' };

function driver<T>(h: Harness, key: FacetKey): FacetDriver<T> {
  const d = h.conn.facets[key];
  if (!d) throw new Error(`no driver ${key}`);
  return d as FacetDriver<T>;
}

/** Every record an apply yields before it throws, and what it threw. */
async function drain(iterable: AsyncIterable<MutationRecord> | undefined) {
  const records: MutationRecord[] = [];
  let error: unknown;
  try {
    if (iterable) for await (const record of iterable) records.push(record);
  } catch (e) {
    error = e;
  }
  return { records, error };
}

const unavailable = () =>
  new Response('{"message":"Service Unavailable"}', {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });

/**
 * A harness whose matching write reaches the provider (when `applied`) and then loses its response.
 */
async function lossy(matches: (r: Request, body: string) => boolean, applied = true) {
  const h: Harness = await setup({
    intercept: async (r) => {
      const body = r.method === 'GET' ? '' : await r.clone().text();
      if (!matches(r, body)) return undefined;
      if (applied) await h.fake.app.fetch(r);
      return unavailable();
    },
  });
  const repo = h.fake.state.addRepository('acme', { name: 'r', private: true, files: FILES });
  return { h, repo };
}

const url = 'https://ci.example.test/hook';
const webhook = {
  key: webhookKey(url),
  url,
  events: ['push' as const],
  active: true,
  hasSecret: false,
  verifyTls: true,
};

describe('read-back after a lost write response (ADR-0222)', () => {
  it('[LIF-045] a hook created despite a lost POST response is ledgered as a create before the error', async () => {
    const { h, repo } = await lossy((r) => r.method === 'POST' && r.url.endsWith('/hooks'));
    const { records, error } = await drain(
      driver<{ hooks: (typeof webhook)[] }>(h, 'webhooks').apply?.(
        h.ctx,
        h.target('r'),
        { hooks: [webhook] },
        null,
        [],
      ),
    );
    expect(error).toMatchObject({ code: 'transient' });
    expect(repo.hooks).toHaveLength(1);
    expect(records).toEqual([
      expect.objectContaining({
        action: 'create',
        resourceRef: { kind: 'webhook', id: repo.hooks[0]?.id, key: webhook.key },
      }),
    ]);
  });

  it('[LIF-045] a lost POST that the provider did not apply ledgers nothing and still fails', async () => {
    const { h, repo } = await lossy((r) => r.method === 'POST' && r.url.endsWith('/hooks'), false);
    const { records, error } = await drain(
      driver<{ hooks: (typeof webhook)[] }>(h, 'webhooks').apply?.(
        h.ctx,
        h.target('r'),
        { hooks: [webhook] },
        null,
        [],
      ),
    );
    expect(error).toMatchObject({ code: 'transient' });
    expect(repo.hooks).toHaveLength(0);
    expect(records).toEqual([]);
  });

  it('[LIF-045] an environment created despite a lost PUT response is ledgered as a create before the error', async () => {
    const { h } = await lossy((r) => r.method === 'PUT' && r.url.endsWith('/environments/staging'));
    const { records, error } = await drain(
      driver<{
        environments: { name: string; category: null; deploymentBranches: string[] | null }[];
      }>(h, 'environments').apply?.(
        h.ctx,
        h.target('r'),
        { environments: [{ name: 'staging', category: null, deploymentBranches: null }] },
        null,
        [],
      ),
    );
    expect(error).toMatchObject({ code: 'transient' });
    expect(records).toEqual([
      expect.objectContaining({
        action: 'create',
        resourceRef: { kind: 'environment', repository: 'r', name: 'staging' },
      }),
    ]);
  });

  it('[LIF-045] a branch protection rule created despite a lost mutation response is ledgered with its id before the error', async () => {
    const { h, repo } = await lossy(
      (r, body) => r.url.endsWith('/graphql') && body.includes('createBranchProtectionRule'),
    );
    const rule = {
      pattern: 'main',
      enforcement: 'enforced' as const,
      restrictPushes: null,
      restrictMerges: null,
      blockForcePush: true,
      forcePushExempt: [],
      blockDeletion: true,
      deletionExempt: [],
      changeRequest: null,
    };
    const { records, error } = await drain(
      driver<BranchRules>(h, 'branch-rules').apply?.(
        h.ctx,
        h.target('r'),
        { rules: [rule] },
        null,
        [],
      ),
    );
    expect(error).toMatchObject({ code: 'transient' });
    expect(repo.rules).toHaveLength(1);
    expect(records).toEqual([
      expect.objectContaining({
        action: 'create',
        resourceRef: expect.objectContaining({
          kind: 'branch-protection-rule',
          pattern: 'main',
          id: expect.any(String),
        }),
      }),
    ]);
    // The ledgered id is the rule's: undoing the record removes exactly that rule.
    await driver<BranchRules>(h, 'branch-rules').undo?.(
      h.ctx,
      h.target('r'),
      records[0] as MutationRecord,
    );
    expect(repo.rules).toHaveLength(0);
  });
});
