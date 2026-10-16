# ADR-0507: Load-tolerant wall-clock budgets and timeouts in tests

- Status: agent-decided
- Date: 2026-10-16

## Context

Several tests assert a wall-clock budget (a redaction scan of 1 MB within 1000 ms, an adversarial pipelines file within 4 s, a 1 MB scrub within 100 ms) or rely on Vitest's default 5 s test timeout and Testing Library's default 1 s wait. They pass on an idle machine and fail when the whole suite runs in parallel, when two reviewers run suites on one machine, or in devenv CI (docs/followups.md). TST-005 makes `pnpm test` a gate, so a load-only failure blocks merges. The spec says nothing about timing in tests.

The integration files also run in the unit project (ADR-0475), where the integration project's 120 s and 180 s timeouts do not apply.

## Decision

1. **One factor.** `GM_TEST_TIME_FACTOR` (a number of at least 1, default 1; anything else fails the run, `tools/test-timing.ts`) multiplies the default test and hook timeouts of both Vitest projects, and `vitest.config.ts` provides it to tests as `inject('timeFactor')` (typed in `tools/vitest-context.d.ts`). Every wall-clock budget a test asserts is written as `budget(ms)`, a local helper that multiplies by the factor. The factor never tightens a budget. A slow or shared machine sets, for example, `GM_TEST_TIME_FACTOR=3`; turbo passes it through without changing cache keys.
2. **Re-measure before failing.** A timed synchronous operation is measured again, three runs at most, when the first run is over budget, and the best time is judged (`within(ms, run)`). A genuinely slow (super-linear) implementation fails every run; one preemption does not fail the test. A pass costs one run.
3. **Ratios where the claim is linearity.** Where a test claims linear time and its budget flaked under load, it also times an input a quarter of the size and asserts the growth ratio stays below 10 (linear is about 4, quadratic about 16); both measurements see the same load. adapter-sdk's 1 MB scrub (ADP-061) keeps an absolute ceiling of 500 ms, as its follow-up suggested (it was 100 ms); the pipelines pattern-scale test (FAC-PIP-002) keeps its 4 s.
4. **Explicit timeouts for slow tests.** Tests that spawn processes, scan the repository, loop over many megabyte inputs or run the adapter contract suite get explicit, generous timeouts instead of the 5 s default; the integration files also run in the unit project (ADR-0475), where the integration project's timeouts do not apply. jsdom component tests in `apps/web` get a 30 s test timeout and a 10 s Testing Library wait from `src/test-render.tsx`, which every component test imports, both scaled by the factor; the per-file copies of those settings are gone.
5. **Remove load where it is waste.** The GitHub contract suite generates one App key pair per file instead of one RSA key per connection.

## Alternatives

- Raise every budget: hides real slowdowns on idle machines and still fails on a busy enough one.
- Retry failed tests (`retry: 2`): hides genuine flakiness and regressions in every test, not only timing.
- Calibrate against a reference workload measured in the same run: more moving parts, and the reference itself is noisy under load.

## Affected requirements

TST-001, TST-005, DEP-050, ADP-061, FAC-PIP-002 (test timing only; no behaviour changes).
