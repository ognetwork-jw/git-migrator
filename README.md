# git-migrator

Provider-neutral framework and web app for migrating repositories between git providers. Start with [AGENTS.md](AGENTS.md) and [docs/README.md](docs/README.md).

Requires Node 24 (`.nvmrc`) and pnpm (pinned by `packageManager`).

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm spec:coverage           # requirement IDs without tests (report-only; add -- --strict to gate)
```

`tools/` holds repository tooling: `check-deps.ts` (ARC-012 dependency rules, run by `pnpm lint`), `spec-coverage.ts` (TST-002) and `not-implemented.ts` (stubs for root scripts owned by later tasks: `db:*`, `generate`, `test:integration`, `test:e2e`, `test:e2e:live`, `e2e:live:reset`, `helm:check`).
