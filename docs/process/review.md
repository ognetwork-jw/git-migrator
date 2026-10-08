# Review Rubric

Reviewers return a list of findings. Each finding has: severity, title, location (`path:line` or requirement ID), evidence (what is wrong, and why, citing the spec), and a suggested fix. Reviewers do not edit code.

## Severities (PROC-021)

**BLOCKER.** The change is wrong or unsafe to merge. Any one of these:

- violates a MUST in the spec, or implements behavior contradicting it;
- can lose or corrupt data on either provider or in the database, or can write to a provider outside the intended scope;
- leaks secrets (logs, raw responses, argv, error messages, UI);
- breaks authorization (a role can do something AUTH-020 forbids, or a policy is missing);
- breaks the build, CI, or a previously passing test;
- makes a Run non-idempotent or non-resumable where the spec requires it to be;
- exceeds provider quota or ignores the quota service.

**MAJOR.** The change works in the happy path but would likely cause defects or rework. Any one of these:

- an acceptance criterion or listed requirement is not met, or not tested;
- missing error handling for documented provider failures (404, 409/422, 429, secondary limits, timeouts);
- a race condition or concurrency issue without a guard;
- the ARC-012 layering rule is bypassed, or provider nomenclature leaks into `core`, `facets`, `db` or UI copy (GLO-002);
- tests that don't actually assert the behavior (tautological, over-mocked, snapshot-only for logic);
- a spec ambiguity decided without an `agent-decided` ADR;
- user-facing strings not in i18n files, or an inaccessible interactive control.

**MINOR.** Quality issues that don't risk correctness: naming, readability, duplication, small doc gaps, log message wording, non-critical performance.

## Reviewer focus

- **Spec-conformance reviewer:** reads the task's requirement IDs and acceptance criteria first, then the diff. It checks every requirement against code *and* tests, and checks that the docs updated.
- **Adversarial reviewer:** assumes the code is wrong. It looks for inputs and sequences that break it: retries after partial failure, duplicate jobs, provider edge cases (empty repo, unicode names, huge lists, pagination boundaries), permission bypass, malformed config, clock skew, cancelled Runs, quota exhaustion mid-Run, concurrent edits through the API.

## Output format

```markdown
## Review — T-xxx — round N — <spec|adversarial>
Verdict: CHANGES_REQUIRED | ACCEPTABLE   (ACCEPTABLE = no BLOCKER/MAJOR)

### [BLOCKER] <title>
- Location: packages/x/src/y.ts:42 (LIF-042)
- Evidence: …
- Fix: …
```
