import { z } from 'zod';
import type { JobName } from './queues.ts';

const id = z.string().min(1).max(200);

const empty = z.strictObject({});

/**
 * Job payloads (JOB-011). A payload carries IDs only, never secrets, and every object is strict so
 * a stray field (a token, a URL with credentials) is refused on enqueue and on processing.
 */
export const JOB_PAYLOADS = {
  'inventory.endpoint': z.strictObject({ endpointId: id }),
  'inventory.namespace': z.strictObject({ endpointId: id, namespaceId: id }),
  'analysis.migration': z.strictObject({ migrationId: id }),
  'run.execute': z.strictObject({ runId: id }),
  'parity.migration': z.strictObject({ migrationId: id }),
  'drift.sweep': empty,
  'maintenance.prune': empty,
  'maintenance.scratch-cleanup': empty,
  'maintenance.run-reaper': empty,
  'analysis.feeder': empty,
} as const satisfies Record<JobName, z.ZodType>;

export type JobPayloads = { [N in JobName]: z.infer<(typeof JOB_PAYLOADS)[N]> };

export class InvalidPayloadError extends Error {
  readonly job: JobName;
  constructor(job: JobName, issues: string) {
    super(`Invalid payload for ${job}: ${issues}`);
    this.name = 'InvalidPayloadError';
    this.job = job;
  }
}

/** Parses `data` for `job`; throws `InvalidPayloadError` naming the paths, never the values. */
export function parsePayload<N extends JobName>(job: N, data: unknown): JobPayloads[N] {
  const result = JOB_PAYLOADS[job].safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new InvalidPayloadError(job, issues);
  }
  return result.data as JobPayloads[N];
}

export function isJobName(name: string): name is JobName {
  return Object.hasOwn(JOB_PAYLOADS, name);
}
