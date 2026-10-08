# ADR-0130: Fixture world structure, async fixtures and expectation derivation

- Status: agent-decided
- Date: 2026-10-08
- Task: T-043
- Affects: TST-012, TST-010, TST-011, TST-013, LIF-031, FAC-MRG-001, FAC-DKY-003

## Context

TST-012 names `testing/fixtures/world.ts` and requires the world to be built by `/__reset world`. Several points are open:

1. The fixture builders of the fakes are synchronous, but the world must also seed the git server (`git fast-import`, async). The fake Bitbucket's `reset()` was synchronous.
2. `provider-fakes` cannot import `fixtures` (that would be a cycle), yet `pnpm start` of the fakes should be able to serve `world`.
3. The expected readiness of each repository must be written before the facets exist.
4. The Bitbucket default merge strategies include `fast_forward`; FAC-MRG-001 maps `fast-forward-only` to `rebase` as lossy `merge-settings.ff-only-as-rebase`, but the spec does not say whether an allowed `fast_forward` next to `merge_commit` is "fast-forward-only".

## Decision

- Code lives in `testing/fixtures/src/` (package layout; `world.ts` and `world-spec.ts` there stand for the spec's `testing/fixtures/world.ts`). The package depends on `provider-fakes`; `pnpm --filter @git-migrator/fixtures start` starts all fakes with `world` registered and built.
- Fixture builders of the fake Bitbucket and fake GitHub may return a promise. The fake Bitbucket's `reset()` returns a promise only then (sync builders keep the old behaviour), queues resets requested meanwhile, and answers non-control requests with 503 until the builder settles. The fake GitHub already blocked requests during a reset and now awaits the builder.
- The Bitbucket `world` builder rebuilds the git `source` side (removes `acme/*` and its LFS objects, seeds every repository) and then the REST state, with real commit ids. The GitHub `world` builder creates the members and sets the target limits (`WORLD_LIMITS`, 1 MiB blob and push) on the REST contents API and the git `target` side. Neither creates GitHub repositories (TST-012), so `syncPolicy` is not needed.
- Expectations are plain data (`world-spec.ts`), derived from the spec text, checked in tests against the guidance finding codes (code and severity) and LIF-004, and rendered into the README table, which a test keeps equal.
- Every world branch offers `merge_commit` and `squash` only, so merge settings are exact and no `merge-settings.accept-lossy` pre task depends on the open `fast_forward` question. If the adapter task decides differently, change `MERGE_STRATEGIES` in `world.ts`.
- `data/with-grants` expects, before the endpoint migration, the blocker `access-control.team-missing` plus a pre task for `bob` (login-only match, "suggested"); `alice` matches by email and is confirmed. After team creation and confirming `bob` it is Ready. Post tasks and warnings never change readiness (LIF-004).

- A failed async builder leaves half a world, so REST and `/__state` keep answering 503 until the next successful reset; queued resets run whatever the previous result was. The git server is not gated during a reset, so callers await `reset()` before git access.
- `startWorldFakes` wraps every fixture of both fakes (`empty` included): a Bitbucket reset cleans the `acme/*` source repositories and LFS objects, a GitHub reset restores the git `target` limits to the configured ones.
- `ops/hooks`: a non-allowlisted hook is omitted from `desired` (FAC-WEB-002, "appear only as the post task"), so it gets `webhooks.recreate-manually` only; `webhooks.set-secret` is for hooks that are created. The orchestrator confirmed this reading.

## Alternatives

- Synchronous world with `git fast-import` through `execFileSync`. Rejected: blocks the event loop of the fakes.
- Seeding git in a separate call before `/__reset world`. Rejected: the acceptance says `/__reset world` builds everything.

## Consequences

`GET /__state` output is deterministic apart from rate-limit usage counters. Plain `worldFixtures()` without `startWorldFakes` does not clean git state on other resets.
