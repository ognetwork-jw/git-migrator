# 03 — Domain Model

## Storage strategy (DOM-001)

The data splits into two shapes:

- **Relational tables** hold everything that is queried, filtered, joined, constrained or changed by state transitions. That covers Repositories, Migrations, status, readiness, tasks, mappings, runs, mutations, Expected Differences and audit.
- **Typed JSON** holds Facet Snapshot payloads and per-Facet translation output. These are ZenStack v3 `type` declarations stored as `Json` columns (`jsonb`) and validated by the Facet's Zod schema on write and on read.

The reasons for putting Facet payloads in typed JSON rather than in per-Facet tables:

1. Facets are pluggable (ADP-030). Per-Facet tables would require core schema migrations for every new Facet or schema revision.
2. Parity, translation and diff operate on whole canonical documents. A document column round-trips exactly, with a stable content hash.
3. Snapshots are immutable and versioned (`schemaVersion`), so relational normalization buys no integrity.

Any Facet value needed for filtering or sorting MUST be **promoted** to a real column on `Repository`, `Migration` or `Analysis` at write time (DOM-002). Examples are size, open Change Request count, whether pipelines exist, and blocker codes. Raw provider responses are inherently unstructured, so they stay in `jsonb` (DATA-020).

## Conventions (DOM-003)

- IDs are UUIDv7 (`@default(uuid(7))`). If the pinned ZenStack version lacks `uuid(7)`, generate in application code; T-001 verifies (ADR-0002).
- Tables use snake_case via `@@map`, fields via `@map`.
- Every model has `createdAt` and `updatedAt`, omitted from the listing below for brevity, except the append-only `QuotaEvent`, `RunLog` and `AuditEvent`, which have only their own timestamps.
- All app models are `@@schema('app')`. Better Auth tables live in schema `auth` and are **not** modeled in ZModel. `Actor.authUserId` is a plain unique string referencing `auth.user.id`, with no FK across schemas, so each schema owns its migrations (ADR-0008).
- Enums are ZModel enums.

## Model (normative field list)

Field types are ZModel. `?` means optional. Access policies are summarized in [08-identity-and-auth](08-identity-and-auth.md#authorization).

```zmodel
enum ActorKind { human service }
enum Role { viewer operator admin }

model Actor {
  id           String    @id @default(uuid(7))
  kind         ActorKind
  displayName  String
  email        String?
  role         Role
  disabled     Boolean   @default(false)
  authUserId   String?   @unique          // auth.user.id for human actors
  lastSeenAt   DateTime?
  apiKeys      ApiKey[]
}

model ApiKey {                              // service actors only (AUTH-040)
  id         String    @id @default(uuid(7))
  actorId    String
  name       String
  prefix     String    @unique              // first 8 chars after "gm_", shown in UI
  hash       String                         // sha256(full key), hex
  expiresAt  DateTime?
  lastUsedAt DateTime?
  revokedAt  DateTime?
}

enum EndpointStatus { active retired }

model Endpoint {                            // upserted from config at startup (ARC-030)
  id           String @id                   // config slug, e.g. "bitbucket-main"
  providerType String                       // adapter type, e.g. "bitbucket-cloud"
  displayName  String
  baseUrl      String
  status       EndpointStatus
  configHash   String
}

model Route {                               // upserted from config at startup
  id                String @id              // config slug
  sourceEndpointId  String
  targetEndpointId  String
  targetNamespaceId String?                 // resolved after first target inventory
  targetNamespacePath String                // from config, e.g. "acme-org"
  policies          Json                    // RoutePolicies type (LIF-011)
  defaults          Json                    // route defaults (DEP-040)
  configHash        String                  // change marks analyses stale (LIF-021)
  sourcePostAction  String                  // "read-only" | "none" (LIF-070)
}

model Namespace {
  id          String  @id @default(uuid(7))
  endpointId  String
  providerId  String                        // provider-stable id
  parentId    String?
  kind        String                        // adapter-defined label, display only
  slug        String
  key         String?                       // e.g. Bitbucket project key
  name        String
  @@unique([endpointId, providerId])
}

enum SourcePresence { present missing }
enum SizeClass { standard large }

model Repository {
  id              String  @id @default(uuid(7))
  endpointId      String
  namespaceId     String
  providerId      String                    // Bitbucket repo UUID / GitHub node_id
  slug            String
  name            String
  fullPath        String                    // display path, e.g. "ws/PROJ/repo"
  isPrivate       Boolean
  sizeBytes       BigInt?
  sizeClass       SizeClass @default(standard)
  presence        SourcePresence @default(present)
  defaultBranch   String?
  lfsBytes        BigInt?                   // last known, from runs
  providerUpdatedAt DateTime?               // provider's last-updated timestamp
  lastInventoriedAt DateTime
  @@unique([endpointId, providerId])
}

enum MigrationScope { repository endpoint }
enum MigrationStatus {
  discovered analyzed running migrated failed partial
  verified manually_completed drifted rolled_back source_missing
}
enum Readiness { ready needs_attention blocked }

model Migration {
  id                  String @id @default(uuid(7))
  scope               MigrationScope
  routeId             String
  sourceRepositoryId  String?             // null for endpoint scope
  targetRepositoryId  String?             // set once target exists / adopted
  plannedTargetName   String?
  status              MigrationStatus @default(discovered)
  statusBeforeRun     MigrationStatus?    // LIF-002 saved statuses
  statusBeforeDrift   MigrationStatus?
  statusBeforeManual  MigrationStatus?
  statusBeforeMissing MigrationStatus?
  runBlockers         Json @default("[]") // LIF-049: [{code, params, at}]
  readiness           Readiness?
  readinessCounts     Json?               // {blockers, preTasks, postTasks, warnings}
  blockerCodes        String[]            // promoted for filtering
  latestAnalysisId    String?
  analysisStaleAt     DateTime?
  targetCreatedByFramework Boolean @default(false)
  sourceReadOnlyApplied    Boolean @default(false)
  waveId              String?
  verifiedAt          DateTime?
  manualCompletion    Json?               // {actorId, reason, at}
  lastParityAt        DateTime?
  lastDriftCheckAt    DateTime?
  @@unique([routeId, sourceRepositoryId])
  // plus one endpoint-scope row per route (partial unique index, DATA-011)
}

model FacetSnapshot {
  id            String @id @default(uuid(7))
  side          String                     // "source" | "target" (which endpoint was read)
  endpointId    String
  repositoryId  String?                    // null for endpoint-level facets
  facetKey      String
  schemaVersion Int
  data          Json                       // canonical, validated by facet schema
  unreadable    String[]                   // field paths that could not be read
  hash          String                     // sha256 of canonical JSON (RFC 8785 JCS)
  fetchedAt     DateTime
  rawResponseIds String[]
}

model RawResponse {                          // pruned after 30 days (DATA-020)
  id         String @id @default(uuid(7))
  endpointId String
  method     String
  url        String                          // credentials and query secrets stripped
  status     Int
  body       Json?
  fetchedAt  DateTime
}

model Analysis {
  id              String @id @default(uuid(7))
  migrationId     String
  sourceSnapshotIds String[]
  targetSnapshotIds String[]
  readiness       Readiness
  translation     Json                       // per facet: desired target canonical + field fidelity
  createdAt       DateTime @default(now())
  items           PlanItem[]
}

enum PlanItemKind { step blocker pre_task post_task warning }

model PlanItem {
  id          String @id @default(uuid(7))
  analysisId  String
  facetKey    String
  kind        PlanItemKind
  code        String                         // e.g. "branch-rules.lossy-merge-check"
  fidelity    String?
  fieldPaths  String[]
  params      Json                           // rendered into guidance
  order       Int
}

enum RunKind { migrate run_anyway resync verify rollback source_read_only undo_source_read_only }
enum RunStatus { queued running succeeded partial failed cancelled }

model Run {
  id          String @id @default(uuid(7))
  migrationId String
  analysisId  String?
  kind        RunKind
  status      RunStatus @default(queued)
  triggeredById String                       // Actor
  options     Json                           // e.g. {adoptNonEmpty, confirmToken}
  startedAt   DateTime?
  finishedAt  DateTime?
  leaseOwner  String?                        // LIF-046
  leaseExpiresAt DateTime?
  reaperResumes Int @default(0)
  hasMutations Boolean @default(false)
  error       Json?
  steps       RunStep[]
}

enum StepStatus { pending running succeeded failed skipped }

model RunStep {
  id          String @id @default(uuid(7))
  runId       String
  stepKey     String                         // e.g. "git.push-refs", "facet.webhooks.apply"
  facetKey    String?
  order       Int
  status      StepStatus @default(pending)
  attempts    Int @default(0)
  startedAt   DateTime?
  finishedAt  DateTime?
  error       Json?                          // AdapterError serialized
}

model RunLog {
  id      String   @id @default(uuid(7))
  runId   String
  stepId  String?
  ts      DateTime
  level   String
  message String
  data    Json?
}

model Mutation {                              // ledger of framework changes (LIF-045)
  id          String @id @default(uuid(7))
  migrationId String
  runId       String
  side        String                          // "source" | "target"
  facetKey    String
  resourceRef Json                            // adapter-defined pointer, enough to undo
  paths       String[]                        // canonical field paths touched (LIF-045)
  action      String                          // create | update | delete
  before      Json?
  after       Json?
  undoneAt    DateTime?
}

enum TaskStatus { open done dismissed }

model ManualTask {
  id          String @id @default(uuid(7))
  migrationId String
  facetKey    String
  code        String
  phase       String                          // "pre" | "post"
  origin      String                          // "analysis" | "run" (LIF-049)
  params      Json
  verifiable  Boolean                         // parity can auto-complete it
  status      TaskStatus @default(open)
  completedById String?
  completedAt DateTime?
  note        String?
  sourcePlanItemId String?
  paramsHash  String                         // sha256(JCS(params))
  @@unique([migrationId, code, facetKey, paramsHash])  // paramsHash: sha256 of params
}

enum ExpectedDifferenceReason {
  framework_mutation overlay lossy_accepted identity_excluded manual_accepted unreadable_defaulted
}

model ExpectedDifference {
  id          String @id @default(uuid(7))
  routeId     String
  migrationId String?                         // null = applies to every migration on the route
  facetKey    String
  path        String                          // field path pattern over desired-vs-target diffs (ADP-020, LIF-063)
  reason      ExpectedDifferenceReason
  note        String?
  createdById String?                         // null when created by the system
  createdAt   DateTime @default(now())
  revokedAt   DateTime?
}

model ParityResult {
  id          String @id @default(uuid(7))
  migrationId String
  facetKey    String
  status      String                          // equal | different | unverifiable
  diffs       Json                            // [{path, source, target}], after exclusions
  excluded    Json                            // [{path, expectedDifferenceId}]
  checkedAt   DateTime
}

model Identity {
  id          String @id @default(uuid(7))
  endpointId  String
  providerId  String                          // Bitbucket account_id / GitHub user id
  login       String?                         // Bitbucket nickname / GitHub login
  displayName String?
  email       String?
  emailSource String?                         // "atlassian-admin" | "provider-public" | "csv"
  kind        String                          // user | bot
  isMember    Boolean                         // member of the endpoint's root namespace
  @@unique([endpointId, providerId])
}

model Group {
  id         String @id @default(uuid(7))
  endpointId String
  providerId String                           // Bitbucket group slug / GitHub team id
  slug       String
  name       String
  memberIds  String[]                         // Identity ids
  @@unique([endpointId, providerId])
}

enum MappingStatus { suggested confirmed excluded pending_invite unmapped }

model IdentityMapping {
  id               String @id @default(uuid(7))
  routeId          String
  sourceIdentityId String
  targetIdentityId String?
  status           MappingStatus
  method           String?                    // email | login | name | csv | manual | invite
  confidence       Float?
  decidedById      String?
  decidedAt        DateTime?
  @@unique([routeId, sourceIdentityId])
}

model GroupMapping {
  id             String @id @default(uuid(7))
  routeId        String
  sourceGroupId  String
  targetGroupId  String?
  plannedSlug    String
  status         MappingStatus
  @@unique([routeId, sourceGroupId])
}

enum InvitationBatchStatus { draft approved sending sent partial }
enum InvitationStatus { selected deselected sent accepted failed expired }

model InvitationBatch {
  id            String @id @default(uuid(7))
  routeId       String
  status        InvitationBatchStatus @default(draft)
  seatPreview   Json                         // {seatsTotal?, seatsFilled?, toInvite}
  createdById   String
  approvedById  String?
  approvedAt    DateTime?
  items         Invitation[]
}

model Invitation {
  id               String @id @default(uuid(7))
  batchId          String
  sourceIdentityId String
  email            String
  teamSlugs        String[]
  status           InvitationStatus @default(selected)
  providerInvitationId String?
  error            String?
}

model Wave {
  id         String @id @default(uuid(7))
  name       String @unique
  targetDate DateTime?
  description String?
}

model NamingRule {                            // LIF-030
  id        String @id @default(uuid(7))
  routeId   String
  scope     String                            // namespace | repository (the route default lives in config only)
  scopeRef  String                            // Namespace.id or Repository.id
  pipeline  Json                              // NamingPipeline type
  override  String?                           // literal target name (repository scope)
  @@unique([routeId, scope, scopeRef])
}

model WebhookAllowlistEntry {
  id      String @id @default(uuid(7))
  routeId String
  pattern String                              // URL glob, see FAC-WEB-002
  note    String?
}

model Overlay {
  id       String @id @default(uuid(7))
  routeId  String
  facetKey String
  data     Json                               // partial canonical document for the facet
  enabled  Boolean @default(true)
}

model AuditEvent {
  id        String @id @default(uuid(7))
  actorId   String?                            // null = system
  action    String                             // e.g. "migration.mark_complete"
  subjectType String
  subjectId String
  data      Json?
  at        DateTime @default(now())
}

model QuotaEvent {                             // sliding-window ledger (JOB-041)
  id        BigInt @id @default(autoincrement())
  bucketKey String
  pool      String                             // background | interactive
  at        DateTime
  @@index([bucketKey, at])
}

model QuotaLease {                             // cross-pod concurrency caps (JOB-045)
  id        BigInt @id @default(autoincrement())
  bucketKey String
  holder    String
  expiresAt DateTime
  @@index([bucketKey, expiresAt])
}

model QuotaState {
  bucketKey     String @id
  limitPerWindow Int
  windowSeconds Int
  remaining     Int?                           // only when the provider reports it
  resetAt       DateTime?
  blockedUntil  DateTime?                      // set on 429 / secondary limits
}
```

Relations (FKs) are implied by `…Id` fields and MUST be declared with ZenStack `@relation`. Deletion is restricted by default. Cascades are allowed only Run → RunStep/RunLog and Analysis → PlanItem. `Migration.latestAnalysisId` and `ManualTask.sourcePlanItemId` use `onDelete: SetNull`, so retention (DATA-020) can prune them (DOM-004).

**DOM-005 Default-deny writes.** Every model denies create, update and delete through the policy-enforcing (RPC) client by default. Only the RPC writes allow-listed in API-012 are permitted. Every other write happens in server code through the privileged client, behind a custom endpoint or job that enforces the domain rules and writes audit.

## Invariants

- **DOM-010** At most one Run per Migration is `queued` or `running`. This is enforced by a partial unique index on `run(migration_id) WHERE status IN ('queued','running')`.
- **DOM-011** `Migration.readiness`, `status`, `blockerCodes`, `readinessCounts` and lifecycle timestamps are written only by the server's privileged client. ZenStack policies deny client updates to these fields (API-012).
- **DOM-012** Snapshots and Analyses are immutable once written. `Analysis.readiness` is the readiness *at analysis time*. The live value is `Migration.readiness` (LIF-004).
- **DOM-013** Deleting a Wave unsets `waveId` on its Migrations.
- **DOM-014** An endpoint-scope Migration exists for every Route. A repository-scope Migration is created for every source Repository on the Route's source Endpoint during inventory.
