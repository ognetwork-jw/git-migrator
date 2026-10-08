import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';
import { createMetrics, type HttpStatusLabel, type ProviderRequestLabels } from './metrics.ts';

const PROVIDER: ProviderRequestLabels = {
  provider: 'bitbucket-cloud',
  endpoint: 'bb-main',
  bucket: 'repository-data',
  status: '429',
};

async function scrape(registry: Registry): Promise<string> {
  return registry.metrics();
}

describe('Prometheus metrics registry (DEP-050)', () => {
  it('[DEP-050] registers every metric the spec lists, with the spec names', async () => {
    const { registry, recorders } = createMetrics(new Registry());
    recorders.recordProviderRequest(PROVIDER, 0.2);
    recorders.setQuotaUsed('repository-data', 'background', 3);
    recorders.setQuotaLimit('repository-data', 1000);
    recorders.recordRun('migrate', 'succeeded', 42);
    recorders.setMigrations(
      { route: 'bitbucket-to-github', status: 'running', readiness: 'ready' },
      2,
    );
    recorders.setQueueJobs('general', 'waiting', 5);

    const text = await scrape(registry);
    for (const name of [
      'gm_provider_requests_total',
      'gm_provider_request_duration_seconds',
      'gm_quota_used',
      'gm_quota_limit',
      'gm_runs_total',
      'gm_run_duration_seconds',
      'gm_migrations',
      'gm_queue_jobs',
    ]) {
      expect(text, name).toContain(`# TYPE ${name} `);
    }
  });

  it('[ADP-060] the provider request metrics carry exactly the provider, endpoint, bucket and status labels', async () => {
    const { registry, recorders } = createMetrics(new Registry());
    recorders.recordProviderRequest(PROVIDER, 0.3);
    const text = await scrape(registry);
    expect(text).toContain(
      'gm_provider_requests_total{provider="bitbucket-cloud",endpoint="bb-main",bucket="repository-data",status="429"} 1',
    );
    expect(text).not.toMatch(/gm_provider_requests_total\{[^}]*method=/);
    expect(text).toContain(
      'gm_provider_request_duration_seconds_bucket{le="0.5",provider="bitbucket-cloud",endpoint="bb-main",bucket="repository-data",status="429"} 1',
    );
  });

  it('[DEP-050] quota, run, migration and queue metrics use their label names', async () => {
    const { registry, recorders } = createMetrics(new Registry());
    recorders.setQuotaUsed('b', 'interactive', 1);
    recorders.recordRun('k', 's', 1);
    recorders.setMigrations({ route: 'r', status: 'st', readiness: 'rd' }, 1);
    recorders.setQueueJobs('q', 'delayed', 1);
    const text = await scrape(registry);
    expect(text).toContain('gm_quota_used{bucket="b",pool="interactive"} 1');
    expect(text).toContain('gm_runs_total{kind="k",status="s"} 1');
    expect(text).toContain('gm_migrations{route="r",status="st",readiness="rd"} 1');
    expect(text).toContain('gm_queue_jobs{queue="q",state="delayed"} 1');
  });

  it('[ADP-060] the recorders reject a quota pool or an HTTP status the spec does not name, at compile time', () => {
    const { recorders } = createMetrics(new Registry());
    // @ts-expect-error the pool must be background or interactive (JOB-041)
    recorders.setQuotaUsed('repository-data', 'urgent', 1);
    // @ts-expect-error the status label is an HTTP status code as text, not a word
    const badStatus: ProviderRequestLabels = { ...PROVIDER, status: 'ok' };
    const goodStatus: HttpStatusLabel = '200';
    expect(badStatus.status).toBe('ok');
    expect(goodStatus).toBe('200');
  });

  it('[DEP-050] includes the Node default metrics alongside the gm_ metrics', async () => {
    const { registry } = createMetrics(new Registry());
    const text = await scrape(registry);
    expect(text).toContain('process_cpu_user_seconds_total');
    expect(text).toContain('nodejs_');
  });

  it('[DEP-050] histograms use the bucket layout chosen for each metric', async () => {
    const { registry, recorders } = createMetrics(new Registry());
    recorders.recordProviderRequest({ ...PROVIDER, status: '200' }, 0.2);
    recorders.recordRun('migrate', 'succeeded', 42);
    const text = await scrape(registry);
    expect(text).toContain(
      'gm_provider_request_duration_seconds_bucket{le="0.25",provider="bitbucket-cloud",endpoint="bb-main",bucket="repository-data",status="200"} 1',
    );
    expect(text).toContain('gm_run_duration_seconds_bucket{le="60",kind="migrate"} 1');
  });

  it('[DEP-050] gives each process a fresh registry; a second registration on the same registry is refused', () => {
    const registry = new Registry();
    createMetrics(registry);
    expect(() => createMetrics(registry)).toThrow(/already been registered|already registered/i);
    expect(() => createMetrics(new Registry())).not.toThrow();
  });

  it('[DEP-050] creates its own registry when none is passed', async () => {
    const { registry } = createMetrics();
    expect(registry).toBeInstanceOf(Registry);
    expect(await scrape(registry)).toContain('gm_queue_jobs');
  });
});
