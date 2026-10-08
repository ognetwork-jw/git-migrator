# ADR-0030: Coverage thresholds, placeholders and module resolution

- Status: agent-decided
- Date: 2026-10-08

## Context

TST-005 sets per-package Vitest v8 thresholds, but T-001 creates placeholder packages. ARC-001 does not fix the TypeScript module resolution mode.

## Decision

- One root `vitest.config.ts` with a `unit` project. Thresholds are glob thresholds (`packages/core/src/**` and so on) so each package is measured on its own files. Packages with no listed threshold are measured but not gated.
- Every placeholder `src/index.ts` exports a one-line constant (`PACKAGE_NAME`). `tools/bootstrap.test.ts` imports each of them, so all placeholders are covered and thresholds pass from the start. Later tasks replace the placeholder with real code and real tests; the thresholds then apply to real code without any configuration change.
- Per-package `test` scripts exist for Turborepo (`vitest run --root ../.. --project unit <dir>`); coverage is only enforced by the root `pnpm test`. **CI (T-003) must therefore run the root `pnpm test`** (not only `turbo run test`), or the TST-005 thresholds are not checked.
- **Test file naming.** In packages and apps only `*.test.*` is a test: it is run by Vitest and type-checked by `tsconfig.tests.json`. `*.spec.*` files are rejected there by `pnpm lint` (ADR-0028), since nothing would run them. Playwright specs `testing/e2e/**/*.spec.*` are the exception.
- Package `tsconfig.json` files exclude `*.test.*`/`*.spec.*` from the build graph; `tsconfig.tests.json` (no emit) type-checks those files and `vitest.config.ts`. Its `include` has one pattern per extension (`*.test.ts`, `*.test.tsx`, `*.test.mts`, and the integration/Playwright locations from `tools/test-globs.ts`) because tsconfig does not support brace expansion (an earlier `{ts,tsx,mts}` version silently matched nothing); `tools/bootstrap.test.ts` keeps it in sync with `test-globs.ts` and proves that an ill-typed test in each location fails `tsc -p tsconfig.tests.json`, and the root `pnpm typecheck` runs `tsc -b && tsc -p tsconfig.tests.json`. The per-package `typecheck` script used by Turborepo therefore does not cover tests; CI must run the root `pnpm typecheck`.
- All globs in `vitest.config.ts` include `.tsx` and `.mts` (apps/web and packages/api contain JSX); a test guards this.
- TypeScript uses `module: ESNext` with `moduleResolution: Bundler`, `verbatimModuleSyntax`, and internal packages are consumed as source (`"exports": { ".": "./src/index.ts" }`). `tsc -b` only type-checks and emits declarations (`emitDeclarationOnly`). Consequence: the web app is built by Next.js and the worker entrypoints must be bundled (or run through a TypeScript loader); T-090 owns that.
- `tools/*.ts` run directly on Node 24 (type stripping), so they use `.ts` import specifiers and `erasableSyntaxOnly`.

## Alternatives

- `NodeNext` resolution (explicit `.js` extensions in every import): would let compiled output run on plain Node, but conflicts with the Next.js toolchain and adds noise everywhere.
- Excluding placeholders from coverage: would need config edits in every later task.

## Affected requirements

TST-005, ARC-001, ARC-010.
