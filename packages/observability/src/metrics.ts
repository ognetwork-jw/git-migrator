import {
  Counter,
  collectDefaultMetrics,
  Gauge,
  Histogram,
  Registry,
  type Registry as RegistryType,
} from 'prom-client';

/** An HTTP status code as label text, for example `"429"`. */
export type HttpStatusLabel = `${number}`;
/** The two quota pools of JOB-041. */
export type QuotaPoolLabel = 'background' | 'interactive';
/** The labels of the provider request metrics (ADP-060). */
export interface ProviderRequestLabels {
  /** The adapter type, for example `bitbucket-cloud`. */
  provider: string;
  /** The configured Endpoint id. */
  endpoint: string;
  /** The quota bucket the request was charged to (JOB-040). */
  bucket: string;
  status: HttpStatusLabel;
}

/** The metrics of DEP-050. Names and label sets are part of the operational contract. */
export interface GmMetrics {
  readonly providerRequestsTotal: Counter<keyof ProviderRequestLabels>;
  readonly providerRequestDurationSeconds: Histogram<keyof ProviderRequestLabels>;
  readonly quotaUsed: Gauge<'bucket' | 'pool'>;
  readonly quotaLimit: Gauge<'bucket'>;
  readonly runsTotal: Counter<'kind' | 'status'>;
  readonly runDurationSeconds: Histogram<'kind'>;
  readonly migrations: Gauge<'route' | 'status' | 'readiness'>;
  readonly queueJobs: Gauge<'queue' | 'state'>;
}

/** Labels of the migration gauge and the run metrics that have a fixed, documented set of values. */
export interface MigrationLabels {
  route: string;
  status: string;
  readiness: string;
}

/**
 * The only way application code writes metric values. Each function takes typed labels, so a pool
 * or status that the spec does not name fails to compile, which prom-client itself would not catch.
 */
export interface MetricRecorders {
  /** One provider request: counts it and observes its duration (ADP-060). */
  recordProviderRequest(labels: ProviderRequestLabels, durationSeconds: number): void;
  setQuotaUsed(bucket: string, pool: QuotaPoolLabel, value: number): void;
  setQuotaLimit(bucket: string, value: number): void;
  /** One finished Run: counts it and observes its duration. */
  recordRun(kind: string, status: string, durationSeconds: number): void;
  setMigrations(labels: MigrationLabels, value: number): void;
  setQueueJobs(queue: string, state: string, value: number): void;
}

export interface MetricsRegistry {
  readonly registry: RegistryType;
  /** Raw prom-client metrics. Application code uses `recorders`. */
  readonly metrics: GmMetrics;
  readonly recorders: MetricRecorders;
}

const PROVIDER_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const RUN_BUCKETS = [1, 5, 15, 60, 300, 900, 3600, 14_400];

/**
 * Creates the `prom-client` registry with the Node default metrics and every metric of DEP-050.
 * Pass a fresh registry per process; metric names can be registered only once per registry.
 */
export function createMetrics(registry: RegistryType = new Registry()): MetricsRegistry {
  collectDefaultMetrics({ register: registry });
  const metrics: GmMetrics = {
    providerRequestsTotal: new Counter({
      name: 'gm_provider_requests_total',
      help: 'Provider HTTP requests, by provider, endpoint, quota bucket and response status (ADP-060).',
      labelNames: ['provider', 'endpoint', 'bucket', 'status'] as const,
      registers: [registry],
    }),
    providerRequestDurationSeconds: new Histogram({
      name: 'gm_provider_request_duration_seconds',
      help: 'Duration of provider HTTP requests in seconds, with the labels of gm_provider_requests_total (ADP-060).',
      labelNames: ['provider', 'endpoint', 'bucket', 'status'] as const,
      buckets: PROVIDER_BUCKETS,
      registers: [registry],
    }),
    quotaUsed: new Gauge({
      name: 'gm_quota_used',
      help: 'Requests counted in the current window for each quota bucket and pool.',
      labelNames: ['bucket', 'pool'] as const,
      registers: [registry],
    }),
    quotaLimit: new Gauge({
      name: 'gm_quota_limit',
      help: 'Limit of each quota bucket for the current window.',
      labelNames: ['bucket'] as const,
      registers: [registry],
    }),
    runsTotal: new Counter({
      name: 'gm_runs_total',
      help: 'Runs finished, by kind and status.',
      labelNames: ['kind', 'status'] as const,
      registers: [registry],
    }),
    runDurationSeconds: new Histogram({
      name: 'gm_run_duration_seconds',
      help: 'Duration of Runs in seconds, by kind.',
      labelNames: ['kind'] as const,
      buckets: RUN_BUCKETS,
      registers: [registry],
    }),
    migrations: new Gauge({
      name: 'gm_migrations',
      help: 'Migrations by route, status and readiness.',
      labelNames: ['route', 'status', 'readiness'] as const,
      registers: [registry],
    }),
    queueJobs: new Gauge({
      name: 'gm_queue_jobs',
      help: 'Jobs in each queue, by state.',
      labelNames: ['queue', 'state'] as const,
      registers: [registry],
    }),
  };
  const recorders: MetricRecorders = {
    recordProviderRequest(labels, durationSeconds) {
      metrics.providerRequestsTotal.inc(labels);
      metrics.providerRequestDurationSeconds.observe(labels, durationSeconds);
    },
    setQuotaUsed(bucket, pool, value) {
      metrics.quotaUsed.set({ bucket, pool }, value);
    },
    setQuotaLimit(bucket, value) {
      metrics.quotaLimit.set({ bucket }, value);
    },
    recordRun(kind, status, durationSeconds) {
      metrics.runsTotal.inc({ kind, status });
      metrics.runDurationSeconds.observe({ kind }, durationSeconds);
    },
    setMigrations(labels, value) {
      metrics.migrations.set(labels, value);
    },
    setQueueJobs(queue, state, value) {
      metrics.queueJobs.set({ queue, state }, value);
    },
  };
  return { registry, metrics, recorders };
}
