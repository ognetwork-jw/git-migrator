import {
  type AdapterContext,
  AdapterError,
  type EndpointConnection,
  type GitClient,
  type ProviderHttpEnvironment,
  type QuotaPool,
} from '@git-migrator/adapter-sdk';
import type { Config } from '@git-migrator/config';
import { createGitQuota, type GitQuota } from '@git-migrator/git';
import { bucketKey } from '@git-migrator/quota';
import type { ProviderRegistry } from '@git-migrator/registry';

type Env = Readonly<Record<string, string | undefined>>;

export interface ConnectOptions {
  /** The quota pool the job draws from (JOB-020: inventory is background work). */
  readonly pool: QuotaPool;
  readonly signal: AbortSignal;
}

/**
 * How a job reaches an Endpoint. Jobs get it injected, so they never import an adapter
 * (ARC-012): the production implementation resolves the adapter through the registry.
 */
export interface EndpointConnector {
  connect(endpointId: string, options: ConnectOptions): Promise<EndpointConnection>;
  /**
   * Pre-acquires units in the `git` bucket of the credential `connect` selects for the Endpoint
   * (JOB-041, JOB-043), for git commands the jobs run themselves (a mirror clone). A denial throws
   * `rate_limited` with `retryAt`. Absent in test connectors: git commands then run unmetered.
   */
  gitQuota?(endpointId: string, options: Pick<ConnectOptions, 'pool'>): GitQuota;
}

export interface EndpointConnectorOptions {
  readonly config: Config;
  readonly registry: Pick<ProviderRegistry, 'adapter'>;
  /** Holds the secrets the config names (`credentialsSecret`). Values are never logged. */
  readonly env: Env;
  /** Quota and lease gates, raw capture, telemetry and logger (`createProviderEnvironment`). */
  readonly environment: ProviderHttpEnvironment;
  readonly git: GitClient;
}

/** Keys of a strict Zod object schema, or `undefined` when the schema is not an object. */
function schemaKeys(schema: unknown): ReadonlySet<string> | undefined {
  const def = (schema as { _zod?: { def?: { type?: string; shape?: Record<string, unknown> } } })
    ._zod?.def;
  return def?.type === 'object' && def.shape ? new Set(Object.keys(def.shape)) : undefined;
}

/**
 * The adapter's `config` (ADR-0220, ADR-0230): the Endpoint's `options` plus the keys the runner
 * copies in (`gitBaseUrl`, `quota`, `quotaOverrides`, `maxConcurrentRequests`). Each adapter's
 * schema is strict, so only the keys it declares are passed.
 */
export function adapterConfigFor(
  entry: Config['endpoints'][number],
  config: Pick<Config, 'github'>,
  schema: unknown,
): Record<string, unknown> {
  const all: Record<string, unknown> = {
    ...entry.options,
    gitBaseUrl: entry.gitBaseUrl,
    quota: entry.quota,
    quotaOverrides: entry.quota.overrides,
    maxConcurrentRequests: config.github.maxConcurrentRequests,
  };
  const keys = schemaKeys(schema);
  if (!keys) return all;
  return Object.fromEntries(
    Object.entries(all).filter(([key]) => keys.has(key) || key in entry.options),
  );
}

/** Reads a secret holding one credential (PEM or JSON object) or a JSON array of them. */
function credentialsFrom(raw: string): unknown[] {
  const text = raw.trim();
  if (text.startsWith('[')) {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  }
  if (text.startsWith('{')) return [JSON.parse(text)];
  return [raw];
}

export function createEndpointConnector(options: EndpointConnectorOptions): EndpointConnector {
  /** The Endpoint's entry, its adapter and the credential JOB-042 selects (the first valid one today). */
  const select = (endpointId: string) => {
    const entry = options.config.endpoints.find((e) => e.id === endpointId);
    if (!entry) {
      throw new AdapterError({
        code: 'invalid',
        provider: 'config',
        message: `Endpoint ${endpointId} is not configured`,
      });
    }
    const adapter = options.registry.adapter(entry.provider);
    const raw = options.env[entry.credentialsSecret];
    if (raw === undefined || raw.trim() === '') {
      throw new AdapterError({
        code: 'unauthorized',
        provider: entry.provider,
        message: `Secret ${entry.credentialsSecret} is not set for Endpoint ${endpointId}`,
      });
    }
    let candidates: unknown[];
    try {
      candidates = credentialsFrom(raw);
    } catch {
      // The parser's message can quote the secret; report the name only.
      throw new AdapterError({
        code: 'invalid',
        provider: entry.provider,
        message: `Secret ${entry.credentialsSecret} is not valid JSON`,
      });
    }
    const credentials = candidates.filter((c) => adapter.credentialSchema.safeParse(c).success);
    // JOB-042 picks the credential with the most free capacity; that needs each adapter's
    // bucket classifier, which the host cannot see yet (ADR-0280), so the first valid one is used.
    const credential = credentials[0];
    if (credential === undefined) {
      throw new AdapterError({
        code: 'invalid',
        provider: entry.provider,
        message: `Secret ${entry.credentialsSecret} holds no valid credential for Endpoint ${endpointId}`,
      });
    }
    const accountId = (credential as { accountId?: unknown } | null)?.accountId;
    const accountKey = typeof accountId === 'string' && accountId !== '' ? accountId : entry.id;
    return { entry, adapter, credential, accountKey };
  };
  return {
    async connect(endpointId, { pool, signal }) {
      const { entry, adapter, credential, accountKey } = select(endpointId);
      const context: AdapterContext = { ...options.environment, git: options.git, pool, signal };
      return adapter.connect(
        {
          id: entry.id,
          baseUrl: entry.baseUrl,
          config: adapterConfigFor(entry, options.config, adapter.configSchema),
          credential,
          accountKey,
        },
        context,
      );
    },
    gitQuota(endpointId, { pool }) {
      const { entry, accountKey } = select(endpointId);
      const overrides = entry.quota.overrides as Readonly<Record<string, number>> | undefined;
      return createGitQuota({
        gate: options.environment.quota,
        bucketKey: bucketKey(endpointId, accountKey, 'git'),
        limit: overrides?.git ?? GIT_BUCKET_LIMIT,
        windowSeconds: 3600,
        pool,
      });
    },
  };
}

/** JOB-043: the `git` bucket allows 60,000 requests an hour unless `quota.overrides.git` says otherwise. */
const GIT_BUCKET_LIMIT = 60_000;

/**
 * The `GitClient` for jobs that never touch git transport (inventory). It refuses every call, so a
 * driver cannot reach git without the quota-aware `GitService` of the Run engine.
 */
export const noGitClient: GitClient = {
  async lsRemote() {
    throw new Error('This job has no git transport');
  },
};
