# ADR-0395: ParityResult storage and redaction

- Status: agent-decided
- Date: 2026-10-09
- Task: T-072
- Affects: LIF-060, LIF-063, DATA-020, API-020 (`GET /migrations/{id}/diff`), AUTH-022

## Context

LIF-060 step 5 says "store a ParityResult", the data model gives it `status`, `diffs` (`[{path, source, target}]`, "after exclusions"), `excluded` (`[{path, expectedDifferenceId}]`) and `checkedAt`, and DATA-020 keeps "`ParityResult` (latest per facet)" indefinitely. Not said: whether every check adds a row, what `source` and `target` hold, where the reason of an `unverifiable` status goes, and what may be stored. T-062's diff endpoint reads the newest row per Facet and redacts values by key when it reads them.

## Decision

- **One row per Migration and Facet, updated in place.** (`checkedAt` is the start of the check on the database clock; a row is never replaced by a check that started earlier, ADR-0396.) A check updates the newest row of the Facet (status, diffs, excluded, `checkedAt`) and creates one only when there is none; older duplicates, which an earlier writer might have left, are deleted in the same transaction. This is DATA-020's "latest per facet" taken literally, and it bounds the table: a daily drift check (LIF-065) of 5,000 Migrations with 15 Facets would otherwise add 27 million rows a year that nothing reads. The history of status changes is in the audit trail of Runs and in `Migration.lastParityAt`; no schema change is needed.
- **`diffs[].source` is the desired value** (the translated source with Overlays merged in, LIF-060 step 2), **`diffs[].target` the actual value.** Paths are the canonical field paths of the diff, unchanged, so an "accept" (LIF-065) can turn them into `manual_accepted` Expected Differences. At most `MAX_STORED_DIFFS` (1,000) are kept; the status stays `different` however many there are. `excluded[]` has the same cap; beyond it a last entry `{reason: 'truncated', total}` carries the count.
- **`excluded[]`** is `{path, expectedDifferenceId, reason}` per diff an Expected Difference hid (LIF-063). `reason` is an addition that T-062 ignores.
- **`unverifiable`** stores `diffs: []`, `excluded: []`. The reason (`target-missing`, `read-failed:<code>`, `compare-failed:<code>`, ...) goes to the Run log (`run.log`) and the worker log, never to the row, because it is derived from provider errors.
- **No secret value is stored.** Canonical documents hold no secret values (FAC-SEC-001, FAC-WEB-002 compare by presence or name), and the diff endpoint redacts by key when it reads. The row is permanent, so the writer redacts as well (`parity/redact.ts`, the same rules as `packages/api/src/redact.ts`: a string below a sensitive key, or at a path with a sensitive segment or bracket selector, becomes `[REDACTED]`; webhook URLs reduce to their origin; every other string goes through the log scrubber). The duplication is deliberate: `jobs` may not import `api` (ARC-012), and a later change of the API rules must not change what is already stored. Public keys and similar values that look sensitive by name are redacted at both places, so the UI never shows them either.
- **LFS object ids** (FAC-GIT-005) are listed at the path `/lfs/oids` of `git-refs` (`desired`: the missing ids, at most 100; `actual`: empty). The path is a declared set of the Facet, so it parses as a field path and can be accepted.

## Alternatives

- An append-only history with a retention rule: more rows, more code, and nothing reads the old ones.
- A unique index on `(migration_id, facet_key)` and an upsert: stronger, but the row lock of the Migration already serializes writers, and a migration for a constraint nobody can violate is not worth the merge risk with parallel tasks.
- Redacting only in the API: the database would hold whatever a Facet's `compare` returned.

## Affected requirements

LIF-060, LIF-063, DATA-020, API-020.
