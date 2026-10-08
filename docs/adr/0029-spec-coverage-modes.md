# ADR-0029: spec:coverage runs report-only until the end of the project

- Status: accepted (spec updated)
- Date: 2026-10-08

## Context

TST-002 says `pnpm spec:coverage` "fails only for IDs in a `must-test.txt` allowlist", which T-001 initializes with every LIF, FAC, JOB-04x and AUTH-0xx ID. Nothing is implemented when T-001 merges, so a failing mode would turn CI red for every task until the late tasks. T-097 expects "no must-test gaps".

## Decision

- `pnpm spec:coverage` is **report-only by default**: it prints the uncovered IDs (must-test ones marked `*`) and exits 0.
- `--strict` (or `SPEC_COVERAGE_STRICT=1`) exits 1 when any ID in `must-test.txt` has no referencing test, or when `must-test.txt` is stale or incomplete relative to `docs/spec`. Other IDs never fail. It fails closed: exit 2 when `must-test.txt` is missing or empty or `docs/spec` is missing. A bare `--root` exits 2 in every mode.
- CI (T-003) runs the default mode. T-097 (final review) and any task that finishes a requirement family may run `pnpm spec:coverage -- --strict`; T-097 switches CI to strict.
- `node tools/spec-coverage.ts --generate` (`pnpm spec:must-test`) regenerates `must-test.txt` from `docs/spec`. IDs are the literal tokens in `docs/spec/*.md` excluding `15-work-breakdown.md` (which only references IDs and ranges). A test warns when the committed file drifts from the spec.
- An ID is **referenced** only when it appears in the title of a running `it`/`test` call, or of a `describe` that contains at least one running test (`.each(table)('…')`, ``.each`table`('…')`` and names assigned from `test.extend(…)`/`it.extend(…)`, also chained, and aliases from `import { test as t }`, are supported; Playwright's `test.describe` is a group). Files are parsed with `oxc-parser`; a file with a syntax error contributes nothing. Limits: a test name imported from another file that was itself created with `.extend` (for example a shared `test` fixture module under another name) is not recognised, and titles built by concatenation or variables are not read, in a file that the test globs in `tools/test-globs.ts` would run (the same globs `vitest.config.ts` uses, plus the integration and Playwright locations). Comments, other strings, `.skip`, `.todo`, `.fixme`, `.skipIf`/`.runIf`/`.fails` (and anything nested inside such a call), `__fixtures__` directories, files outside those globs and build output directly inside a package (`dist`, `coverage`, `.next`, `.turbo`) do not count. A `src/coverage/` source directory does. Tasks that add a test tier add its globs to `tools/test-globs.ts`.

## Alternatives

- A baseline file of currently failing IDs that may only shrink: more machinery, and the orchestrator would have to maintain it.
- Strict by default with the allowlist emptied initially: contradicts the requirement that `must-test.txt` starts with every ID.

## Affected requirements

TST-002.
