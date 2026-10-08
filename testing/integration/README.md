# @git-migrator/integration

Integration-tier tests. Files under `src/` run in the unit project today; T-075 adds the Postgres-backed tier.

## Adapter contract suite (TST-015)

`src/adapter-contract/` holds the contract suite. `contract.ts` is provider-neutral: it takes an `AdapterContract` (a connection factory, the capability matrix and scenarios). `github.contract.test.ts` and `bitbucket-cloud.contract.test.ts` bind it to the fakes in `testing/provider-fakes` (TST-006).

- Writable Facets (driver has `apply`): read, apply, read returns the desired document; a second apply yields zero records.
- Read-only Facets (`write: false`, all of Bitbucket Cloud): the read is valid per the Facet schema and stable across two reads.
- Equality is strict. The only differences allowed are the declared normalisations in ADR-0250.

To add an adapter: write a connection factory and one scenario per readable Facet; the suite fails if a readable Facet has none.

## Inventory (T-060)

`src/inventory.test.ts` runs the inventory processor against the TST-012 fixture world with a throw-away Postgres database.

Declared internal dependencies (ARC-012, checked by `pnpm lint`): adapters, `adapter-sdk`, `canonical`, `config`, `core`, `db`, `facets`, `fixtures`, `guidance`, `jobs`, `observability`, `provider-fakes`, `quota` and `registry`.
