import {
  type AdapterContext,
  AdapterError,
  type EndpointConnection,
  type EndpointRuntime,
  type GitClient,
  type ProviderHttpEnvironment,
  type QuotaGate,
  type QuotaPool,
} from '@git-migrator/adapter-sdk';
import type { Config } from '@git-migrator/config';
import { createGitQuota, GIT_UNITS, type GitQuota } from '@git-migrator/git';
import { type QuotaService, selectCredential } from '@git-migrator/quota';
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
   * Pre-acquires units in the `git` bucket the adapter declared for the connection's credential
   * (`GitAccess.quota`, JOB-041, JOB-043), for git commands the jobs run themselves (a mirror
   * clone, the `git-refs` ls-remote of an Analysis). A denial throws `rate_limited` with
   * `retryAt`. A connection whose adapter declares no git bucket belongs to a provider that does
   * not meter git over HTTPS (ADR-0380): its quota grants every request.
   */
  gitQuota(
    connection: Pick<EndpointConnection, 'git'>,
    options: Pick<ConnectOptions, 'pool'>,
  ): GitQuota;
}

/** The quota of git commands that nothing meters (ADR-0380). */
export const unmeteredGitQuota: GitQuota = { acquire: async () => undefined };

/** A `GitQuota` over the bucket a connection declared, or `unmeteredGitQuota` when it declared none. */
export function gitQuotaOf(
  gate: Pick<QuotaGate, 'acquire'>,
  connection: Pick<EndpointConnection, 'git'>,
  pool: QuotaPool,
  now?: () => Date,
): GitQuota {
  const spec = connection.git.quota;
  if (!spec) return unmeteredGitQuota;
  return createGitQuota({
    gate,
    bucketKey: spec.key,
    limit: spec.limit,
    windowSeconds: spec.windowSeconds,
    pool,
    ...(now ? { now } : {}),
  });
}

/**
 * Wraps a `GitClient` so every ls-remote first pre-acquires its unit in `quota` (JOB-041). The inner
 * client must not meter again.
 */
export function meteredGitClient(inner: GitClient, quota: GitQuota): GitClient {
  return {
    async lsRemote(request) {
      await quota.acquire(GIT_UNITS.lsRemote);
      return inner.lsRemote(request);
    },
  };
}

export interface EndpointConnectorOptions {
  readonly config: Config;
  readonly registry: Pick<ProviderRegistry, 'adapter'>;
  /** Holds the secrets the config names (`credentialsSecret`). Values are never logged. */
  readonly env: Env;
  /** Quota and lease gates, raw capture, telemetry and logger (`createProviderEnvironment`). */
  readonly environment: ProviderHttpEnvironment;
  readonly git: GitClient;
  /**
   * Free capacity of quota buckets (`QuotaService`), for JOB-042 credential selection. Without it
   * the first valid credential is used.
   */
  readonly capacity?: Pick<QuotaService, 'freeCapacity'>;
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
  /** The Endpoint's entry, its adapter and the credential JOB-042 selects for `pool`. */
  const select = async (endpointId: string, pool: QuotaPool) => {
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
    if (credentials.length === 0) {
      throw new AdapterError({
        code: 'invalid',
        provider: entry.provider,
        message: `Secret ${entry.credentialsSecret} holds no valid credential for Endpoint ${endpointId}`,
      });
    }
    const config = adapterConfigFor(entry, options.config, adapter.configSchema);
    const runtimeOf = (credential: unknown): EndpointRuntime => {
      const accountId = (credential as { accountId?: unknown } | null)?.accountId;
      const accountKey = typeof accountId === 'string' && accountId !== '' ? accountId : entry.id;
      return { id: entry.id, baseUrl: entry.baseUrl, config, credential, accountKey };
    };
    const runtimes = credentials.map(runtimeOf);
    const first = runtimes[0] as EndpointRuntime;
    // JOB-042: the credential whose buckets have the most free capacity for the pool. Without the
    // adapter's buckets or a capacity source, or with one credential, the first valid one is used.
    if (runtimes.length === 1 || !adapter.credentialBuckets || !options.capacity) {
      return { adapter, runtime: first };
    }
    const bucketsOf = adapter.credentialBuckets.bind(adapter);
    const chosen = await selectCredential(
      options.capacity,
      runtimes.map((runtime) => ({ credential: runtime, buckets: bucketsOf(runtime) })),
      pool,
    );
    return { adapter, runtime: chosen?.credential ?? first };
  };
  return {
    async connect(endpointId, { pool, signal }) {
      const { adapter, runtime } = await select(endpointId, pool);
      const context: AdapterContext = { ...options.environment, git: options.git, pool, signal };
      return adapter.connect(runtime, context);
    },
    gitQuota(connection, { pool }) {
      return gitQuotaOf(options.environment.quota, connection, pool);
    },
  };
}

/**
 * The `GitClient` for jobs that never touch git transport (inventory). It refuses every call, so a
 * driver cannot reach git without the quota-aware `GitService` of the Run engine.
 */
export const noGitClient: GitClient = {
  async lsRemote() {
    throw new Error('This job has no git transport');
  },
};
