# Follow-ups

These are unresolved review findings (review loops that hit the 5-round cap) and deferred work. The orchestrator appends; nobody deletes. Resolved entries are struck through, with the PR that resolved them.

| Date | Task | Round | Severity | Finding | Location | Status |
|---|---|---|---|---|---|---|
| 2026-10-08 | T-030 | — | deferred | Validate the 11 unverified Bitbucket items (ADR-0036) during the live e2e; support.atlassian.com was unreachable | docs/adr/0036-unverified-bitbucket-items.md | open |
| 2026-10-08 | T-031 | — | deferred | ADR-0040: staging/contract check that a non-listed writer's force push is rejected and a bypass actor's is accepted; on a GraphQL validation error for `allowsForcePushes:false` + bypass list, retry with empty list and report `branch-rules.exemptions-dropped` (T-033) | docs/adr/0040-force-push-fail-closed.md | open |
| 2026-10-08 | T-031 | 2 | MINOR | 403 on GraphQL branch-protection mutations or repo delete must map to a blocking finding with guidance (Administration: write), not a retry; confirm required permission and whether org delete-policy blocks Apps on staging (T-033) | docs/providers/github.md | open |
| 2026-10-08 | T-031 | 2 | MINOR | Secondary-limit point costs are "most" GET=1/write=5 with undisclosed exceptions; JOB-045 must rely on 403/429 handling, not exact local point accounting (T-025) | docs/providers/github.md | open |
| 2026-10-08 | T-031 | 2 | MINOR | trim-openapi.py output is not byte-reproducible (components order); sort keys | testing/provider-fakes/specs/trim-openapi.py | open |
| 2026-10-08 | T-031 | — | deferred | Confirm branch-protection pattern case sensitivity; pin deploy-key 422 body text in the T-042 fake | docs/providers/github.md | open |
| 2026-10-08 | T-031 | — | deferred | T-003 gitleaks config must allowlist testing/provider-fakes/specs/github.openapi.json (GitHub's public example tokens) | testing/provider-fakes/specs/README.md | open |
