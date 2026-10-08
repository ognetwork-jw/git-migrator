# @git-migrator/git

Typed wrapper around the system `git` and `git-lfs` CLIs (ARC-010). It implements the adapter-sdk `GitClient` (`lsRemote`) and adds what the Run engine needs for the git steps of LIF-040. Pure Node, no provider vocabulary (GLO-002). Layering: depends on `adapter-sdk`, `core` and `canonical` only (ARC-012).

## API

`new GitService({ quota, scratchDir, ... })` is built per Endpoint credential: `quota` pre-acquires units in that credential's `git` bucket (`createGitQuota` adapts the quota service's `acquire`), `scratchDir` is the Run's scratch directory (JOB-015), where credential files live.

| Method | Step | Quota (JOB-041) |
|---|---|---|
| `lsRemote({ url, credential })` | FAC-GIT-001, `git ls-remote --symref`; annotated tags record `sha` (tag object) and `peeled` (commit); `headSymref` from HEAD | 1 |
| `mirror({ url, credential, dir })` | `git.prepare`: `git clone --mirror` into scratch; an existing mirror is fetched instead (resumed step); returns `sizeBytes` for JOB-015 | 3 |
| `scanBlobs({ dir, maxBlobBytes })` | FAC-GIT-004: blockers `git-refs.blob-too-large` (path, size), warnings `git-refs.blob-large` above 50 MiB. Local, no quota | 0 |
| `listLfsObjects(dir)` | LFS OIDs and sizes referenced by any ref (`git lfs ls-files --all`) | 0 |
| `fetchLfs(...)` / `pushLfs(...)` | `git lfs fetch --all` from the source, `git lfs push --all` to the target | 1 per 100 objects |
| `pushRefs({ dir, url, defaultBranch })` | LIF-044 batched push (below) | 1 + 3 per push attempt |
| `deleteRefs(...)` | removes target refs (LIF-043 reconcile), groups of 100 | 3 per push |
| `verifyLfsParity(batchClient, objects)` | FAC-GIT-005 check through the LFS batch API `download` operation. The `LfsBatchClient` is supplied by the adapter or worker over `ProviderHttpClient`, so provider HTTP stays behind the quota service | via the client |

A denied quota acquire throws `AdapterError` `rate_limited` with `retryAt` before any process starts (JOB-044). Failed commands throw `GitCommandError` (an `AdapterError`) whose `reason` is `push-too-large`, `blob-too-large`, `unauthorized`, `forbidden`, `not-found`, `rejected`, `rate-limited`, `network` or `unknown`; the Run engine turns `push-too-large` into the run-origin blocker `git-refs.push-too-large` (LIF-042, LIF-049). Classification matches stable stderr fragments (ADR-0071), never exact wording.

## Credentials (ADP-071)

A credential reaches git only through `GIT_ASKPASS`. For each operation the package writes a script and a `credential` file (mode 0600, in a 0700 directory) under the scratch directory and removes both afterwards. The credential is never in argv (a declared secret in argv aborts the command), never in a remote URL (URLs with userinfo are refused), never in `.git/config` and not in the child's environment. The script answers only for the origin of the URL the command was given, so a redirect to another host gets nothing. `HOME` is a private directory, `credential.helper` is reset, prompts are off, and only `http(s)` transports are allowed. Error text and logs are scrubbed with the adapter-sdk scrubbers, and secrets shorter than `MIN_SECRET_LENGTH` are refused. The remotes git-lfs needs are given through `GIT_CONFIG_*` in the child's environment (`origin` for the source, `gm-target` for the target).

Further guards: LFS commands pin the endpoint to the remote's own `<url>/info/lfs` through `GIT_CONFIG_*` (a `.lfsconfig` in the repository cannot redirect them), URLs are normalised before they reach git, and `sweepStaleCredentialFiles(scratchDir)` removes credential directories that a SIGKILL orphaned: it skips every session this process still has open and only removes directories older than `olderThanMs` (default 10 minutes). That assumes a per-pod scratch volume (JOB-015); a shared volume would need owner tokens. T-028's scratch cleanup should call it.

## Stalled remotes

Git and git-lfs get low-speed and dial timeouts through the environment. Remote commands also run under an inactivity watchdog (`stallTimeoutMs`, default 10 minutes without output): the process group is killed and a retryable `transient` `GitCommandError` is raised. An abort signal kills the same group and raises a non-retryable `transient` error with `reason: cancelled`.

## Batched push (LIF-044)

1. LFS is pushed first (`pushLfs`).
2. The default branch is pushed in checkpoints: `git rev-list --first-parent --reverse` gives the history, and a binary search over the estimated pack since the last checkpoint picks the furthest commit that fits `maxPushBytes` (default 1.5 GiB, `git.maxPushBytes`). The estimate is `git rev-list --objects --disk-usage` (git 2.31 or later) or the byte count of `git pack-objects --revs --stdout --thin`. A single commit above the limit is pushed alone (LIF-042).
3. Other branches follow in groups of 50, tags in groups of 100. A group whose estimate is above the limit is split. If the provider rejects a push the estimate said would fit (`push-too-large`), the planner halves the target size and plans again.
4. Refs the target already has at the wanted sha are skipped, and shas the target has are excluded from every estimate, so a resumed or repeated step sends only what is missing.
5. Each push retries up to 3 times (backoff with full jitter, base 1 s, cap 60 s) when the failure is transient. Rejections of a ref (non-fast-forward, hook or rule declined, read from the `--porcelain` output) and invalid refspecs are not retried and name the refs. Rate limits are not retried in process. `push.followTags` is off and nothing is atomic across groups. Only `refs/heads/*` and `refs/tags/*` are pushed; hidden refs such as pull request refs stay in the mirror.

## JOB-015

The jobs runtime (T-028, `checkScratchSpace`) owns the per-Run scratch directory, the free-space check, the 10 minute delay and the counter. This package supplies the numbers: `scratchNeededBytes({ sizeBytes, lfsBytes })` (`ceil(sizeBytes x 2.2) + lfsBytes`), `mirror().sizeBytes` and `lfsBytes(listLfsObjects(dir))`. T-028's precheck consumes `scratchNeededBytes`; the orchestrator wires the two at T-034.

## Tests

Unit tests run the real `git` and `git-lfs` CLIs against the fake git server (`testing/provider-fakes`, TST-006, TST-013); slow ones set explicit timeouts. `pnpm --filter @git-migrator/git test`.
