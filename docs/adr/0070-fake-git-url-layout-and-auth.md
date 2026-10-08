# ADR-0070: Fake git server URL layout and authentication

- Status: agent-decided
- Date: 2026-10-08
- Task: T-040
- Affects: TST-013, DEV-020

## Context

TST-013 asks for "separate roots per fake" behind one Node HTTP server on port 4030 (DEV-020) but does not say how a client selects a root, which credentials are accepted, or where LFS objects live.

## Decision

- URL layout: `http://host:4030/{source|target}/{repoPath}.git`, where `source` is the root used by the fake Bitbucket and `target` the root used by the fake GitHub. `repoPath` is one or more `[A-Za-z0-9._-]` segments (for example `acme/app`). Each side has its own repository directory (`<root>/<side>/repos`) and its own LFS object store (`<root>/<side>/lfs/<repoPath>/<oid>`), so a repository has distinct LFS storage per side and per repository.
- Auth: every request needs HTTP Basic credentials, including reads (the real providers are used with private repositories). A side accepts a configurable list of passwords (default `fake-token`) and, optionally, a list of usernames (default: any non-empty username, because the Bitbucket API-token username is unverified, ADR-0036). A `authenticate(username, password)` callback overrides both. Failure is `401` with `WWW-Authenticate: Basic`.
- LFS endpoint: `{repoUrl}/info/lfs` (what git-lfs derives from a `.git` remote URL), same Basic auth. Batch responses carry no credentials in action headers (the provider doc does not say GitHub returns any); follow-up requests (PUT, GET, verify) must authenticate, which git-lfs does for same-host links. Action links are built from the configured `publicUrl` (default: the listening address), never from the `Host` header. LFS requests for a repository that does not exist are 404, and a PUT whose size differs from the size announced in the upload batch is 422. The batch size limit defaults to 100 objects (GitHub's documented default) and answers 413 above it.
- `source` is read-only by default (`allowPush` false: `http.receivepack=false`), `target` accepts pushes; both run with `transfer.fsckObjects=true`.
- Tests and helpers pass credentials with `GIT_CONFIG_*` (`http.extraHeader`) in the child environment, never in argv or on disk.

## Alternatives

- One root with a repo-name prefix per side. Rejected: harder to reset and inspect one side.
- Anonymous reads. Rejected: would hide missing-credential bugs in the git package.

## Consequences

The combined fake start script (T-041/T-042) maps the fake Bitbucket's clone URLs to `/source/...` and the fake GitHub's to `/target/...`. T-043 seeds both roots through `seedBareRepo`. The fake GitHub (T-042) must call `createBareRepo(server.repoDir('target', 'owner/name'))` when a repository is created through its API, otherwise a push or LFS call to it is a 404. `startFakes` starts the git server beside the fake Bitbucket and points the latter's clone links at `/source`.
