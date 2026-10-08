# ADR-0049: CI jobs, action pinning and the gitleaks scan

- Status: accepted (no spec change needed)
- Date: 2026-10-08

## Context

DEP-060 names the unit tier only for T-003 (lint, typecheck, unit). CI must run on `ai-main` and `main` (ADR-0045). The repository is owned by an organization (`ognetwork-jw`) and is private. The first real CI run on PR #4 failed in the secrets job with "License key is required": `gitleaks/gitleaks-action` needs a paid `GITLEAKS_LICENSE` for organization repositories. The spec does not say how to pin actions or which gitleaks distribution to use.

## Decision

- `.github/workflows/ci.yml` has two jobs. `checks` runs `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (the root script, not turbo, per ADR-0030) and `pnpm spec:coverage`, which only reports (ADR-0029). `secrets` runs the gitleaks release binary. Node is 24 (`.nvmrc`). pnpm is read from `packageManager`. The workflow keeps `permissions: contents: read`.
- Every action is pinned to a full commit SHA with the tag in a comment: checkout v7.0.1, setup-node v7.1.0, pnpm/action-setup v6.1.0.
- **gitleaks binary, not the action.** The job downloads `gitleaks_8.30.1_linux_x64.tar.gz` from the release, checks its SHA-256 against a value committed in the workflow (`GITLEAKS_SHA256`, the entry for that archive in the release's `gitleaks_8.30.1_checksums.txt`) with `sha256sum --check --strict` before unpacking, and runs `gitleaks git --config .gitleaks.toml --log-opts "HEAD" --redact`. The checkout uses `fetch-depth: 0`, so the whole history of the checked-out commit is available. Scanning is limited to commits reachable from `HEAD`; other branches are not scanned, so an unmerged task branch cannot fail the job for another task.
- **Allowlists are narrow.** `.gitleaks.toml` extends the default rules and allowlists two whole files that hold GitHub's published example tokens and the test-only fake App key (exact anchored paths). Three findings in the published Bitbucket and GitHub documentation examples are suppressed by fingerprint in `.gitleaksignore` (commit, file, rule, line), so a new secret in the same file is still reported. Verified: a new token in `testing/provider-fakes/specs/README.md` and a new credential in `bitbucket-cloud.openapi.json` are both detected. In gitleaks 8.30.1 a combination of several global `[[allowlists]]` entries with `condition = "AND"` suppressed too much in testing, so the fingerprint form was used for these three findings.
- **Scope of findings.** Two findings from `packages/observability` test fixtures (a private-key-shaped string and a credential-shaped literal, commit `85ee17f6c2`) exist only on the T-004 branch. They are not reachable from `ai-main` or from this branch. T-004 must handle them (narrow fingerprint, or fixtures built at run time) before its PR runs the secrets job.
- The workflow was checked with actionlint v1.7.12 (clean) and shellcheck v0.10.0 on the hooks. A local `gitleaks git --config .gitleaks.toml --log-opts HEAD` over this branch reports no leaks.

## Alternatives

- `gitleaks/gitleaks-action` with a `GITLEAKS_LICENSE` secret: rejected, because it needs a paid license for this organization.
- Tags such as `@v7` instead of SHAs: rejected because moving tags can change the code run in CI.
- Integration, e2e and helm jobs: DEP-060 assigns them to later tasks (T-075, T-083, T-090). Adding them now would fail on unimplemented commands.

## Affected requirements

DEP-060, PROC-007 (agent files are not CI).
