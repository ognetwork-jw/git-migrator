# @git-migrator/fixtures

The TST-012 fixture world: one workspace `acme` (projects `PLAT`, `DATA`, `OPS`, `KEYS`) on the fake Bitbucket, the git `source` side seeded with real repositories, and an organization `acme` on the fake GitHub with no repositories and no teams.

```sh
pnpm --filter @git-migrator/fixtures start      # all fakes, world already built (FIXTURE_WORLD=0 starts empty)
curl -XPOST :4020/__reset -d '{"fixture":"world"}'   # GitHub: members, target limits
curl -XPOST :4010/__reset -d '{"fixture":"world"}'   # Bitbucket: rebuilds the git source side too
```

In code: `startWorldFakes(options)` (same options as `startFakes`, the world fixture registered on both fakes), `resetWorld(fakes)`, or `worldFixtures(getGit)` for `createFakeBitbucket({ fixtures })` / `createFakeGitHub({ fixtures })`. Pure data (identities, repositories, expectations, `WORLD_ROUTE`, `WORLD_LIMITS`) is in `world-spec.ts`.

Things to know:

- The Bitbucket `world` fixture is async (it seeds git). While it runs, and after a failed build until the next successful reset, the fake Bitbucket answers 503 on REST and `/__state`; the control plane keeps working and resets queue in call order (ADR-0130). The git server is **not** gated: await `reset()` (or the `/__reset` response) before touching it. Reset GitHub first when doing both, as `resetWorld` does.
- The GitHub `world` fixture sets the REST `maxBlobBytes` and the git `target` limits (`WORLD_LIMITS`, 1 MiB each). With `startWorldFakes`, every fixture is wrapped: any Bitbucket reset (`empty` too) removes the `acme/*` source repositories and their LFS objects, and any GitHub reset restores the `target` limits to the configured ones (defaults 100 MiB / 2 GiB). Plain `worldFixtures()` used with `startFakes` does not clean.
- The world creates no GitHub repositories, so no branch protection is involved and `fake.syncPolicy()` is not needed. A scenario that seeds a target repository with rules must call it after seeding (provider-fakes README).
- Source data is deterministic: two resets give identical commit ids.
- The Route the expectations assume (`WORLD_ROUTE`): default `acceptLossy`, auto-confirm by email, webhook allowlist `https://hooks.acme.example/**`, default naming. Every branch offers the `merge_commit` and `squash` strategies only (ADR-0130).
- Identities: `alice` matches GitHub `alice-gh` by email (AUTH-050, needs the Atlassian Admin email source on the Bitbucket side), `bob` matches `bob` by login only (suggested), `carol` matches nobody. `erin` exists only on GitHub. The operator account is a workspace admin.
- Not modelled by the fakes, so not in the world: the repository website (`homepage`).
- The wiki of `ops/wiki-issues` is a bare repository at `acme/wiki-issues.git/wiki` on the git server (`git ls-remote <repo>.git/wiki`).
- `.gitattributes` and `assets/sample.bin` of `plat/auto-ok` come from the seeder (it tracks the exact path, not `*.bin`). Files such as `bitbucket-pipelines.yml` are seeded through the seeder's `bigBlobs` option, which is only a name.

## Expected readiness and findings

Derived from the spec text, not from running facets (`packages/facets` is not built yet): FAC-ACL/FAC-006 (principals), FAC-DKY-003, FAC-WEB-002, FAC-PIP-003, FAC-SEC-001, FAC-CRQ, FAC-EXT, FAC-GIT-004/LIF-049, LIF-031, LIF-004 (blocker beats pre task beats Ready; post tasks and warnings never affect readiness). `ops/hooks` gets only `webhooks.recreate-manually`: a non-allowlisted hook is omitted from `desired` (FAC-WEB-002), so `webhooks.set-secret` does not apply to its secret. A test checks every code and severity against `@git-migrator/guidance` and that the table equals `world-spec.ts`. When a facet lands and disagrees, fix the data and this table together, and record why. T-061 (ADR-0313): `data/with-grants` also gets blocker `branch-rules.team-missing` (FAC-006: the push restriction names the group), and the table assumes the Atlassian Admin email enrichment of AUTH-050 step 1, which the analysis test supplies as a decorator because the adapter does not build it yet.

| Repository | Planned target | Expected after Analysis | Later |
|---|---|---|---|
| `plat/auto-ok` | plat-auto-ok | Ready | - |
| `data/with-grants` | data-with-grants | Blocked: `access-control.team-missing` (B), `access-control.unmapped-principal` (pre), `branch-rules.team-missing` (B) | After endpoint migration created the team platform-team and bob was confirmed: Ready |
| `plat/with-secrets` | plat-with-secrets | Ready: `secrets.set-value` (post) | - |
| `plat/open-pr` | plat-open-pr | Blocked: `change-requests.open` (B) | - |
| `data/unmapped-user` | data-unmapped-user | NeedsAttention: `access-control.unmapped-principal` (pre) | - |
| `data/pipelines-simple` | data-pipelines-simple | Ready: `pipelines.review-and-merge` (post) | - |
| `data/pipelines-pipes` | data-pipelines-pipes | Ready: `pipelines.complete-translation` (post) | - |
| `ops/hooks` | ops-hooks | Ready: `webhooks.recreate-manually` (post) | - |
| `ops/big-blob` | ops-big-blob | Ready | After the first migrate Run failed at git.prepare: Blocked: `git-refs.blob-too-large` (B) |
| `ops/large-history` | ops-large-history | Ready | - |
| `ops/name-collision-a` | ops-name-collision-a | Blocked: `naming.collision` (B) | - |
| `ops/name_collision_a` | ops-name-collision-a | Blocked: `naming.collision` (B) | - |
| `keys/shared-key-1` | keys-shared-key-1 | Ready: `deploy-keys.key-in-use` (post) | - |
| `keys/shared-key-2` | keys-shared-key-2 | Ready: `deploy-keys.key-in-use` (post) | - |
| `ops/wiki-issues` | ops-wiki-issues | Ready: `extras.wiki-not-migrated` (W), `extras.issues-not-migrated` (W), `extras.downloads-not-migrated` (W) | - |

Declared internal dependencies (ARC-012, checked by `pnpm lint`): `provider-fakes`; `guidance` (dev, tests only).
