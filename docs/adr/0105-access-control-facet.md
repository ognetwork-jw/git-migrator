# ADR-0105: access-control facet decisions

- Status: accepted (spec updated)
- Date: 2026-10-08

## Context

FAC-ACL and FAC-006 define how grants and principals translate but leave open: what the facet does with `excluded` principals, which paths and params its findings use, the role vocabulary of the translation, and how the `(v)` pending-invitation task can be verified when the resolver only says `pending_invite`.

## Decision

- **Grants are copied role-for-role.** The canonical role set (`read|triage|write|maintain|admin`) is the common vocabulary; adapters map into it (FAC-ACL-001/002), so the facet consults no capability for roles. Duplicate principals are merged to the maximum role in `normalize`, which also makes FAC-ACL-001's rule hold for any adapter. Two source principals that map to one target principal also keep the higher role.
- **Principal outcomes (FAC-006).** `mapped` replaces the principal and records a `translated` decision at the source path (only when the principal changed; every decision uses the source path, so a mapped grant cannot collide with an unmapped grant whose source id equals the mapped target id). `excluded` is omitted with no decision and no finding (the `identity_excluded` Expected Difference exists, AUTH-050). `pending_invite`, `unmapped` (the resolver folds `suggested` into it) and `team_missing` omit the grant, record an `unsupported` decision at the source path (so the engine's coverage check passes) and emit `pending-invitation` (post), `unmapped-principal` (pre) or `team-missing` (blocker). `team_missing` for an identity cannot happen and is treated as `unmapped`, so a grant is never dropped silently.
- **Finding paths are source paths** (`/grants[principal=group:devs]`), because the omitted grant has no path in `desired`. Params: `{ principal: 'kind:id', facet }` for the two task codes (the keys the shared guidance messages use; the resolver exposes no display name, so the source `kind:id` is shown), `{ team: <source group id> }` for the blocker.
- **Verifying `pending-invitation`.** `FacetDefinition.isTaskSatisfied` sees only `{code, params}`, the target document and the parity diffs, and the resolver does not say which target principal an invitation will become. The facet therefore treats a task as satisfied when `params.targetPrincipal` (`kind:id`) is present in the target; `translate` cannot set that param today, so the task stays open until a later Analysis no longer emits it (the grant is then in `desired` and a resync applies it). Follow-up: let `PrincipalResolution.pending_invite` carry the provisional target principal.
- `dependsOn` is `['members', 'teams']` as in the facet index; the facet does not read their results (the resolvers carry the mappings).
- **Parity** is the generic structural diff (`diffDocuments`): every grant is compared by principal and role.
- The shared principal helpers (`principalLabel`, `principalPath`, `resolvePrincipal`, `principalIsGranted`) live in `packages/facets/src/access-control/principals.ts` and are reused by code-ownership; other principal facets (branch-rules, teams) may use them.

## Alternatives

- Emit a `translated` decision for every excluded principal: noise, no consumer.
- Always report `pending-invitation` as satisfied once parity is empty: parity is empty while the grant is omitted, so it would complete the task immediately.

## Affected requirements

FAC-ACL-001..004, FAC-006, FAC-002, ADP-021, LIF-061.
