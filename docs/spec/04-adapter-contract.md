# 04 — Adapter and Facet Contract

Canonical types and their Zod schemas for every built-in Facet live in `packages/canonical`. Both adapters and facets depend on it (ADP-002, created by T-015). Adapters perform git transport reads such as `git-refs` (`ls-remote`) through `DriverContext.git`. That interface (`GitClient`) is declared in `adapter-sdk` and implemented by `packages/git`, so adapters never import `packages/git`.

Two plug-in kinds exist:

- **Provider adapters** talk to one Provider and convert between provider data and canonical Facet data.
- **Facet definitions** own a canonical schema and the provider-neutral logic: normalization, translation and comparison.

Translation is *canonical → canonical*. It is driven by the capabilities the source and target adapters declare, plus optional pair overrides. N adapters therefore need no N² translators (ADP-001).

All interfaces below are normative in shape. Names may gain fields, but MUST NOT lose them without a spec change.

## Provider adapter (ADP-010)

```ts
export interface ProviderAdapter {
  readonly type: string;                       // "bitbucket-cloud"
  readonly displayName: string;
  readonly namespaceLevels: readonly NamespaceLevel[];   // outermost first
  readonly capabilities: ProviderCapabilities;
  readonly configSchema: z.ZodType<unknown>;   // endpoint options
  readonly credentialSchema: z.ZodType<unknown>;
  connect(endpoint: EndpointRuntime, ctx: AdapterContext): Promise<EndpointConnection>;
}

export interface NamespaceLevel { kind: string; label: string; holdsRepositories: boolean }

export interface EndpointConnection {
  inventory: {
    listNamespaces(cursor?: string): Promise<Page<NamespaceRecord>>;
    listRepositories(ns: NamespaceRef, cursor?: string): Promise<Page<RepositoryRecord>>;
    getRepository(ref: RepositoryRef): Promise<RepositoryRecord | null>;
    findRepository(ns: NamespaceRef, name: string): Promise<RepositoryRecord | null>;
    listIdentities(cursor?: string): Promise<Page<IdentityRecord>>;
    listGroups(cursor?: string): Promise<Page<GroupRecord>>;      // includes member ids
  };
  repositories: {
    create(ns: NamespaceRef, spec: CreateRepositorySpec): Promise<RepositoryRecord>;
    delete(ref: RepositoryRef): Promise<void>;
    isEmpty(ref: RepositoryRef): Promise<boolean>;
  };
  git: GitAccess;                                  // remote URL + credential helper input
  facets: Partial<Record<FacetKey, FacetDriver<unknown>>>;
  refs: {
    setDefaultBranch(ref: RepositoryRef, branch: string): Promise<MutationRecord>;
    compare(ref: RepositoryRef, base: string, head: string): Promise<'identical' | 'ahead' | 'behind' | 'diverged'>;
  };
  lfs: { missing(ref: RepositoryRef, oids: string[]): Promise<string[]> };   // returns OIDs absent on the provider
  changeRequests?: ChangeRequestWriter;            // target-side file changes (LIF-047)
  invitations?: InvitationWriter;                  // target-side member invitations (AUTH-060)
  sourceLock?: SourceLock;                         // source read-only (LIF-070)
  org?: { seatInfo(): Promise<{ total?: number; filled?: number }> };
  limits: ProviderLimits;
}

export interface CreateRepositorySpec { name: string; visibility: 'private' | 'public'; description: string }

export interface ChangeRequestWriter {
  upsert(ref: RepositoryRef, req: { purpose: string; branch: string; title: string; body: string;
    files: { path: string; content: string }[] }): Promise<{ url: string; state: 'open' | 'merged' | 'closed'; mutations: MutationRecord[] }>;
  status(ref: RepositoryRef, purpose: string): Promise<'none' | 'open' | 'merged' | 'closed'>;
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

export interface MutationRecord {
  facetKey: string | null;            // null for repository-level operations
  action: 'create' | 'update' | 'delete';
  resourceRef: Record<string, unknown>;   // adapter-defined; sufficient to undo and to filter (LIF-045)
  paths: FieldPath[];                 // canonical paths affected
  before: unknown | null;
  after: unknown | null;
}

export interface DriverContext {
  http: ProviderHttpClient; git: GitClient; logger: Logger;
  pool: 'background' | 'interactive'; signal: AbortSignal;
}

export interface ProviderLimits {
  maxBlobBytes?: number;          // GitHub: 100 MiB
  maxPushBytes?: number;          // GitHub: 2 GiB
  repositoryName: { maxLength: number; pattern: RegExp; caseInsensitiveUnique: boolean };
  hiddenRefPrefixes: string[];    // refs the provider refuses or never exposes
}
```

### Facet driver (ADP-011)

```ts
export interface FacetDriver<T> {
  read(ctx: DriverContext, target: FacetTarget): Promise<FacetRead<T>>;
  apply?(ctx: DriverContext, target: FacetTarget, desired: T, current: T | null,
         plan: FieldDecision[]): AsyncIterable<MutationRecord>;
}

export interface FacetRead<T> {
  data: T;                         // canonical, valid per facet schema
  unreadable: FieldPath[];         // e.g. secret values
  warnings: AdapterWarning[];
  rawResponseIds: string[];
  capabilities?: Record<FieldPath, FieldSupport>;  // facts known only at read time; merged over ProviderCapabilities (ADR-0231)
}

export type FacetTarget =
  | { scope: 'repository'; repository: RepositoryRef; namespace: NamespaceRef }
  | { scope: 'endpoint'; namespace: NamespaceRef };
```

- `apply` MUST be idempotent. It changes only what differs between `desired` and `current`, and yields one `MutationRecord` per provider-side change, which feeds the Mutation ledger (ADP-012). It deletes target-only items only where the Facet is framework-managed per key (branch rules, which step 3a lifts by applying a desired document without them); everywhere else target-only items stay (ADR-0231).
- When `apply` fails after some provider-side changes, the records for those changes still reach the ledger: the driver yields them before rethrowing. A create whose response was lost is read back and recorded when the resource exists (ADR-0222, ADR-0231).
- A driver without `apply` makes the Facet read-only for that Provider (`write: false`).
- Drivers MUST NOT throw on unknown provider fields. They ignore them and report a warning if the field is semantically relevant (ADP-013).

### Capabilities (ADP-014)

```ts
export interface ProviderCapabilities {
  facets: Partial<Record<FacetKey, {
    read: boolean;
    write: boolean;
    fields: Record<FieldPath, FieldSupport>;   // what this provider can represent
  }>>;
}
export type FieldSupport =
  | { kind: 'supported' }
  | { kind: 'readOnly' }                     // readable, not writable
  | { kind: 'unreadable' }                   // writable, never readable (secret values)
  | { kind: 'unsupported'; note?: string }
  | { kind: 'constrained'; constraint: string };  // e.g. "max 6 approvals"
```

The `registry` derives the capability matrix (API-020) from these static declarations. An undeclared field is `supported`. Per field: `unsupported` on either side, or a `readOnly` target, gives `unsupported`; an `unreadable` source gives `unreadable`; a `constrained` side gives `lossy`; otherwise `exact`. A cell is its worst field (`exact < translated < lossy < unreadable < unsupported`), and `write` is reported beside fidelity, not folded into it. `translated` is never derived, because `translate` chooses it (ADP-040). The matrix is a static ceiling: every row that [05-facets](05-facets.md) marks lossy for a pair is `constrained` on the target-side field it affects, whether or not the loss depends on the data. Rows decided only at read time stay dynamic, through `FacetRead.capabilities` or `unreadable`. A per-repository analysis overlays read-time capabilities monotonically: it keeps the worse of the static and dynamic entry per path, so a read can add a limit but never lift one (ADR-0260, ADR-0261).

## Facet definition (ADP-030)

```ts
export interface FacetDefinition<T> {
  key: FacetKey;                       // kebab-case, globally unique
  scope: 'repository' | 'endpoint';
  schemaVersion: number;
  schema: z.ZodType<T>;                // re-exported from @git-migrator/canonical
  compareMode: 'full' | 'none';        // 'none' = writes no ParityResult (LIF-060)
  collections: CollectionKeySpec[];    // arrays and their natural keys (ADP-021)
  dependsOn: FacetKey[];               // apply ordering and readiness dependencies
  inScope: boolean;                    // false = detect-only (warnings only)
  normalize(data: T): T;               // sort collections, canonical casing, defaults
  translate(source: T, ctx: TranslateContext): TranslationResult<T>;
  compare(source: T, target: T, ctx: CompareContext): FieldDiff[];
  findingCodes: Record<string, { kind: 'blocker' | 'pre' | 'post' | 'warning';
    completion?: 'manual' | 'accept' | 'resolution' | 'parity' }>;   // LIF-006; every code has guidance
  policyKeys: PolicyKey[];             // lossy decisions this facet can make
  isTaskSatisfied?(task: { code: string; params: unknown }, target: T, parity: FieldDiff[]): boolean;
}

export type PolicyKey = string;        // "<facet>.<name>", distinct from finding codes
export interface FieldDiff { path: FieldPath; desired: unknown; actual: unknown }
export interface FacetCapability { read: boolean; write: boolean; fields: Record<FieldPath, FieldSupport> }

export interface TranslateContext {
  sourceCaps: FacetCapability; targetCaps: FacetCapability;
  identities: IdentityResolver;        // source principal -> target principal | excluded | unmapped
  groups: GroupResolver;
  policies: RoutePolicies;
  route: RouteRuntime;
  deps: Partial<Record<FacetKey, { source: unknown; desired: unknown }>>;   // results for every facet in dependsOn, already translated
  routeIndex: RouteIndex;              // read-only cross-repository facts, e.g. deploy-key usage counts (FAC-DKY-003)
}

export interface TranslationResult<T> {
  desired: T;                          // target canonical document
  decisions: FieldDecision[];          // one per non-exact field
  blockers: Finding[];
  preTasks: Finding[];
  postTasks: Finding[];
  warnings: Finding[];
}

export interface FieldDecision { path: FieldPath; fidelity: Fidelity; policyKey?: PolicyKey; accepted: 'policy' | 'migration' | false; note?: string }
export interface Finding { code: string; paths: FieldPath[]; params: Record<string, unknown>; verifiable?: boolean }
export type Fidelity = 'exact' | 'translated' | 'lossy' | 'unsupported' | 'unreadable';
```

- **ADP-031** `translate` and `compare` are pure and synchronous. They run in `core`/`facets` with no I/O, so they are exhaustively unit-tested.
- **ADP-032** Pair overrides: the `registry` MAY register `{ source, target, facet, translate }`, which replaces the default `translate` for that pair. v1 uses overrides only where the spec says so in [05-facets](05-facets.md).

## Fidelity semantics (ADP-040)

| Fidelity | Meaning | Effect |
|---|---|---|
| `exact` | Copied unchanged | none |
| `translated` | Lossless semantic mapping | none |
| `lossy` | An approximation is applied | `pre` task `<facet>.accept-lossy`, unless a Route Policy accepts it. Acceptance creates an Expected Difference (`lossy_accepted`). |
| `unsupported` | The target cannot represent it | A finding defined by the Facet: usually a `post` task with guidance, sometimes a `pre` task or blocker. |
| `unreadable` | The source value cannot be read | A `post` task to supply the value. Parity compares presence or name only. |

## Field paths (ADP-020)

Field paths are JSON-Pointer-like, with keyed collection segments so they stay stable when arrays reorder:

```
/description
/rules[pattern=main]/blockForcePush
/grants[principal=group:developers]/role
/refs[name=refs/heads/main]/target
```

Expected Difference patterns may use:

- `*` as an entire key value or as a trailing glob inside one (`/rules[pattern=*]/enforcement`, `/refs[name=refs/heads/git-migrator/*]`);
- `**` as the final segment for any depth (`/hooks[url=*]/**`).

A pattern matches a diff when the diff's path equals the pattern, or lies beneath it.

Arrays of `PrincipalRef` are keyed collections with key `principal`, rendered as `kind:id` (`/rules[pattern=main]/restrictPushes[principal=identity:42]`).

**ADP-021** Every array in a canonical schema MUST be either a keyed collection (declared in `collections` with its key field) or a set of primitives, compared as a sorted set. `normalize` sorts collections by key.

## Errors (ADP-050)

```ts
export class AdapterError extends Error {
  code: 'rate_limited' | 'not_found' | 'forbidden' | 'unauthorized' | 'conflict'
      | 'invalid' | 'unsupported' | 'transient' | 'blocked_by_provider';
  retryable: boolean;
  retryAfterMs?: number;
  provider: string;
  request?: { method: string; url: string; status?: number };   // no secrets
}
```

## Provider HTTP client (ADP-060)

`adapter-sdk` provides `ProviderHttpClient`, which every adapter MUST use:

- **Quota.** It acquires quota before each request attempt, including retries and redirects (JOB-040), selecting a bucket from a per-adapter route → bucket classifier. Credentials are obtained before quota is acquired, so a failing credential step spends no quota. Provider rate-limit headers are interpreted by the adapter through a neutral hook; the client passes the grant's database stamp as `observedSince` (JOB-045, ADR-0190).
- **Retries.** Exponential backoff with full jitter (base 1 s, cap 60 s, 5 attempts) for `transient` errors (network, 5xx, 408). `rate_limited` errors (429 and secondary limits) are *not* retried in-process. The job is re-scheduled for when quota frees (JOB-044).
- **Pagination.** Helpers for both link-based and cursor-based pagination.
- **Raw capture.** It records `RawResponse` rows with authorization headers and query secrets stripped (ADP-061). Stripping also covers sensitive body, form and header fields (the whole value of a key whose name contains a sensitive word), declared credential values in raw, URL-encoded and base64 forms, and generic token shapes; adapters add provider-specific token shapes, which must be linear. Response bodies are size-capped while streaming.
- **Confinement.** Requests and redirects stay under the configured base origin and path, and URLs carrying userinfo are refused, so credentials cannot leave the Endpoint. In tests only loopback and explicitly allowed hosts are reachable (TST-006).
- **Telemetry.** It emits OpenTelemetry spans and the metrics `gm_provider_requests_total{provider,endpoint,bucket,status}` and `gm_provider_request_duration_seconds`.

## Git access (ADP-070)

```ts
export interface GitAccess {
  remoteUrl(repo: RepositoryRef): string;          // https URL without credentials
  credential(repo: RepositoryRef): Promise<{ username: string; password: string; expiresAt?: Date }>;
}
```

The `git` package injects credentials through `GIT_ASKPASS` pointing to a script that reads them from a per-process file in scratch with mode `0600`. Credentials MUST NOT appear in argv, in remote URLs written to `.git/config`, or in logs (ADP-071). The script answers only a prompt that names the origin of the URL the command was started for. Credentials containing line breaks, or too short for the log scrubbers to remove, are refused. The `git` package pins the LFS endpoint of every LFS command to the remote's own `/info/lfs`, so a `.lfsconfig` in a repository cannot redirect transfers, and it refuses an LFS push that would leave objects missing (ADR-0240).
