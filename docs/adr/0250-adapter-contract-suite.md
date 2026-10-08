# ADR-0250: Adapter contract suite: shape, placement and normalisations

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-034
- Affects: TST-015, TST-006, ADP-011, ADP-012, ADP-014, FAC-WEB-003, FAC-BRR-002

## Context

TST-015 asks for a contract suite per adapter: read every Facet, apply it, read back the same canonical document, parameterized by a connection factory. It says the suite runs "in the integration tier", but `pnpm test:integration` is a placeholder until T-075. The spec does not say what a read-only adapter (Bitbucket Cloud, every Facet `write: false`) owes, nor which round-trip differences are legitimate.

## Decision

1. **Placement.** The suite lives in `testing/integration/src/adapter-contract/`. The shared checks (`contract.ts`) import no provider code and take an `AdapterContract` (a connection factory, the capability matrix and a list of scenarios). Each adapter has one `*.contract.test.ts` that builds its fake and connection. Files under `testing/*/src/` run in the unit project, so `pnpm test` runs the suite today; T-075 may move the globs to the integration tier without changing the suite.
2. **What is checked.** For each readable Facet: (a) every readable Facet has a scenario and a driver; (b) `write: true` holds exactly when the driver has `apply`; (c) with `apply`: read, apply, read returns the desired document with `toEqual`, and every read is valid per `parseCanonical`; (d) without `apply`: the read is valid and two reads are equal (data and `unreadable`).
3. **Idempotency contract.** Apply the desired document once; apply it again with the read-back as `current`, then with `current = null`: both yield zero records; a final read is unchanged. The first apply must yield at least one record, so a scenario that changes nothing cannot pass.
4. **Bitbucket Cloud.** Every Facet is read-only, so its suite is the read-only contract (c is vacuous) and a test pins that no Facet is writable.
5. **Settling.** A scenario may run a `settle` step between apply and the read-back. Only code-ownership uses it: the Change Request branch is fast-forwarded into the default branch in the fake, because CODEOWNERS counts only once merged (LIF-047). This is not a normalisation; the read-back equals the desired document.
6. **Normalisations.** Equality is never loosened in general. A scenario may carry one `normalisation { adr, reason, expected }`, and the checker rejects any `adr` outside `ADR-0250..0259`. The suite uses exactly these, each shown necessary (removing it fails the test):
   - **N1, webhook with a secret (FAC-WEB-003).** Desired `hasSecret: true, active: false` (FAC-WEB-003 already makes the desired hook inactive). The secret value is unreadable, so only `hasSecret` differs: the read-back is `hasSecret: false`.
   - **N2, refused force-push bypass (ADR-0231 section 4).** Desired `forcePushExempt` with an actor. The provider refuses the list, `apply` retries without it and records `exemptionsDropped: true`, so the read-back has `forcePushExempt: []`. The scenario also asserts the record carries `exemptionsDropped`.
   - **N3, target-only items stay (ADR-0231 section 1).** Outside branch-rules `apply` does not delete target-only items. For each list-valued writable Facet (variables, webhooks, org-webhooks, deploy-keys, environments, teams, org-variables, access-control) a scenario seeds one target-only item through the driver and expects it to stay beside the desired items. Branch-rules has no normalisation for deletion: a target-only rule is deleted and the read-back equals desired.
   - **N4, fields the capability matrix declares unsupported or constrained (ADP-014).** A branch rule desired with `enforcement: advisory`, a non-null `restrictMerges`, a non-empty `deletionExempt` and `minPassingBuilds: 3` reads back as `enforced`, `null`, `[]` and `0`. The lossy outcome is asserted explicitly, field by field.
   - Each adapter declares how many scenarios use each kind (GitHub: N1 1, N2 1, N3 8, N4 1; Bitbucket Cloud: none). Any other use, and any kind outside N1 to N4, fails the suite.
   - Secret values are unreadable (FAC-SEC-001), so secrets Facets are read-only scenarios and nothing is compared to a written value.
7. **Idempotency scenario.** The settled read-back is asserted against the same expected document (normalised or not), and the second apply yields zero records.
8. **MutationRecords (ADP-012).** The first apply of every round-trip and idempotency check is validated: `facetKey` is the Facet under test (or null), `action` is create, update or delete, `paths` is non-empty and well-formed, `resourceRef` is non-empty, no record matches a credential shape or a scenario-declared forbidden substring, no two records are identical, and the union of record paths covers every field that differs between the read before and the expected read-back. A round-trip must yield at least one record unless the scenario declares `noop`.
9. **Read-only reads.** A read-only scenario may assert what the seeded world must show (`checkRead`); the Bitbucket Cloud scenarios assert the seeded items of every Facet.
10. **Known defect, `it.fails`.** The code-ownership driver yields the Change Request writer's records unchanged (`facetKey: change-requests`, empty `paths`), so they fail the record check. The adapter is not changed in T-034: the scenario carries `knownDefect` and runs under `it.fails`, so fixing the driver turns it red until the marker is removed.

## Alternatives

- Importing each adapter's `harness.test.ts`: forbidden by ARC-012 (test files of one package are not importable from another) and would couple the suite to adapter internals. The small connection factories are duplicated instead.
- Loosening equality (ignoring `active`, `hasSecret`, ordering): rejected, it would hide real regressions.
- Waiting for T-075 to place the suite in a separate integration project: rejected, the suite needs no Postgres and should run in `pnpm test` now.
