# ADR-0069: Committed fake GitHub App key and `.env.test`

- Status: agent-decided
- Date: 2026-10-08

## Context

DEV-030 asks for a throwaway RSA key at `testing/fixtures/fake-github-app.pem`, used only by the fakes and allowlisted by exact path for gitleaks (T-003), and for a committed `.env.test` with fake values only.

## Decision

1. `testing/fixtures/fake-github-app.pem` is a 2048-bit RSA key generated with `openssl genrsa -traditional 2048` (PKCS#1 `BEGIN RSA PRIVATE KEY`, the format GitHub issues). Its file mode is 0644 so that git stores it as 100644. It is used only by the fakes and the secretspec `fixtures` provider. A unit test checks it loads as a 2048-bit RSA key ([DEV-030]).
2. `.env.test` holds the test profile's values, all fake. It is excluded from `.env.*` by the existing `!.env.test` line in `.gitignore`. A unit test checks that its keys are the test profile's defaulted secrets and that it contains no PEM block ([DEV-030]).
3. The key is not a secret. Nothing else in the repository may reuse it, and T-003 must keep gitleaks scope to that exact path.

## Affected requirements

DEV-030.
