# ADR-0072: Seeding fake git repositories with `git fast-import`

- Status: agent-decided
- Date: 2026-10-08
- Task: T-040
- Affects: TST-012, TST-013

## Context

T-043's fixture world needs repositories with branches, annotated and lightweight tags, LFS objects, thousands of commits and an oversized blob, rebuilt on every `/__reset`.

## Decision

`seedBareRepo(barePath, spec, lfs?)` writes a `git fast-import` stream directly into a bare repository: no work tree, deterministic timestamps and authors, and fast for many commits. LFS files are committed as pointer files plus a `.gitattributes` and the object bytes are written to the side's `LfsObjectStore`, so the git-lfs CLI downloads them as if pushed. `bytesPerCommit` makes every default-branch commit add a file of that many incompressible bytes, so the pack size of a long history is realistic (about `bytesPerCommit` per commit) and the LIF-044 batching (`ops/large-history`) can use a realistic `maxPushBytes`. Big blobs use deterministic pseudo-random bytes so pack size tracks blob size.

## Alternatives

- Cloning, committing and pushing with the CLI. Rejected: slow for many commits and needs a running server.

## Consequences

Seeding works on the filesystem without a running server, so a reset can rebuild roots before the server starts.
