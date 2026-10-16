import type {
  AdapterContext,
  EndpointConnection,
  EndpointRuntime,
  ProviderAdapter,
} from '@git-migrator/adapter-sdk';
import { type Config, resolveConfig } from '@git-migrator/config';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  adapterConfigFor,
  createEndpointConnector,
  meteredGitClient,
  noGitClient,
  unmeteredGitQuota,
} from './connector.ts';

const config: Config = resolveConfig({
  text: `
endpoints:
  - id: src
    provider: bitbucket-cloud
    options: { workspace: acme }
    quota: { overrides: { repository-data: 50 } }
  - id: dst
    provider: github
    options: { org: acme, appId: 7, installationId: 9 }
    quota: { overrides: { core: 10 } }
routes:
  - { id: r, source: src, target: dst, targetNamespace: acme }
github: { maxConcurrentRequests: 3 }
`,
  env: {},
});
const [src, dst] = config.endpoints as [Config['endpoints'][number], Config['endpoints'][number]];

/** Strict schemas shaped like the adapters', but local to the test (no adapter import). */
const strictA = z.strictObject({
  workspace: z.string(),
  gitBaseUrl: z.string(),
  quota: z.strictObject({ overrides: z.record(z.string(), z.number()) }),
});
const strictB = z.strictObject({
  org: z.string(),
  appId: z.number(),
  installationId: z.number(),
  gitBaseUrl: z.string(),
  maxConcurrentRequests: z.number(),
  quotaOverrides: z.record(z.string(), z.number()),
});

describe('adapter configuration from the Endpoint entry', () => {
  it('[JOB-030] passes an adapter only the keys its strict schema declares (ADR-0220, ADR-0230)', () => {
    const a = adapterConfigFor(src, config, strictA);
    expect(Object.keys(a).sort()).toEqual(['gitBaseUrl', 'quota', 'workspace']);
    expect(strictA.safeParse(a).success).toBe(true);
    const b = adapterConfigFor(dst, config, strictB);
    expect(b).toMatchObject({ maxConcurrentRequests: 3, quotaOverrides: { core: 10 } });
    expect(strictB.safeParse(b).success).toBe(true);
  });

  it('[JOB-030] passes everything when the schema is not an object schema', () => {
    expect(Object.keys(adapterConfigFor(src, config, z.unknown()))).toContain('quotaOverrides');
  });
});

interface Seen {
  runtime?: EndpointRuntime;
  ctx?: AdapterContext;
}

function fakeAdapter(
  seen: Seen,
  credentialSchema: z.ZodType = z.strictObject({ accountId: z.string(), token: z.string() }),
): ProviderAdapter {
  return {
    type: 'bitbucket-cloud',
    displayName: 'x',
    namespaceLevels: [],
    capabilities: { facets: {} },
    configSchema: strictA,
    credentialSchema,
    connect: async (runtime, ctx) => {
      seen.runtime = runtime;
      seen.ctx = ctx;
      return {} as never;
    },
  };
}

const environment = { quota: {} as never, logger: {} as never };
const signal = new AbortController().signal;

function connectorWith(env: Record<string, string>, seen: Seen = {}, schema?: z.ZodType) {
  return createEndpointConnector({
    config,
    registry: { adapter: () => fakeAdapter(seen, schema) },
    env,
    environment,
    git: noGitClient,
  });
}

describe('git quota of an Endpoint (JOB-041, JOB-043)', () => {
  const gate = (granted: boolean) => {
    const calls: unknown[][] = [];
    return {
      calls,
      gate: {
        acquire: async (...args: unknown[]) => {
          calls.push(args);
          return granted
            ? { granted: true }
            : {
                granted: false,
                reason: 'limit',
                bucketKey: 'x',
                retryAt: new Date(Date.now() + 5000),
              };
        },
      } as never,
    };
  };
  const connector = (g: ReturnType<typeof gate>) =>
    createEndpointConnector({
      config,
      registry: { adapter: () => fakeAdapter({}) },
      env: { BITBUCKET_CREDENTIALS: JSON.stringify([{ accountId: 'acct-1', token: 'abc-1' }]) },
      environment: { quota: g.gate, logger: {} as never },
      git: noGitClient,
    });

  const declared = {
    git: { quota: { key: 'src:acct_1:git', limit: 1234, windowSeconds: 600 } },
  } as unknown as EndpointConnection;

  it('[JOB-041] acquires the units in the git bucket the connection declared, in the given pool', async () => {
    const g = gate(true);
    await connector(g).gitQuota(declared, { pool: 'background' }).acquire(3);
    expect(g.calls).toEqual([
      [[{ key: 'src:acct_1:git', limit: 1234, windowSeconds: 600, units: 3 }], 'background'],
    ]);
  });

  it('[JOB-041] a denied grant is rate_limited with retryAt', async () => {
    const g = gate(false);
    await expect(
      connector(g).gitQuota(declared, { pool: 'interactive' }).acquire(3),
    ).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('[JOB-041] grants every git command of a connection that declares no git bucket', async () => {
    const g = gate(false);
    const quota = connector(g).gitQuota({ git: {} } as unknown as EndpointConnection, {
      pool: 'background',
    });
    expect(quota).toBe(unmeteredGitQuota);
    await quota.acquire(3);
    expect(g.calls).toEqual([]);
  });

  it('[JOB-041] a metered git client pre-acquires one unit before each ls-remote and stops on a denial', async () => {
    const order: string[] = [];
    const inner = {
      lsRemote: async () => {
        order.push('ls-remote');
        return { refs: [] };
      },
    };
    let deny = false;
    const quota = {
      acquire: async (units: number) => {
        order.push(`acquire ${units}`);
        if (deny) throw new Error('rate limited');
      },
    };
    const git = meteredGitClient(inner, quota);
    const request = {
      url: 'https://git.example/x.git',
      credential: { username: 'u', password: 'p' },
    };
    await git.lsRemote(request);
    deny = true;
    await expect(git.lsRemote(request)).rejects.toThrow('rate limited');
    expect(order).toEqual(['acquire 1', 'ls-remote', 'acquire 1']);
  });
});

describe('endpoint connector', () => {
  it('[JOB-042] connects with the first valid credential and the account key of that credential', async () => {
    const seen: Seen = {};
    const connector = connectorWith(
      {
        BITBUCKET_CREDENTIALS: JSON.stringify([
          { nope: true },
          { accountId: 'acct-1', token: 'abc-1' },
          { accountId: 'acct-2', token: 'abc-2' },
        ]),
      },
      seen,
    );
    await connector.connect('src', { pool: 'background', signal });
    expect(seen.runtime).toMatchObject({
      id: 'src',
      credential: { accountId: 'acct-1' },
      accountKey: 'acct-1',
    });
    expect(seen.ctx).toMatchObject({ pool: 'background', signal });
  });

  it('[JOB-042] picks the credential whose buckets have the most free capacity for the pool', async () => {
    const seen: Seen = {};
    const asked: Array<[string, string]> = [];
    const free: Record<string, number> = { 'src:acct-1:core': 5, 'src:acct-2:core': 40 };
    const adapter: ProviderAdapter = {
      ...fakeAdapter(seen),
      credentialBuckets: (runtime) => [
        { key: `${runtime.id}:${runtime.accountKey}:core`, limit: 100, windowSeconds: 3600 },
      ],
    };
    const capacity = {
      freeCapacity: async (spec: { key: string }, pool: string) => {
        asked.push([spec.key, pool]);
        return { free: free[spec.key] ?? 0, blockedUntil: null } as never;
      },
    };
    const make = (withCapacity: boolean) =>
      createEndpointConnector({
        config,
        registry: { adapter: () => adapter },
        env: {
          BITBUCKET_CREDENTIALS: JSON.stringify([
            { accountId: 'acct-1', token: 'abc-1' },
            { accountId: 'acct-2', token: 'abc-2' },
          ]),
        },
        environment,
        git: noGitClient,
        ...(withCapacity ? { capacity } : {}),
      });
    await make(true).connect('src', { pool: 'interactive', signal });
    expect(seen.runtime).toMatchObject({
      credential: { accountId: 'acct-2' },
      accountKey: 'acct-2',
    });
    expect(asked).toEqual([
      ['src:acct-1:core', 'interactive'],
      ['src:acct-2:core', 'interactive'],
    ]);
    // The fuller account frees up: the next job takes the other one.
    free['src:acct-2:core'] = 1;
    await make(true).connect('src', { pool: 'background', signal });
    expect(seen.runtime?.accountKey).toBe('acct-1');
    // Without a capacity source the first valid credential is used.
    await make(false).connect('src', { pool: 'background', signal });
    expect(seen.runtime?.accountKey).toBe('acct-1');
  });

  it('[JOB-042] uses the Endpoint id as the account key for a credential without an account', async () => {
    const seen: Seen = {};
    const connector = connectorWith(
      { GITHUB_APP_PRIVATE_KEY: '-----BEGIN KEY-----\nabc\n-----END KEY-----\n' },
      seen,
      z.string(),
    );
    await connector.connect('dst', { pool: 'interactive', signal });
    expect(seen.runtime?.accountKey).toBe('dst');
  });

  it('[JOB-030] fails without leaking the value when the credentials are missing, malformed or unusable', async () => {
    const run = (env: Record<string, string>, id = 'src') =>
      connectorWith(env).connect(id, { pool: 'background', signal });
    await expect(run({}, 'nope')).rejects.toThrow('Endpoint nope is not configured');
    await expect(run({})).rejects.toThrow('Secret BITBUCKET_CREDENTIALS is not set');
    await expect(run({ BITBUCKET_CREDENTIALS: '  ' })).rejects.toThrow('is not set');
    const broken = await run({ BITBUCKET_CREDENTIALS: '[{"token": "hunter2-value"' }).catch(
      (error: Error) => error,
    );
    expect((broken as Error).message).toBe('Secret BITBUCKET_CREDENTIALS is not valid JSON');
    expect((broken as Error).message).not.toContain('hunter2');
    await expect(run({ BITBUCKET_CREDENTIALS: '[{"token": "x"}]' })).rejects.toThrow(
      'holds no valid credential',
    );
    await expect(run({ BITBUCKET_CREDENTIALS: '5' })).rejects.toThrow('holds no valid credential');
  });

  it('[JOB-030] reads a single JSON object and refuses to use git transport', async () => {
    const seen: Seen = {};
    await connectorWith({ BITBUCKET_CREDENTIALS: '{"accountId":"a","token":"t"}' }, seen).connect(
      'src',
      { pool: 'background', signal },
    );
    expect(seen.runtime?.accountKey).toBe('a');
    await expect(
      noGitClient.lsRemote({ url: 'http://x', credential: { username: 'u', password: 'p' } }),
    ).rejects.toThrow('no git transport');
  });
});
