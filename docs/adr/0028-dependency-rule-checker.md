# ADR-0028: Custom dependency-rule checker for ARC-012

- Status: accepted (spec updated)
- Date: 2026-10-08

## Context

ARC-012 says Biome's `noRestrictedImports` "or an equivalent dependency-cruiser check run in CI" enforces the package dependency rules. Biome's rule only restricts specifiers by deny-pattern per file glob, so expressing "package X may import only A, B and C" means generating a long deny list per package, and it cannot check `package.json` dependencies or relative imports that cross a package boundary. dependency-cruiser would add a heavy dependency for the same job.

## Decision

`tools/check-deps.ts` (run by `pnpm lint` after `biome check`) is the ARC-012 enforcement. It is a small script with a table of allowed internal dependencies per package (`RULES`). Workspaces come from `pnpm-workspace.yaml`; the check fails closed (exit 2 when there is no workspace file, no workspace, a missing `--root` value or a missing root; exit 1 for violations). It checks:

1. Internal entries in every workspace `package.json` (`dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`), by key **and by value**: `workspace:`, `link:`, `file:` and `portal:` paths that resolve to a workspace, `npm:@git-migrator/x` and `workspace:@git-migrator/x` aliases. `bundledDependencies`/`bundleDependencies` too.
2. TypeScript project `references` of each package against the same rules.
3. Imports in every source file (including `.tsx`), found by **parsing** it with `oxc-parser` (`tools/ast.ts`; pinned exactly, see ADR-0002; TypeScript 7 has no JavaScript API). Covered: `import`/`export … from`, `import x = require()`, `import('x')` types, dynamic `import()` including template literals, `require`, `require.resolve`, `createRequire(…)('…')` and variables assigned from `createRequire`, `import.meta.resolve`, `import.meta.glob` (string or array), `vi.mock`-style calls, `new URL('…', import.meta.url)` and `/// <reference>`. A string counts only in such a module position, so `export const X = '@git-migrator/db'` and `path.resolve('../..')` are not imports. Comments and strings are never mistaken for code. A syntax error is a violation (fail closed). A relative path through `node_modules/@git-migrator/…` is treated as the package. A computed specifier is an error ("cannot be verified"): `import(x)`, `require(x)`, a `createRequire` alias called with a non-literal (aliases are tracked from declarations and plain assignments), or a template whose static prefix is empty or under the internal scope. `import('node:fs')` and `import(`./locales/${l}.json`)` are fine.
4. Relative imports that leave the package directory.
5. Structure: every `package.json` under `apps`, `packages` and `testing` is matched by `pnpm-workspace.yaml`, and every workspace is a reference of the root `tsconfig.json`.

`*.spec.*` files in packages and apps are a violation, because nothing runs or type-checks them.

Build output directories (`dist`, `coverage`, `out`, `build`, `.next`, `.turbo`, `.vercel`, `storybook-static`, `playwright-report`, `test-results`; one list shared with spec-coverage in `tools/test-globs.ts`) are skipped only directly under a workspace root; `node_modules` is skipped everywhere.

`apps/*` and `testing/*` may depend on anything. Packages under `packages/adapters/` share one rule, so no provider name appears in the rules (GLO-002). `registry` is the only non-app package allowed to depend on adapters, and nothing may depend on an adapter or on `facets` except `registry`, apps and testing packages.

**Test support (orchestrator decision).** Any package may list `@git-migrator/provider-fakes` and `@git-migrator/fixtures` in `devDependencies` and import them **only from `*.test.*` files** (`*.spec.*` counts only under `testing/`, for Playwright; see ADR-0030). Directory names such as `test/` do not make a file a test file (otherwise a helper under `src/test/` could be re-exported from `src/index.ts`). Non-test code that imports a test file (`./y.test`) is a violation, and package `tsconfig.json` files exclude test files from the build graph; tests are type-checked by `tsconfig.tests.json` (see ADR-0030). They may not appear in `dependencies`. Other `testing/*` packages (`integration`, `e2e`) are not available to packages.

Where ARC-012 is silent, the table allows the minimal set that the package's description in ARC-010 implies: `git` may use `core` and `canonical` besides `adapter-sdk`; `quota` may use `core`; `db` may use `core` and `canonical` (typed JSON, enums); `auth`, `api`, `jobs`, `guidance` and `registry` may use the infrastructure packages they obviously build on. A later task that needs another edge changes the table in the same PR and records an ADR.

Further hardening: every `tsconfig*.json` is read (JSONC syntax allowed; a parse failure is a violation) and a project reference may name a file; absolute and `file:` specifiers are rejected; containment is decided on real paths, symlinks are never followed and a symlink that leaves its workspace is a violation; a file that does not parse is a violation, not a silent skip.

**Known limits.** The check does not evaluate string concatenation (`'@git-migrator/' + name`) or follow a variable passed to `import(x)`/`require(x)` (so `const n = '@git-migrator/db'; import(n)` is not caught), nor a `require` function copied to another variable (`const r2 = r`), or `(0, require)('…')`. `.js` files containing JSX do not parse as plain JavaScript and are reported as unparseable; name such files `.jsx`. Other tooling (package manager overrides, `pnpm.overrides`, catalogs, bundler aliases) is not inspected. The check guards against accidental and lazy violations, not against a deliberately obfuscated one.

The check is proved by `tools/check-deps.test.ts`, which builds violating fixture workspaces for each case above and asserts both the API result and the CLI exit code.

## Alternatives

- Biome `noRestrictedImports` overrides generated per package: possible, but verbose, and silent on `package.json` and relative cross-package imports.
- dependency-cruiser: capable, but a large extra dependency and configuration for a ten-line rule table.

## Affected requirements

ARC-012, ARC-010, GLO-002.
