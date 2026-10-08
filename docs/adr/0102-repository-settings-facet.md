# ADR-0102: repository-settings facet semantics

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-050
- Affects: FAC-SET, FAC-SET-001, FAC-SET-002, FAC-SET-003, FAC-005

## Context

The FAC-SET table says a description over 350 characters is "lossy" without naming a policy key, says `forking` on a public repository with `private-only` is lossy but is silent for `disallowed`, and does not say how the facet detects that the organization forbids private forking.

## Decision

- **New policy key `repository-settings.description-truncated`** for the 350 limit. `translate` truncates `description` (after prefix stripping and trimming) at 350 UTF-16 units, never splitting a surrogate pair, trims trailing whitespace, and records a `lossy` decision at `/description`. UTF-16 units are the conservative reading of "350 chars": the result never exceeds 350 under any counting method. Key and task need guidance only through the shared `repository-settings.accept-lossy` entry.
- **Public repositories are always forkable**, so for `visibility: 'public'` both `private-only` and `disallowed` cannot be represented. Both map to `allowed` as a `lossy` decision at `/forking` with the spec's key `repository-settings.public-fork-policy` (the spec names only `private-only`; `disallowed` is the same loss, and failing silent would be worse).
- **Private repositories:** `allowed` and `disallowed` are exact; `private-only` becomes `allowed` as a `translated` decision. `compare` treats `private-only` as `allowed` on private repositories, on both sides.
- **FAC-SET-002:** when `ctx.targetCaps.fields['/forking']` is `unsupported` and the repository is private, `translate` emits the post task `repository-settings.org-forking-disabled` (completion `manual`, path `/forking`, no params) and records an `unsupported` decision at `/forking`. It replaces the `translated` decision for the same path (the engine allows one decision per path). `desired.forking` keeps the translated value, so parity reports the drift until the organization changes. Public repositories ignore the capability.
- **`normalize`** (FAC-SET-003) strips one leading `[MIGRATED → <url>]` prefix (a URL has no whitespace or `]`; the trailing space may have been trimmed away by the provider), trims the description, trims `homepage` and turns an empty one into `null`.
- The repository name is not in the facet (FAC-SET-001).

## Alternatives

- Do not truncate and let the apply fail: rejected, the Run would fail on a field the user can decide about.
- Reuse `repository-settings.public-fork-policy` for truncation: rejected, the two decisions have different meaning and acceptance scope.
