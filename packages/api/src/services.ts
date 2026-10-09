import type { JobRuntime } from '@git-migrator/jobs';
import type { QuotaService } from '@git-migrator/quota';
import type { ProviderRegistry } from '@git-migrator/registry';
import { ProblemError } from './problem.ts';

/**
 * The collaborators of the endpoints that enqueue jobs or read process-wide services (API-010).
 * The process owner builds them (the web process passes a producer-only `JobRuntime`, the shared
 * `QuotaService` and the built-in registry) and `createApiApp` only uses them. Each one is
 * optional so a process or a test that does not need an endpoint can leave its service out; the
 * endpoint then answers 503 `not_ready` (ADR-0330).
 */
export interface ApiServices {
  /** Producer side of the job queues (JOB-010, JOB-011). */
  readonly jobs: Pick<
    JobRuntime,
    | 'enqueue'
    | 'enqueueAnalysis'
    | 'enqueueInvitationStep'
    | 'enqueueParity'
    | 'enqueueRun'
    | 'queue'
  >;
  /** `GET /quota` (JOB-047). */
  readonly quota: Pick<QuotaService, 'snapshot'>;
  /** `GET /capability-matrix`, `POST /routes/{id}/naming/preview`, the `GET /migrations/{id}/diff` facet list. */
  readonly registry: Pick<
    ProviderRegistry,
    'capabilityMatrix' | 'repositoryNameLimits' | 'facets' | 'validateOverlay'
  >;
}

export type ServiceName = keyof ApiServices;

/** The service, or a 503 `not_ready` problem naming the one that is missing. */
export function requireService<K extends ServiceName>(
  services: Partial<ApiServices>,
  name: K,
): ApiServices[K] {
  const service = services[name];
  if (service === undefined) {
    throw new ProblemError('not_ready', { detail: `the ${name} service is not configured` });
  }
  return service as ApiServices[K];
}
