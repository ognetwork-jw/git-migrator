# @git-migrator/integration

Integration-tier tests (TST-001). `pnpm test:integration` runs every file here in the Vitest `integration` project against Postgres and the provider fakes (ADR-0475). The files other than `phase1.test.ts` also run in `pnpm test`, because the coverage thresholds of `jobs` and the adapters are measured from them.

## Phase-1 scenario (TST-020, T-075)

`src/phase1.test.ts` is the canonical end-to-end test, steps 1 to 8 in order, one `it` per step. It does not call processors directly: it starts the real composition roots over a throw-away database and the fixture world's fakes. `runMigrate` and `runSeed` prepare the database, `buildApiRuntime` is the web process's API (Better Auth with test sign-in, job producer), and `startWorker` is the worker with every queue handler. The test signs in as `operator@test.local` and drives the API (`/inventory/refresh`, the Model API list, `/migrations/{id}/analyze`, `/migrations/{id}/runs`, `/dashboard`), then asserts directly against the fake GitHub and the fake Bitbucket. It checks the readiness of every fixture repository, then migrates `plat/auto-ok`. Other scenarios of TST-020 live in the suites below.

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
