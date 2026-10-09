# git-migrator

Provider-neutral framework and web app for migrating repositories between git providers. Start with [AGENTS.md](AGENTS.md) and [docs/README.md](docs/README.md).

Requires Node 24 (`.nvmrc`) and pnpm (pinned by `packageManager`).

```sh
pnpm install
pnpm dev                     # web and worker (turbo)
pnpm build                   # turbo build
pnpm lint                    # Biome plus the ARC-012 dependency check
pnpm typecheck               # tsc -b, then the test projects
pnpm test                    # unit project with the TST-005 coverage thresholds
pnpm test:integration        # Postgres + provider fakes (TST-020)
pnpm test:e2e                # Playwright against the fakes (TST-021); builds the web app first
pnpm test:visual             # visual regression project of the e2e package
pnpm test:e2e:live           # live e2e against real accounts (TST-030; see docs/e2e-setup.md)
pnpm test:e2e:live:dry       # the live e2e plan without touching any provider
pnpm e2e:live:reset          # clean up what a live e2e run created
pnpm db:migrate              # DATA-030 migrate entrypoint
pnpm db:seed                 # seed development data
pnpm db:reset                # drop and recreate the development database
pnpm generate                # regenerate the database client
pnpm helm:check              # lint and render the chart (DEP-020)
pnpm spec:coverage           # requirement IDs without tests; add -- --strict to gate (CI does)
pnpm spec:must-test          # regenerate must-test.txt
pnpm check:packages          # lint, typecheck and test through Turborepo
pnpm format                  # Biome format
```

`tools/` holds repository tooling: `check-deps.ts` (ARC-012 dependency rules, run by `pnpm lint`), `spec-coverage.ts` (TST-002), `helm-check.ts` and the other scripts that the root commands call.
