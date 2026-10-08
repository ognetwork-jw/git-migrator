import type {
  LeaseGate,
  ProviderHttpEnvironment,
  ProviderSpan,
  ProviderTelemetry,
  QuotaGate,
  RawCaptureSink,
} from '@git-migrator/adapter-sdk';
import type { Db } from '@git-migrator/db';
import type { Logger, MetricRecorders } from '@git-migrator/observability';
import { SpanStatusCode, type Tracer, trace } from '@opentelemetry/api';

/**
 * `RawCaptureSink` over the `RawResponse` table (ADP-061). The input is already stripped of
 * secrets by the client. The table has no header column, so headers are not stored; `body` is
 * stored as JSON (or SQL NULL when the response had none).
 */
export function createRawCaptureSink(db: Db): RawCaptureSink {
  return {
    async save(input) {
      const row = await db.rawResponse.create({
        data: {
          endpointId: input.endpointId,
          method: input.method,
          url: input.url,
          status: input.status,
          fetchedAt: input.fetchedAt,
          ...(input.body === undefined || input.body === null ? {} : { body: input.body as never }),
        },
        select: { id: true },
      });
      return row.id;
    },
  };
}

/**
 * Maps `ProviderTelemetry` (ADP-060) onto the `gm_provider_*` recorders and the OpenTelemetry
 * tracer: one span per provider request, with the stripped error message on failure.
 */
export function createProviderTelemetry(
  recorders: Pick<MetricRecorders, 'recordProviderRequest'>,
  tracer: Tracer = trace.getTracer('git-migrator-provider'),
): ProviderTelemetry {
  return {
    startSpan(name, attributes): ProviderSpan {
      const span = tracer.startSpan(name, { attributes });
      return {
        setAttributes: (more) => void span.setAttributes(more),
        end(error) {
          if (error !== undefined) span.setStatus({ code: SpanStatusCode.ERROR, message: error });
          span.end();
        },
      };
    },
    recordRequest: (labels, durationSeconds) =>
      // The client labels the status with a code like "200", or "error" for no response; the
      // recorder's label type is the numeric-string form (ADP-060).
      recorders.recordProviderRequest(
        labels as Parameters<MetricRecorders['recordProviderRequest']>[0],
        durationSeconds,
      ),
  };
}

export interface ProviderEnvironmentOptions {
  /** `QuotaService` satisfies `QuotaGate`. */
  readonly quota: QuotaGate;
  /** `QuotaLeases` satisfies `LeaseGate`. */
  readonly leases: LeaseGate;
  readonly db: Db;
  readonly recorders: Pick<MetricRecorders, 'recordProviderRequest'>;
  readonly logger: Logger;
  readonly environment?: string;
  readonly testAllowedHosts?: readonly string[];
}

/**
 * The shared pieces every adapter receives from the host (`AdapterContext`): the quota and lease
 * gates, the raw-capture sink, telemetry and the logger (T-026, ADR-0190).
 */
export function createProviderEnvironment(
  options: ProviderEnvironmentOptions,
): ProviderHttpEnvironment {
  return {
    quota: options.quota,
    leases: options.leases,
    logger: options.logger,
    capture: createRawCaptureSink(options.db),
    telemetry: createProviderTelemetry(options.recorders),
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.testAllowedHosts ? { testAllowedHosts: options.testAllowedHosts } : {}),
  };
}
