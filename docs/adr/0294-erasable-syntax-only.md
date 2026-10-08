# ADR-0294: Runtime TypeScript must be erasable

- Status: agent-decided
- Date: 2026-10-08
- Task: T-090
- Affects: DEP-001, DEP-002, ARC-012

## Context

The runtime image runs the workspace's TypeScript sources with Node's strip-only type stripping (ADR-0290). That mode rejects syntax that needs code generation: parameter properties, enums, namespaces and `import x = require()`. Vitest transforms TypeScript itself, so such syntax passed every test. The first CI image smoke test failed when the worker started importing the adapters: `packages/adapters/github/src/gh.ts` used constructor parameter properties (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). ADR-0123 had noted the constraint for the generated client and `packages/core` only.

## Decision

1. `tsconfig.base.json` sets `erasableSyntaxOnly: true` (TypeScript 7.0.2 supports it), so `pnpm typecheck` fails on non-erasable syntax in every package, app and `tools/`.
2. `tsconfig.tests.json` sets it to `false`: test files run under Vitest's transform, never under strip-only Node.
3. The two existing violations were rewritten without changing behaviour: `Gh` in `packages/adapters/github/src/gh.ts` (parameter properties became fields assigned in the constructor) and `GuidanceCoverageError` in `packages/guidance/src/coverage.ts` (same).
4. `tools/runtime-entrypoints.test.ts` imports the module graph of `apps/web/src/web.ts`, `apps/worker/src/worker.ts` and `apps/worker/src/db-commands.ts` (the module `migrate.ts` runs) in plain Node with `--no-experimental-transform-types`. It fails on any syntax error or unsupported-syntax error without Docker. It does not catch runtime-only differences such as missing production dependencies, which the image smoke test covers.

## Alternatives

- Running Node with `--experimental-transform-types` in the image: it also does not work for files under `node_modules` and moves the cost to start-up.
- A Biome rule instead of the compiler flag: the compiler flag is exact and already in the typecheck.
- Building JavaScript for the image: a new build toolchain (ADR-0290).

## Affected requirements

DEP-001, DEP-002.
