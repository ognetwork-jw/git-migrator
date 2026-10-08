/** Test harness: the adapter connected to the fake GitHub through the `fetch` seam (TST-006). */
import { generateKeyPairSync } from 'node:crypto';
import type {
  AdapterContext,
  DriverContext,
  EndpointConnection,
  FacetTarget,
  GitClient,
  LeaseGate,
  QuotaGate,
  RawCaptureInput,
  RepositoryRef,
} from '@git-migrator/adapter-sdk';
import { noopLogger } from '@git-migrator/adapter-sdk';
import { createFakeGitHub, type FakeGitHubOptions } from '@git-migrator/provider-fakes';
import { expect, it } from 'vitest';
import { createGitHubAdapter } from './adapter.ts';

export const BASE = 'http://localhost:4020';
export const AT = new Date('2026-01-01T00:00:00Z');

export function keyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
}

export function recordingQuota() {
  const calls = {
    acquire: [] as { keys: string[]; pool: string }[],
    feedback: [] as {
      bucketKey: string;
      limit: number;
      remaining?: number;
      fixedWindow?: boolean;
      observedSince?: Date;
      nearLimit?: boolean;
    }[],
    rateLimited: [] as { bucketKey: string; retryAfterSeconds?: number }[],
    secondary: [] as { bucketKey: string; retryAfterSeconds?: number }[],
    adjust: [] as { bucketKey: string; delta: number }[],
  };
  const quota: QuotaGate = {
    acquire: async (buckets, pool) => {
      calls.acquire.push({ keys: buckets.map((b) => b.key), pool });
      return { granted: true, at: AT, buckets: [] };
    },
    recordFeedback: async (f) => {
      calls.feedback.push(f);
    },
    recordRateLimited: async (i) => {
      calls.rateLimited.push(i);
      return new Date(Date.now() + (i.retryAfterSeconds ?? 60) * 1000);
    },
    recordSecondaryLimit: async (i) => {
      calls.secondary.push(i);
      return new Date(Date.now() + (i.retryAfterSeconds ?? 60) * 1000);
    },
    adjust: async (bucketKey, _pool, delta) => {
      calls.adjust.push({ bucketKey, delta });
    },
  };
  return { quota, calls };
}

export function recordingLeases() {
  const log = { acquired: [] as { key: string; cap: number }[], released: 0 };
  const leases: LeaseGate = {
    acquire: async (key, _holder, cap) => {
      log.acquired.push({ key, cap });
      return BigInt(log.acquired.length);
    },
    release: async () => {
      log.released += 1;
    },
  };
  return { leases, log };
}

export interface Harness {
  fake: ReturnType<typeof createFakeGitHub>;
  conn: EndpointConnection;
  quota: ReturnType<typeof recordingQuota>;
  leases: ReturnType<typeof recordingLeases>;
  requests: { method: string; url: string }[];
  captured: RawCaptureInput[];
  ctx: DriverContext;
  repo(name: string): RepositoryRef;
  target(name: string): FacetTarget;
  endpointTarget(): FacetTarget;
  org: { providerId: string; slug: string };
  privateKey: string;
}

export async function setup(
  options: FakeGitHubOptions & {
    git?: GitClient;
    connect?: Partial<Record<string, unknown>>;
    /** Answers a request before the fake sees it. May await the fake, to model a lost response. */
    intercept?: (request: Request) => Response | undefined | Promise<Response | undefined>;
    now?: () => Date;
    migrationUrl?: (repo: RepositoryRef) => string | undefined;
  } = {},
): Promise<Harness> {
  const { privateKey, publicKey } = keyPair();
  const { git, connect, intercept, now, migrationUrl, ...fakeOptions } = options;
  const fake = createFakeGitHub({ appPublicKeyPem: publicKey, gitBaseUrl: BASE, ...fakeOptions });
  const quota = recordingQuota();
  const leases = recordingLeases();
  const requests: { method: string; url: string }[] = [];
  const captured: RawCaptureInput[] = [];
  const fetchFn = (async (input: URL | string | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ method: request.method, url: request.url });
    return (await intercept?.(request.clone())) ?? fake.app.fetch(request);
  }) as typeof fetch;
  const gitClient: GitClient = git ?? {
    lsRemote: async () => ({ refs: [] }),
  };
  const adapterCtx: AdapterContext = {
    quota: quota.quota,
    leases: leases.leases,
    capture: {
      save: async (input) => {
        captured.push(input);
        return `raw-${captured.length}`;
      },
    },
    logger: noopLogger,
    fetch: fetchFn,
    environment: 'test',
    git: gitClient,
    pool: 'interactive',
    signal: new AbortController().signal,
  };
  const installationId = [...fake.state.installations.keys()][0] as number;
  const adapter = createGitHubAdapter({
    ...(now ? { now } : {}),
    ...(migrationUrl ? { migrationUrl } : {}),
  });
  const conn = await adapter.connect(
    {
      id: 'gh',
      baseUrl: BASE,
      config: {
        org: 'acme',
        appId: fake.state.ownApp.id,
        installationId,
        gitBaseUrl: BASE,
        ...connect,
      },
      credential: privateKey,
      accountKey: 'acct',
    },
    adapterCtx,
  );
  const org = { providerId: '', slug: 'acme' };
  const ctx: DriverContext = {
    http: conn.http,
    git: gitClient,
    logger: noopLogger,
    pool: 'interactive',
    signal: adapterCtx.signal,
  };
  return {
    fake,
    conn,
    quota,
    leases,
    requests,
    captured,
    ctx,
    org,
    privateKey,
    repo: (name) => ({ providerId: '', namespace: org, slug: name }),
    target: (name) => ({
      scope: 'repository',
      repository: { providerId: '', namespace: org, slug: name },
      namespace: org,
    }),
    endpointTarget: () => ({ scope: 'endpoint', namespace: org }),
  };
}

/** Collects an async iterable. */
export async function all<T>(iterable: AsyncIterable<T> | undefined): Promise<T[]> {
  const out: T[] = [];
  if (iterable) for await (const item of iterable) out.push(item);
  return out;
}

it('[ADP-010] the harness connects to the fake', async () => {
  const h = await setup();
  const page = await h.conn.inventory.listNamespaces();
  expect(page.items[0]?.slug).toBe('acme');
});
