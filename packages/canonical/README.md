# @git-migrator/canonical

Canonical types, Zod schemas, keyed-collection declarations and schema versions of every built-in
facet (FAC-001, ADP-002, ADP-021). Zod is pinned in `package.json` (ADR-0002). Documents are plain
JSON and schemas are strict: unknown fields are rejected. Parsing never normalizes; sorting is
`normalizeDocument` from core, driven by each facet's `documentSchema`.

Declared internal dependencies (ARC-012, checked by `pnpm lint`): @git-migrator/core.

## Facets

| Key | Scope | Export | Collections (key) / sets |
|---|---|---|---|
| `git-refs` | repository | `gitRefsFacet` | `/refs` (name); sets `/ignoredRefs`, `/lfs/oids` |
| `repository-settings` | repository | `repositorySettingsFacet` | none |
| `merge-settings` | repository | `mergeSettingsFacet` | set `/allowed` |
| `access-control` | repository | `accessControlFacet` | `/grants` (principal) |
| `branch-rules` | repository | `branchRulesFacet` | `/rules` (pattern), `/rules/{restrictPushes,restrictMerges,forcePushExempt,deletionExempt}` (principal) |
| `webhooks` | repository | `webhooksFacet` | `/hooks` (key, ADR-0088); set `/hooks/events` |
| `deploy-keys` | repository | `deployKeysFacet` | `/keys` (publicKey) |
| `variables` | repository | `variablesFacet` | `/variables` (key, ADR-0086) |
| `secrets` | repository | `secretsFacet` | `/secrets` (key, ADR-0086) |
| `environments` | repository | `environmentsFacet` | `/environments` (name); set `/environments/deploymentBranches` |
| `pipelines` | repository | `pipelinesFacet` | `/files` (path); set `/translation/unsupported` |
| `code-ownership` | repository | `codeOwnershipFacet` | `/owners` (pattern), `/owners/principals` (principal) |
| `change-requests` | repository | `changeRequestsFacet` | `/open` (id) |
| `extras` | repository | `extrasFacet` | none |
| `members` | endpoint | `membersFacet` | `/members` (principal) |
| `teams` | endpoint | `teamsFacet` | `/teams` (slug), `/teams/members` (principal) |
| `org-variables` | endpoint | `orgVariablesFacet` | `/variables` (name) |
| `org-secrets` | endpoint | `orgSecretsFacet` | `/secrets` (name) |
| `org-webhooks` | endpoint | `orgWebhooksFacet` | `/hooks` (key, ADR-0088); set `/hooks/events` |

Each facet module exports its TypeScript type (for example `BranchRules`), its Zod schema
(`branchRulesSchema`) and a `CanonicalFacet` declaration: `key`, `scope`, `schemaVersion`, `schema`,
`collections` (`CollectionKeySpec[]` from core), `sets` and `documentSchema` (the argument of
core's `normalizeDocument`). `CANONICAL_FACETS` maps every key to its declaration,
`getCanonicalFacet(key)` looks one up, `parseCanonical(key, value, { version? })` validates the schema and ADP-021 (duplicate or unusable keys fail at parse; a wrong `version` is `reason: 'unsupported_version'`), and
`CanonicalData<K>` is the document type of facet `K`.

```ts
const r = parseCanonical('branch-rules', raw);            // Zod safeParse result
const doc = normalizeDocument(r.data, getCanonicalFacet('branch-rules').documentSchema);
```

Conventions: `null` and `[]` differ (`restrictPushes: null` = unrestricted, `[]` = nobody). Lists of
principals are `{ principal: { kind, id } }[]` (ADR-0085). Webhook URLs, deploy keys and variable names have extra rules (ADR-0088). Secret values are never part of a schema.

## Adding a facet

1. Add the key to `FACET_KEYS` in `src/common.ts`.
2. Write `src/facets/<key>.ts`: the TypeScript type exactly as in `docs/spec/05-facets.md`, the strict
   Zod schema annotated `z.ZodType<Type>`, and `declareFacet({ key, scope, schema, collections, sets })`.
   Every array must be a keyed collection (with a key field of the element) or a set of primitives
   (ADP-021). Record spec gaps in an `agent-decided` ADR.
3. Export it from `src/index.ts` and add it to `CANONICAL_FACETS` in `src/registry.ts`.
4. In `src/canonical.test.ts` add valid and invalid documents (the array-declaration, round-trip and
   core-normalization tests then run for it) and a type-equality line; name requirement IDs in tests.
5. Bump `schemaVersion` (a `declareFacet` parameter) when a change alters the shape of stored documents.

Coverage reports go to `./coverage`; set `VITEST_COVERAGE_DIR` to run two coverage runs in one worktree at the same time.
