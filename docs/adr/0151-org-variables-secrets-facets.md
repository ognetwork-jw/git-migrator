# ADR-0151: org-variables and org-secrets facet semantics

- Status: agent-decided
- Date: 2026-10-08
- Task: T-056
- Affects: FAC-END (org-variables, org-secrets), FAC-VAR-003, FAC-SEC-001, FAC-005, FAC-002, ADR-0087

## Context

FAC-END says unsecured workspace variables become organization variables with `visibility: all`, secured ones become `org-secrets.set-value` post tasks, "with the same rules as the repository Facets". It does not say how those rules carry over to a facet without scopes, nor which codes and policy keys the org-level facets own (finding codes are `<facet>.<name>`, so the repository codes cannot be reused).

## Decision

- **Names (FAC-VAR-003).** A name is upper-cased, then must match `^[A-Z_][A-Z0-9_]*$` and not start with `GITHUB_`. Items that fail, and every item of a group that collides after upper-casing, are omitted from `desired` and listed in one pre task: `org-variables.name-invalid` or `org-secrets.name-invalid` (params `{ names }`, sorted source names; paths are the source items). No item of a collision is kept: choosing one hides data. Both codes are new and agent-decided (completion `manual`: the user renames in the source and re-analyzes, which dismisses the task).
- **Lossy upper-casing for variables only.** An upper-cased variable name is lossy with the new policy key `org-variables.uppercase-names` (the repository facet's `variables.uppercase-names` belongs to another facet; policy keys must be `<facet>.<name>`), with the engine's `org-variables.accept-lossy` task. For secrets the same rewrite is `translated`, because the target stores secret names in upper case itself (as for repository secrets, ADR-0145).
- **Visibility** is always `all` (the schema fixes it), so no decision is recorded. Values are copied byte for byte.
- **Secrets.** Values are never read, stored or migrated; the canonical schema has no value field, and a source secret that carries one fails schema validation without echoing it. `org-secrets.set-value` (post, completion `parity`) is **one task** for the whole organization (params `{ names }`, sorted target names; there is no scope). The guidance renderer supplies `namespace` for the `gh secret set --org` line. `isTaskSatisfied` holds when every listed name exists on the target, compared case-insensitively. Malformed params are never satisfied.
- **Parity** compares names (and variable values) and ignores what exists only on the target (ADR-0150).
- Decision paths address the desired document (`/variables[name=API_URL]/name`); finding paths for rejected items address the source document.
- The new codes `org-variables.accept-lossy`, `org-variables.name-invalid`, `org-secrets.name-invalid` and the policy key `org-variables.uppercase-names` have guidance / are in `AGENT_DECIDED_CODES` and `AGENT_DECIDED_POLICY_KEYS` in `spec-crosscheck.test.ts`.

## Alternatives

- Make the org-level codes the repository ones (`variables.name-invalid`): the registry requires `<facet>.<name>`.
- Keep the first of colliding names: silent data loss.
- One `set-value` task per secret: noisy for large workspaces; the repository facet also groups by scope.

## Affected requirements

FAC-VAR-003, FAC-SEC-001, FAC-005, FAC-002, FAC-END.
