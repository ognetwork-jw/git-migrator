/**
 * What the Steps of a migrate, run-anyway or resync Run need from the process (LIF-040 steps 1 to
 * 12): adapters through the connector, the git service, scratch space and the quota gates. The
 * worker builds one `MigrationServices` and passes it as `services` to the Run executor.
 * Decisions: docs/adr/0380-migration-steps.md.
 */
import type {
  DriverContext,
  EndpointConnection,
  GitCredential,
  QuotaGate,
  RepositoryRef,
} from '@git-migrator/adapter-sdk';
import type { Config } from '@git-migrator/config';
import type { Db } from '@git-migrator/db';
import {
  createGitQuota,
  type GitQuota,
  GitService,
  type GitServiceOptions,
} from '@git-migrator/git';
import type { Logger } from '@git-migrator/observability';
import type { QuotaService } from '@git-migrator/quota';
import type { ProviderRegistry } from '@git-migrator/registry';
import type { EndpointConnector } from '../inventory/connector.ts';
import { StepFailure } from '../run/errors.ts';
import type { StepContext, StepDefinition } from '../run/types.ts';

/**
 * The link a Change Request body carries to the Migration (LIF-047 step 3). The adapter asks for
 * it by repository, so the Steps note which Migration a target repository belongs to first.
 */
export class MigrationLinks {
  readonly #links = new Map<string, string>();
  readonly #base: string;

  constructor(publicUrl: string) {
    this.#base = publicUrl.replace(/\/+$/, '');
  }

  note(targetRepositoryProviderId: string, migrationId: string): void {
    this.#links.set(targetRepositoryProviderId, `${this.#base}/repositories/${migrationId}`);
  }

  /** The `migrationUrl` option of the adapter. */
  resolve = (repo: RepositoryRef): string | undefined => this.#links.get(repo.providerId);
}

export interface MigrationServices {
  /** The privileged client, for reads. Writes go through `ctx.transaction`. */
  readonly db: Db;
  readonly connector: EndpointConnector;
  readonly registry: Pick<
    ProviderRegistry,
    'facets' | 'adapter' | 'capabilities' | 'pipelinesDelivery'
  >;
  readonly config: Pick<Config, 'git' | 'sizeClass'>;
  /** Pre-acquires git units (JOB-041) and answers the preflight quota question (LIF-041). */
  readonly quota: Pick<QuotaGate, 'acquire'> & Pick<QuotaService, 'freeCapacity'>;
  /** `$GM_SCRATCH_DIR` (JOB-015). */
  readonly scratchRoot: string;
  readonly links: MigrationLinks;
  readonly logger: Logger;
  /**
   * Re-analyzes the Migration at the end of a Run, so an Analysis taken meanwhile is superseded
   * (T-062 follow-up). Resolves when the Analysis is stored or was dropped as superseded.
   */
  readonly reanalyze: (migrationId: string, signal: AbortSignal) => Promise<void>;
  /** Test seam: the git service factory. */
  readonly createGit?: (options: GitServiceOptions) => GitService;
  /**
   * Steps of later tasks that belong to the same Run kinds by key: `verify` (T-072) and
   * `source.read-only` (T-073). The planner uses the definition whose key the Plan lists.
   */
  readonly extraSteps?: ReadonlyMap<string, StepDefinition<MigrationServices>>;
  readonly now?: () => Date;
}

export type MigrationContext = StepContext<MigrationServices>;

/** One connected Endpoint of the Route, with the transports a Step needs. */
export interface Side {
  readonly endpointId: string;
  readonly providerType: string;
  readonly connection: EndpointConnection;
  /** The context drivers run in; every provider call goes through the quota-aware client. */
  readonly driver: DriverContext;
  /** Quota-aware git transport of this Endpoint's credential (JOB-041). */
  readonly git: GitService;
}

/** Connects to an Endpoint for the Run (interactive pool: an operator is waiting, JOB-041). */
export async function connectSide(
  ctx: MigrationContext,
  endpointId: string,
  providerType: string,
): Promise<Side> {
  const { services } = ctx;
  if (ctx.scratchDir === undefined) {
    throw new StepFailure(
      'scratch.unavailable',
      'The Run has no scratch directory, so git cannot be used',
    );
  }
  const connection = await services.connector.connect(endpointId, {
    pool: 'interactive',
    signal: ctx.signal,
  });
  const spec = connection.git.quota;
  const quota: GitQuota = spec
    ? createGitQuota({
        gate: services.quota,
        bucketKey: spec.key,
        limit: spec.limit,
        windowSeconds: spec.windowSeconds,
        pool: 'interactive',
        ...(services.now ? { now: services.now } : {}),
      })
    : { acquire: async () => undefined };
  const options: GitServiceOptions = {
    quota,
    scratchDir: ctx.scratchDir,
    logger: services.logger,
    maxPushBytes: effectiveMaxPushBytes(services.config.git.maxPushBytes, connection),
    lfsConcurrentTransfers: services.config.git.maxConcurrentLfsTransfers,
  };
  const git = services.createGit ? services.createGit(options) : new GitService(options);
  return {
    endpointId,
    providerType,
    connection,
    git,
    driver: {
      http: connection.http,
      git,
      logger: ctx.log as never,
      pool: 'interactive',
      signal: ctx.signal,
    },
  };
}

/** `git.maxPushBytes`, but never above what the provider accepts (LIF-044). */
export function effectiveMaxPushBytes(
  configured: number,
  connection: Pick<EndpointConnection, 'limits'>,
): number {
  const limit = connection.limits.maxPushBytes;
  return limit === undefined ? configured : Math.min(configured, limit);
}

/** The credential for git on `repo`, never logged. */
export async function gitCredentialOf(
  side: Side,
  repo: RepositoryRef,
): Promise<{ url: string; credential: GitCredential }> {
  return {
    url: side.connection.git.remoteUrl(repo),
    credential: await side.connection.git.credential(repo),
  };
}
