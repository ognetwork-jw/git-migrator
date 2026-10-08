import type { Level, Permissions } from './types.ts';

/** The permissions of the framework's App as listed in the provider doc ("Required App permissions"). */
export const DEFAULT_APP_PERMISSIONS: Permissions = {
  administration: 'write',
  contents: 'write',
  workflows: 'write',
  pull_requests: 'write',
  secrets: 'write',
  actions_variables: 'write',
  environments: 'write',
  repository_hooks: 'write',
  actions: 'read',
  metadata: 'read',
  members: 'write',
  organization_plan: 'read',
  organization_secrets: 'write',
  organization_actions_variables: 'write',
  organization_hooks: 'write',
};

export const LEVELS: readonly Level[] = ['read', 'write', 'admin'];

export interface InstallationSeed {
  id?: number;
  /** Organization login. The organization is created when it does not exist. */
  account: string;
  permissions?: Permissions;
  repositorySelection?: 'all' | 'selected';
  repositories?: string[];
}

export interface AppSeed {
  id?: number;
  slug?: string;
  name?: string;
  /** Also accepted as the JWT `iss`, like the client id on GitHub. */
  clientId?: string;
  permissions?: Permissions;
}

/** Per-resource primary limits. Omitted resources use the formula from the provider doc. */
export interface PrimaryLimitConfig {
  /** Fixed window length in ms. Default one hour. */
  windowMs?: number;
  limits?: Partial<Record<'core' | 'graphql' | 'search', number>>;
  /** 403 (default) or 429 when the primary limit is exceeded. */
  status?: 403 | 429;
}

/** Secondary limits (provider doc "Secondary"). Set a number to `null` to disable it. */
export interface SecondaryLimitConfig {
  /** Concurrent requests (default 100). */
  concurrent?: number | null;
  /** Points per minute per REST endpoint (default 900). GET/HEAD = 1, mutating = 5. */
  restPointsPerMinute?: number | null;
  /** GraphQL points per minute (default 2000). Query = 1, mutation = 5. */
  graphqlPointsPerMinute?: number | null;
  /** Content creation requests per minute and hour (defaults 80 and 500). */
  contentCreationPerMinute?: number | null;
  contentCreationPerHour?: number | null;
  /** 403 (default) or 429. */
  status?: 403 | 429;
  /** Send `retry-after` (default true). Without it, only the `x-ratelimit-*` rule is left to clients. */
  retryAfter?: boolean;
}

/**
 * Forces the next `requests` requests to be rejected with a secondary limit response, regardless of
 * counters. For tests of the client's backoff.
 */
export interface ForcedSecondaryLimit {
  requests: number;
  retryAfterSeconds?: number;
  status?: 403 | 429;
  /** Send `retry-after` (default true). */
  retryAfter?: boolean;
  /** Only requests whose `METHOD /path` matches this regular expression are rejected. */
  match?: string;
}

export interface RuntimeConfig {
  primary: PrimaryLimitConfig;
  secondary: SecondaryLimitConfig;
  forced: ForcedSecondaryLimit | null;
  /** `DELETE /repos/{o}/{r}` answers 403 for every installation token (LIF-077). */
  repositoryDeletion: 'allowed' | 'forbidden';
  /** Maximum blob size for `POST /git/blobs` and LFS uploads (TST-013), bytes. Default 100 MiB. */
  maxBlobBytes: number;
  /**
   * How environment protection rules (`reviewers`, `wait_timer`) behave on private repositories of a
   * Team organization (provider doc, Quirks). `reject` (default) answers 422, `ignore` drops them.
   */
  environmentProtection: 'reject' | 'ignore';
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  primary: {},
  secondary: {},
  forced: null,
  repositoryDeletion: 'allowed',
  maxBlobBytes: 100 * 1024 * 1024,
  environmentProtection: 'reject',
};

export interface FakeGitHubOptions {
  /** Defaults to the wall clock. Tests inject one to control expiry and rate-limit windows. */
  clock?: () => number;
  app?: AppSeed;
  /** Default: one installation on the organization `acme` with the permissions above. */
  installations?: InstallationSeed[];
  /**
   * Base URL of the git server's `target` side (T-040, ADR-0070). Clone URLs are
   * `{gitBaseUrl}/{owner}/{name}.git`. Default `http://localhost:4030/target`.
   */
  gitBaseUrl?: string;
  /** Initial runtime configuration; also overridable per reset and via `POST /__config`. */
  config?: Partial<RuntimeConfig>;
  /** Named fixtures for `POST /__reset`, run against freshly reset state. `empty` is built in. */
  fixtures?: Record<string, (state: import('./state.ts').GitHubState) => void | Promise<void>>;
  /**
   * Allowed `iat` clock skew in seconds. GitHub rejects an `iat` in the future, which is why the docs
   * suggest backdating it by 60 s. Default 0.
   */
  jwtClockSkewSeconds?: number;
  /** How long `/__reset` waits for in-flight requests before wiping anyway (stragglers get 409). Default 10000. */
  resetDrainMs?: number;
  /**
   * LFS existence hook for the batch API. Default: the in-memory `RepoRecord.lfs`. T-043 can
   * point this at T-040's LFS store.
   */
  lfsHas?: (
    repo: import('./types.ts').RepoRec,
    oid: string,
  ) => number | undefined | Promise<number | undefined>;
  /**
   * Called after a repository is created, renamed or deleted through the REST API, so the git server
   * (T-040) can create, move or drop the bare repository (ADR-0070). Builders such as
   * `state.addRepository` do not call them: fixtures seed the git server themselves.
   */
  repositoryHooks?: {
    created?: (repo: import('./types.ts').RepoRec) => void | Promise<void>;
    renamed?: (repo: import('./types.ts').RepoRec, oldName: string) => void | Promise<void>;
    deleted?: (repo: import('./types.ts').RepoRec) => void | Promise<void>;
    /**
     * Called synchronously, in the same mutation, when a repository gains its first or loses its last
     * branch protection rule (`active`). The git wiring keeps the pre-receive policy flag in step.
     */
    policyChanged?: (repo: import('./types.ts').RepoRec, active: boolean) => void;
  };
  /** PEM public key of the App. When set, JWT signatures are verified; by default any key is accepted. */
  appPublicKeyPem?: string;
}
