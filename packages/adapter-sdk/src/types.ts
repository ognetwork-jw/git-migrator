/**
 * Adapter, Facet driver and git-access contracts (ADP-010 to ADP-014, ADP-070;
 * docs/spec/04-adapter-contract.md). Names may gain fields; they must not lose them.
 */
import type { FacetKey } from '@git-migrator/canonical';
import type { FacetCapability, FieldDecision, FieldPath } from '@git-migrator/core';
import type { ZodType } from 'zod';
import type { ProviderHttpClient, ProviderHttpEnvironment } from './http.ts';
import type { Logger } from './logger.ts';

/** One page of a listing. `nextCursor` is opaque to callers; absent on the last page. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface NamespaceLevel {
  readonly kind: string;
  readonly label: string;
  readonly holdsRepositories: boolean;
}

export interface NamespaceRef {
  /** Provider-stable id. */
  readonly providerId: string;
  readonly slug: string;
}

export interface RepositoryRef {
  readonly providerId: string;
  readonly namespace: NamespaceRef;
  readonly slug: string;
}

export interface NamespaceRecord {
  readonly providerId: string;
  readonly parentProviderId?: string;
  /** Adapter-defined label, display only. */
  readonly kind: string;
  readonly slug: string;
  readonly key?: string;
  readonly name: string;
}

export interface RepositoryRecord {
  readonly providerId: string;
  readonly namespace: NamespaceRef;
  readonly slug: string;
  readonly name: string;
  /** Display path, for example `ws/PROJ/repo`. */
  readonly fullPath: string;
  readonly isPrivate: boolean;
  readonly sizeBytes?: number;
  readonly defaultBranch?: string | null;
  readonly providerUpdatedAt?: Date;
}

export interface IdentityRecord {
  readonly providerId: string;
  readonly login?: string;
  readonly displayName?: string;
  readonly email?: string;
  /** `provider-public`, `csv` or an adapter-defined source. */
  readonly emailSource?: string;
  readonly kind: 'user' | 'bot';
  /** Member of the endpoint's root namespace. */
  readonly isMember: boolean;
}

export interface GroupRecord {
  readonly providerId: string;
  readonly slug: string;
  readonly name: string;
  /** Provider ids of the member identities. */
  readonly memberProviderIds: readonly string[];
}

export interface CreateRepositorySpec {
  readonly name: string;
  readonly visibility: 'private' | 'public';
  readonly description: string;
}

/** One provider-side change; feeds the Mutation ledger (ADP-012, LIF-045). */
export interface MutationRecord {
  /** `null` for repository-level operations. */
  readonly facetKey: string | null;
  readonly action: 'create' | 'update' | 'delete';
  /** Adapter-defined; sufficient to undo and to filter (LIF-045). */
  readonly resourceRef: Record<string, unknown>;
  readonly paths: readonly FieldPath[];
  readonly before: unknown | null;
  readonly after: unknown | null;
}

export type ChangeRequestState = 'open' | 'merged' | 'closed';

export interface ChangeRequestWriter {
  upsert(
    ref: RepositoryRef,
    req: {
      purpose: string;
      branch: string;
      title: string;
      body: string;
      files: { path: string; content: string }[];
    },
  ): Promise<{ url: string; state: ChangeRequestState; mutations: MutationRecord[] }>;
  status(ref: RepositoryRef, purpose: string): Promise<'none' | ChangeRequestState>;
  close(ref: RepositoryRef, purpose: string): Promise<MutationRecord[]>;
}

export interface InvitationWriter {
  invite(req: { email: string; teamIds: string[] }): Promise<{ providerInvitationId: string }>;
  listPending(): Promise<{ providerInvitationId: string; email?: string; inviteeLogin?: string }[]>;
  listFailed(): Promise<{ providerInvitationId: string; email?: string; reason: string }[]>;
}

export interface SourceLock {
  apply(ref: RepositoryRef, ctx: { targetWebUrl: string }): Promise<MutationRecord[]>;
  undo(ref: RepositoryRef, mutations: MutationRecord[]): Promise<MutationRecord[]>;
}

export interface ProviderLimits {
  maxBlobBytes?: number;
  maxPushBytes?: number;
  repositoryName: { maxLength: number; pattern: RegExp; caseInsensitiveUnique: boolean };
  /** Refs the provider refuses or never exposes. */
  hiddenRefPrefixes: string[];
}

/** Git transport access (ADP-070). Credentials never go into the URL. */
export interface GitCredential {
  readonly username: string;
  readonly password: string;
  readonly expiresAt?: Date;
}

export interface GitAccess {
  /** https URL without credentials. */
  remoteUrl(repo: RepositoryRef): string;
  credential(repo: RepositoryRef): Promise<GitCredential>;
}

/** One ref from `ls-remote` (FAC-GIT-001). */
export interface GitRemoteRef {
  readonly name: string;
  /** For an annotated tag, the tag object sha. */
  readonly sha: string;
  /** For an annotated tag, the commit it points to. */
  readonly peeled?: string;
}

export interface GitLsRemoteResult {
  readonly refs: readonly GitRemoteRef[];
  /** The ref `HEAD` points to (`--symref`). */
  readonly headSymref?: string;
}

/**
 * The git transport an adapter may use without importing `packages/git`, which implements it.
 * The git package pre-acquires quota units itself (JOB-041).
 */
export interface GitClient {
  lsRemote(request: {
    url: string;
    credential: GitCredential;
    signal?: AbortSignal;
  }): Promise<GitLsRemoteResult>;
}

export type FacetTarget =
  | { scope: 'repository'; repository: RepositoryRef; namespace: NamespaceRef }
  | { scope: 'endpoint'; namespace: NamespaceRef };

export interface AdapterWarning {
  readonly code: string;
  readonly paths: readonly FieldPath[];
  readonly params: Record<string, unknown>;
}

export interface FacetRead<T> {
  /** Canonical, valid per facet schema. */
  data: T;
  /** For example secret values. */
  unreadable: FieldPath[];
  warnings: AdapterWarning[];
  rawResponseIds: string[];
}

export interface DriverContext {
  http: ProviderHttpClient;
  git: GitClient;
  logger: Logger;
  pool: 'background' | 'interactive';
  signal: AbortSignal;
}

/** ADP-011. `apply` is idempotent and yields one MutationRecord per provider-side change (ADP-012). */
export interface FacetDriver<T> {
  read(ctx: DriverContext, target: FacetTarget): Promise<FacetRead<T>>;
  apply?(
    ctx: DriverContext,
    target: FacetTarget,
    desired: T,
    current: T | null,
    plan: FieldDecision[],
  ): AsyncIterable<MutationRecord>;
}

/** ADP-014. Per Facet, what the provider can read, write and represent. */
export interface ProviderCapabilities {
  facets: Partial<Record<FacetKey, FacetCapability>>;
}

export interface EndpointConnection {
  inventory: {
    listNamespaces(cursor?: string): Promise<Page<NamespaceRecord>>;
    listRepositories(ns: NamespaceRef, cursor?: string): Promise<Page<RepositoryRecord>>;
    getRepository(ref: RepositoryRef): Promise<RepositoryRecord | null>;
    findRepository(ns: NamespaceRef, name: string): Promise<RepositoryRecord | null>;
    listIdentities(cursor?: string): Promise<Page<IdentityRecord>>;
    /** Includes member ids. */
    listGroups(cursor?: string): Promise<Page<GroupRecord>>;
  };
  repositories: {
    create(ns: NamespaceRef, spec: CreateRepositorySpec): Promise<RepositoryRecord>;
    delete(ref: RepositoryRef): Promise<void>;
    isEmpty(ref: RepositoryRef): Promise<boolean>;
  };
  git: GitAccess;
  facets: Partial<Record<FacetKey, FacetDriver<unknown>>>;
  refs: {
    setDefaultBranch(ref: RepositoryRef, branch: string): Promise<MutationRecord>;
    compare(
      ref: RepositoryRef,
      base: string,
      head: string,
    ): Promise<'identical' | 'ahead' | 'behind' | 'diverged'>;
  };
  lfs: {
    /** Returns the OIDs that are absent on the provider. */
    missing(ref: RepositoryRef, oids: string[]): Promise<string[]>;
  };
  changeRequests?: ChangeRequestWriter;
  invitations?: InvitationWriter;
  sourceLock?: SourceLock;
  org?: { seatInfo(): Promise<{ total?: number; filled?: number }> };
  limits: ProviderLimits;
  /**
   * The connection's HTTP client. The runner puts it into the `DriverContext` it builds, so every
   * driver call goes through the client and the quota service (ADR-0190).
   */
  http: ProviderHttpClient;
}

/** What the runner hands to `connect` for one Endpoint and one selected credential (JOB-042). */
export interface EndpointRuntime {
  /** The Endpoint's config slug. */
  readonly id: string;
  readonly baseUrl: string;
  /** Validated with `configSchema`. */
  readonly config: unknown;
  /** The credential chosen for this job, validated with `credentialSchema`. */
  readonly credential: unknown;
  /** Whose limit this credential consumes (JOB-040). Credentials of one account share it. */
  readonly accountKey: string;
}

/** Everything an adapter needs to build its `ProviderHttpClient`, plus git. */
export interface AdapterContext extends ProviderHttpEnvironment {
  readonly git: GitClient;
  readonly pool: 'background' | 'interactive';
  readonly signal: AbortSignal;
}

export interface ProviderAdapter {
  /** Adapter type slug. */
  readonly type: string;
  readonly displayName: string;
  /** Outermost first. */
  readonly namespaceLevels: readonly NamespaceLevel[];
  readonly capabilities: ProviderCapabilities;
  /** Endpoint options. */
  readonly configSchema: ZodType<unknown>;
  readonly credentialSchema: ZodType<unknown>;
  connect(endpoint: EndpointRuntime, ctx: AdapterContext): Promise<EndpointConnection>;
}
