# AGENTS.md

git-migrator is a provider-neutral framework and web app for migrating repositories between git providers. The first Route is Bitbucket Cloud → GitHub. Read this file before doing anything.

## Read order

1. `docs/spec/00-overview.md`, then `01-glossary.md`. Use the glossary's vocabulary everywhere.
2. `docs/process/workflow.md` (your role, the review loop, the Definition of Done) and `docs/process/review.md`.
3. `docs/spec/15-work-breakdown.md` and `docs/process/progress.md` (what to do next).
4. The spec files and provider docs your task references.

## Rules

- `docs/spec/` is **normative**. Implementors never edit it (a hook enforces this). If the spec is silent or contradictory, decide, then record `docs/adr/NNNN-*.md` with `status: agent-decided`.
- Every behavior traces to a requirement ID. Put the ID in the test name: `it('[LIF-042] …')`.
- No provider vocabulary outside `packages/adapters/*`, `docs/providers/*` and guidance text (GLO-002).
- Respect package layering (ARC-012). `core` and `facets` are pure, with no I/O.
- Never call real Bitbucket or GitHub from tests (TST-006). Use `testing/provider-fakes`.
- Never put secrets in code, logs, argv, fixtures or raw-response captures.
- All provider HTTP goes through `ProviderHttpClient` and the quota service.
- Every user-facing string goes in `apps/web/messages/en.json`, except guidance content, which goes in `packages/guidance/src/messages/en.json` (ADR-0093).
- Conventional Commits. Review fixes are `--fixup` commits, autosquashed into the commit they fix.

## Commands

Commands work the same under `devenv shell` and under the Compose `dev` container.

```sh
pnpm install
pnpm dev                 # web + worker
pnpm db:migrate && pnpm db:seed
pnpm lint && pnpm typecheck && pnpm test
pnpm test:integration    # Postgres + provider fakes
pnpm test:e2e            # Playwright against fakes
pnpm helm:check
pnpm spec:coverage       # requirement IDs without tests
```

## Layout

See `docs/spec/02-architecture.md#monorepo-layout-arc-010`. Package-specific notes live in each package's `README.md`.
