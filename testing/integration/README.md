# @git-migrator/integration

Integration-tier tests (TST-001). `pnpm test:integration` runs every file here in the Vitest `integration` project against Postgres and the provider fakes (ADR-0475). The files other than `phase1.test.ts` also run in `pnpm test`, because the coverage thresholds of `jobs` and the adapters are measured from them.

## Phase-1 scenario (TST-020, T-075)

`src/phase1.test.ts` is the canonical end-to-end test, steps 1 to 8 in order, one `it` per step. It does not call processors directly: it starts the real composition roots over a throw-away database and the fixture world's fakes. `runMigrate` and `runSeed` prepare the database, `buildApiRuntime` is the web process's API (Better Auth with test sign-in, job producer), and `startWorker` is the worker with every queue handler. The test signs in as `operator@test.local` and drives the API (`/inventory/refresh`, the Model API list, `/migrations/{id}/analyze`, `/migrations/{id}/runs`, `/dashboard`), then asserts directly against the fake GitHub and the fake Bitbucket. It checks the readiness of every fixture repository, then migrates `plat/auto-ok`. The other scenarios of TST-020 are in the coverage table below.

## Additional scenarios (TST-020, T-096)

TST-020 lists the scenarios the integration tier MUST cover besides the Phase-1 flow. Each of their tests carries `[TST-020]` in its title. `src/phase1-additional.test.ts` holds the scenarios no other suite covered. It runs the whole system through `src/stack.ts` (the composition roots of `phase1.test.ts`: real API, real worker, BullMQ-on-Postgres, the fakes) and, like `phase1.test.ts`, only in `pnpm test:integration` (`INTEGRATION_ONLY` in `tools/test-globs.ts`). The other suites drive the executor or the job runners directly and also run in `pnpm test`.

| Scenario of the list | File | Test |
|---|---|---|
| every fixture repository's expected readiness | `src/analysis.test.ts`, `src/phase1.test.ts` | `[LIF-020] every fixture repository gets the readiness and findings of the T-043 table`; step 3 |
| run-anyway on `data/unmapped-user` | `src/migrate.test.ts` | `[LIF-043] run_anyway applies a repository that needs attention, and its pre task stays open` |
| secrets post-task completion leading to verified | `src/phase1-additional.test.ts` | `[LIF-061] secrets post-task completion leading to verified` |
| the blob blocker | `src/migrate.test.ts` | `[FAC-GIT-004] ops/big-blob is blocked at git.prepare, with no write to the target` |
| batched push | `src/migrate.test.ts` | `[LIF-044] ops/large-history is pushed in several batches under the target push limit` |
| drift detection after mutating fake GitHub, and resync | `src/drift-rollback.test.ts` | `[LIF-065] a change made on the target by hand drifts the Migration ...`; `[LIF-065] revoking the acceptance drifts the Migration again, and resync rewrites the target ...` |
| rollback of a created target | `src/drift-rollback.test.ts` | `[LIF-077] is refused while the source is read-only: undo_source_read_only first, then the typed confirmation, then the repository is deleted` |
| rollback of an adopted target | `src/drift-rollback.test.ts` | `[LIF-077] leaves the repository and its git refs, and reverts the writes of the framework newest first` |
| undo source read-only | `src/source-read-only.test.ts` | `[LIF-070] deletes the restriction, restores the description and marks the Mutations undone; the flag is cleared` |
| invitation batch with a deselection, plus parity | `src/phase1-additional.test.ts`, `src/invitations.test.ts` | `[AUTH-060] invitation batch with a deselection, plus parity` (API, worker and a verify Run); `[AUTH-060] deselecting needs a reason and masks the person in parity`; `[AUTH-060] sends only the approved, non-deselected entries` |
| the endpoint migration creating teams | `src/endpoint-migration.test.ts` | `[LIF-080] creates the missing team, confirms its Group Mapping and clears access-control.team-missing` |
| the quota ledger throttling with the fake's 429 | `src/phase1-additional.test.ts` | `[JOB-044] the quota ledger throttles with the fake's 429` |
| SSE events emitted for a Run | `src/phase1-additional.test.ts` | `[JOB-060] SSE events emitted for a Run` |

The mapped suites for drift, rollback, undo source read-only and the batched push and blob blocker drive the executor and job runners directly, not the HTTP API; the new scenarios go through the API.

Waiting is condition-based, never a fixed sleep. A wait for idle queues counts a delayed job that has already failed once (`attemptsMade > 0`) as work, because it is a retry in its backoff (`busy()` in `src/stack.ts` and `phase1.test.ts`). The quota scenario sets the fake's `forced` secondary limit (one 429 with `Retry-After`) and checks that the fake saw no further request until the ledger's `blockedUntil`.

## Adapter contract suite (TST-015)

`src/adapter-contract/` holds the contract suite. `contract.ts` is provider-neutral: it takes an `AdapterContract` (a connection factory, the capability matrix and scenarios). `github.contract.test.ts` and `bitbucket-cloud.contract.test.ts` bind it to the fakes in `testing/provider-fakes` (TST-006).

- Writable Facets (driver has `apply`): read, apply, read returns the desired document; a second apply yields zero records.
- Read-only Facets (`write: false`, all of Bitbucket Cloud): the read is valid per the Facet schema and stable across two reads.
- Equality is strict. The only differences allowed are the declared normalisations in ADR-0250.

To add an adapter: write a connection factory and one scenario per readable Facet; the suite fails if a readable Facet has none.

## Inventory (T-060)

`src/inventory.test.ts` runs the inventory processor against the TST-012 fixture world with a throw-away Postgres database.

## Parity (T-072)

`src/parity.test.ts` migrates `plat/auto-ok` by hand with the real adapters and the git package (create the repository, mirror, LFS and refs, then each writable Facet's `apply`) and runs the Parity Check against it: every Facet `equal`, the Migration `verified`, a missing LFS object and a missing branch as differences, post-cutover containment, and the Route's `framework_mutation` record hiding a framework branch. The fake GitHub's compare API reads its own in-memory store, not the git server, so containment through the compare API is covered by the unit tests in `packages/jobs/src/parity`.

Declared internal dependencies (ARC-012, checked by `pnpm lint`): adapters, `adapter-sdk`, `canonical`, `config`, `core`, `db`, `facets`, `fixtures`, `git`, `guidance`, `jobs`, `observability`, `provider-fakes`, `quota` and `registry`.
