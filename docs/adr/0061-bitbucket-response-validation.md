# ADR-0061: How fake Bitbucket responses are validated against the OpenAPI document

- Status: accepted (no spec change needed)
- Date: 2026-10-08
- Task: T-041
- Affects: TST-010

## Context

TST-010 requires fake responses to be validated against Atlassian's OpenAPI document in the fake's own tests, "except fields the provider doc says are not in the schema". The document is OpenAPI 3.0 with `allOf` and many closed (`additionalProperties: false`) objects.

## Decision

- Use `openapi-response-validator` 12.1.3 (exact pin, devDependency, runs Ajv against each operation's `responses` and the document's `components`). It handles `$ref`, `allOf` and OpenAPI 3.0 keywords without converting the 1.3 MB document.
- `src/bitbucket/spec-validation.ts` exposes `validateAgainstSpec(method, pathTemplate, status, body)`. Two documented exemptions, both from the provider doc: `default_branch_deletion` on branching-model settings (string, absent from the schema) is removed before validation, and a `null` `mainbranch` (empty repository; the schema only allows an object) is dropped.
- Webhook lists follow the closed envelope of their schema (`values`, `pagelen`, `next`); every other list sends `size`, `page`, `pagelen`, `next`, `previous`.
- `/downloads` has no response schema and `/issues` is not in the document, so both are covered by direct assertions, as the provider doc already flags.
- Fields requested with `fields=` produce partial objects that cannot satisfy required schema fields, so those responses are asserted by value, not validated.

- **Dependency pin.** `@hono/node-server` 2.1.4 (ADR-0002 pin) is newer than pnpm's release-age policy allows, so `pnpm-workspace.yaml` has `minimumReleaseAgeExclude: ['@hono/node-server@2.1.4']`. The exclusion is scoped to that exact version, so any other version still goes through the policy. Remove it once 2.1.4 ages past the window.

## Alternatives

- Hand-rolled Ajv with a 3.0 to JSON Schema converter: more code to maintain for the same result.
- Generating the fake from the document: loses the stateful behavior and the provider-doc quirks.
