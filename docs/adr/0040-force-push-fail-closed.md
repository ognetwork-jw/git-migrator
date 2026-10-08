# ADR-0040: Force-push exemptions follow the spec pairing and fail closed on GitHub

- Status: agent-decided
- Date: 2026-10-08
- Task: T-031
- Affects: FAC-BRR-002 (rows `blockForcePush` and non-empty `forcePushExempt`), FAC-BRR-001, TST-011, T-033

## Context

FAC-BRR-002 maps `blockForcePush` to `allowsForcePushes: false` and a non-empty `forcePushExempt` to `bypassForcePushAllowances`, with the availability of the latter left open for T-031. T-031 confirmed the GraphQL field exists (`bypassForcePushActorIds`, User, Team or App IDs).

What the published sources do not settle is the interaction with `allowsForcePushes`:

- The GraphQL schema says `allowsForcePushes` is "Are force pushes allowed on this branch" and `bypassForcePushActorIds` lists actors "allowed to bypass force push".
- The UI documentation offers "Specify who can force push" under "Allow force pushes", which could be read as `allowsForcePushes: true` plus a list. An implementation following that reading risks letting every writer force push (a silent weakening of the target protection).
- The Terraform GitHub provider documents `allows_force_pushes` as "Set it to false if you specify force_push_bypassers" and forces it to false when bypassers are non-empty, ignoring bypassers when it is true.

## Decision

Keep the spec pairing and fail closed.

Write:

| Canonical | GraphQL |
|---|---|
| `blockForcePush: false` | `allowsForcePushes: true`, empty bypass list |
| `blockForcePush: true` | `allowsForcePushes: false`, `bypassForcePushActorIds` = resolved `forcePushExempt` (possibly empty) |

Read: `allowsForcePushes: true` gives `blockForcePush: false` (any bypass list is ignored); `allowsForcePushes: false` gives `blockForcePush: true` with `forcePushExempt` = the bypass actors. Exempt principals that cannot be resolved to a User, Team or App with write access are dropped under the existing lossy key `branch-rules.exemptions-dropped`.

Fidelity stays as in the spec table (translated).

## Uncertainty and required check

It is not proven from documentation that `allowsForcePushes: false` plus a bypass list lets the listed actors force push. The failure mode of this mapping is the safe one (exempt actors cannot force push), so it is acceptable until proven otherwise.

The adapter contract suite or the first staging run MUST verify two things: a non-listed writer's force push is rejected, and a listed bypass actor's force push is accepted. If the second fails, report `branch-rules.exemptions-dropped` for `forcePushExempt`. If the first fails, treat it as a blocker and supersede this ADR. T-042's fake must model `allowsForcePushes` and the bypass list independently.

## Alternatives

- `allowsForcePushes: true` plus a bypass list. Rejected: may open force pushes to all writers.
- Always report `exemptions-dropped`. Rejected: the capability exists in the schema.
