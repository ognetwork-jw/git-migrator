/**
 * Adapter, Facet driver and git-access contracts (ADP-010 to ADP-014, ADP-070;
 * docs/spec/04-adapter-contract.md). Names may gain fields; they must not lose them.
 */
import type { FacetKey } from '@git-migrator/canonical';
import type { FacetCapability, FieldDecision, FieldPath, FieldSupport } from '@git-migrator/core';
import type { BucketSpec } from '@git-migrator/quota';
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
  /** When the provider created the repository (second resolution); used to tell ours from foreign. */
  readonly createdAt?: Date;
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
  /**
   * Pending invitations. `createdAt` is set where the provider tells it: a caller that looks for an
   * invitation it may have sent uses it to tell that one apart from an older one for the same
   * address (AUTH-061).
   */
  listPending(): Promise<
    { providerInvitationId: string; email?: string; inviteeLogin?: string; createdAt?: Date }[]
  >;
  /** Failed and expired invitations, with `createdAt` and `failedAt` where the provider tells them. */
  listFailed(): Promise<
    {
      providerInvitationId: string;
      email?: string;
      reason: string;
      createdAt?: Date;
      failedAt?: Date;
    }[]
  >;
  /**
   * Withdraws a pending invitation (the revoke flow of AUTH-060). An invitation that is already
   * gone (accepted, expired or cancelled) is not an error: the result says whether one was removed.
   */
  cancel(providerInvitationId: string): Promise<{ cancelled: boolean }>;
}

export interface SourceLock {
  /**
   * Applies the lock. With `originals` (from `originals()`, taken before), a resource the lock
   * updates in place is written only while it still shows its original; otherwise the call fails
   * instead, so any update the framework makes is over exactly the recorded original.
   */
  apply(
    ref: RepositoryRef,
    ctx: { targetWebUrl: string; originals?: readonly MutationRecord[] },
  ): Promise<MutationRecord[]>;
  undo(ref: RepositoryRef, mutations: MutationRecord[]): Promise<MutationRecord[]>;
  /**
   * Reads the source for state shaped like the lock and returns one record per piece found, flagged
   * `resourceRef.possiblyFramework`. Used to make an unrecorded lock (a crash, a lost response)
   * undoable, and to check after undo that none remains. A record of a resource updated in place
   * carries `before` only when `originals` hold that resource's original and the lock written over
   * it explains what the source shows; otherwise `before` is `null` and the record cannot be
   * undone. `before` is never inferred from the current state. Writes nothing.
   */
  inspect?(
    ref: RepositoryRef,
    options?: { originals?: readonly MutationRecord[] },
  ): Promise<MutationRecord[]>;
  /**
   * Reads the current state of every resource the lock updates in place, whatever its shape, as
   * `update` records whose `after` is that state (`before` is `null`). Kept as part of a baseline
   * before any write. Writes nothing.
   */
  originals?(ref: RepositoryRef): Promise<MutationRecord[]>;
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
  /**
   * The quota bucket that the git smart-HTTP requests of this credential count in (JOB-040), when
   * the provider meters them. The `git` package pre-acquires units in it before every command
   * (JOB-041); without it git commands are not metered here.
   */
  readonly quota?: BucketSpec;
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
  | {
      scope: 'repository';
      repository: RepositoryRef;
      namespace: NamespaceRef;
      /**
       * Source reads only: the `resourceRef` of every resource the framework created or holds on the
       * source (the read-only lock, LIF-070). A driver leaves them out of what it reads, before it
       * combines resources into the canonical document, so the document is what the source would
       * hold without them (LIF-045). Drivers of Facets the lock does not touch ignore it.
       */
      frameworkResources?: readonly Readonly<Record<string, unknown>>[];
    }
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
  /**
   * Per-read refinements of the static capability, for facts only the live provider knows (for
   * example an organization that forbids a setting). Merged over `ProviderCapabilities` by the
   * analysis (ADR-0230).
   */
  capabilities?: Record<FieldPath, FieldSupport>;
  /**
   * In-memory content that `data` refers to only by hash, keyed by that hash (sha256, lowercase
   * hex). For example the text of a pipeline definition file, which the canonical document keeps
   * as a hash. Never persisted, captured or logged (ADR-0311): the Analysis hands it to `translate`
   * through the route index and drops it.
   */
  attachments?: Record<string, string>;
}

export interface DriverContext {
  http: ProviderHttpClient;
  git: GitClient;
  logger: Logger;
  pool: 'background' | 'interactive';
  signal: AbortSignal;
}

/**
 * Why an `undo` left a resource as it is (ADR-0467 rounds 2 and 4). Provider-neutral: guidance
 * renders each kind in the glossary's terms, and code never builds the sentence.
 * - `group-unproven`: a Group holds the name, but the record does not name its provider id.
 * - `group-renamed`: the Group the record names now has another name.
 * - `group-has-children`: deleting the Group would delete its child Groups.
 * - `group-changed`: the Group changed between the read and the delete (renamed, replaced or given
 *   child Groups meanwhile).
 * - `group-in-use`: a repository Migration of the Route still grants the Group access.
 * - `group-membership-in-use`: a membership of a Group that is still in use.
 * - `branch-rule-replaced`: the rule the record names is gone or was replaced.
 * - `branch-rule-exists`: a lifted rule exists again under its pattern.
 * - `repository-earlier`: a repository an earlier Run created, which is not this Migration's target.
 */
export const UNDO_LEFT_KINDS = [
  'group-unproven',
  'group-renamed',
  'group-has-children',
  'group-changed',
  'group-in-use',
  'group-membership-in-use',
  'branch-rule-replaced',
  'branch-rule-exists',
  'repository-earlier',
] as const;
export type UndoLeftKind = (typeof UNDO_LEFT_KINDS)[number];

/** One thing a rollback left: its kind and the name an operator finds it by. */
export interface UndoLeftEntry {
  readonly kind: UndoLeftKind;
  readonly name: string;
}

/** An `undo` that left the resource as it is, and why (ADR-0467 round 2). */
export interface UndoLeft {
  readonly left: UndoLeftEntry;
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
  /**
   * Reverts ONE `MutationRecord` this driver yielded (rollback of an adopted target, LIF-077): a
   * `create` is deleted, an `update` is written back to `before`, a `delete` is created again from
   * `before`. Idempotent: state that is already gone or already restored is not an error, because
   * the record may be an unconfirmed intent (ADR-0342). It touches only the resource the record
   * names (`resourceRef`), never the rest of the document, and it never deletes anything the record
   * does not name. When the resource is no longer provably the one the record names (a team that was
   * renamed, replaced or has since gained child teams; a principal that cannot be resolved), it
   * changes nothing and returns `{left: {kind, name}}`: the caller keeps the record undoable and
   * reports it; it never counts as undone. A record of a kind the driver did not yield is refused with `invalid`.
   */
  undo?(
    ctx: DriverContext,
    target: FacetTarget,
    mutation: MutationRecord,
  ): Promise<void | UndoLeft>;
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
    /**
     * Looks a repository up by its provider id, wherever it is named now. `null` only when the
     * provider positively says it is gone; a provider that cannot tell (the credential sees only
     * some repositories) throws `forbidden`. Rollback uses it to tell "deleted" from "not visible"
     * and from "renamed" (ADR-0465 round 2).
     */
    findRepositoryById?(providerId: string): Promise<RepositoryRecord | null>;
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
