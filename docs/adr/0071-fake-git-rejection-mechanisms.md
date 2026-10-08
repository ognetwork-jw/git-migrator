# ADR-0071: How the fake target rejects oversized blobs and pushes

- Status: accepted (no spec change needed)
- Date: 2026-10-08
- Task: T-040
- Affects: TST-013, LIF-044

## Context

TST-013 says the fake GitHub side rejects large blobs and pushes "like GitHub does". The provider doc gives the limits (blob 100 MiB, push 2 GiB) but not the exact wording GitHub prints.

## Decision

- Blob limit: a `pre-receive` hook (shared script, enabled through `core.hooksPath` in the CGI's `GIT_CONFIG_*` environment, limit in `GM_FAKE_MAX_BLOB_BYTES`) walks `git rev-list --objects <new> --not --all` and rejects with the text GitHub's server prints, from memory of real output (not verified against a live capture):
  `error: File <path> is <n> MB; this exceeds GitHub's file size limit of <limit> MB` followed by `error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.`; the client shows `! [remote rejected] <ref> (pre-receive hook declined)`. The 50 MiB warning is not emulated.
- Push limit: the Node server counts the bytes of a `git-receive-pack` request body while piping it to the CGI. Once the limit is exceeded it stops feeding the CGI, kills it (nothing is applied, refs are untouched), drains the rest of the body and answers a fixed `413` with `fatal: pack exceeds maximum allowed size (N bytes)`. The git client prints `HTTP 413` (`RPC failed; HTTP 413`); tests pin that fragment. Earlier `receive.maxInputSize` was rejected because the failure shape (connection reset versus "unpack failed") depends on the git version. The real GitHub text for the 2 GiB limit is not captured. The CGI's response head is held back until its first body byte so the 413 can still be sent.
- The hook prints one line per distinct oversized blob (deduplicated by object id), uses the object id when the blob has no path (a tag pointing at a blob), and ignores blobs already present in the repository's own object store (outside the push quarantine), so a force-push that only moves refs onto stored data is not rejected. A rejected push is atomic: no ref of a multi-ref push is updated. The temp file is removed on exit and on signals.
- Defaults: 100 MiB and 2 GiB on the `target` side, no limits on `source`. Both can be changed at runtime (`setLimits`) and lowered in tests.

## Alternatives

- Reject inside the Node server by inspecting the pack. Rejected: would reimplement pack parsing.
- Per-repository hook files. Rejected: needs the hook installed in every seeded repository.

## Consequences

Code that classifies push failures (T-027) must not depend on the exact text; it should match on stable fragments (`GH001`, `pre-receive hook declined`, `HTTP 413`). A live capture should refine the wording (follow-up).
