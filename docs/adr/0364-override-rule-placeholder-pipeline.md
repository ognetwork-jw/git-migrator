# ADR-0364: An override NamingRule stores an empty placeholder pipeline

- Status: agent-decided
- Date: 2026-10-09
- Task: T-091
- Affects: LIF-030, DOM-003, UI-030

## Context

LIF-030 allows a repository-scope rule to be a literal `override` instead of a pipeline. The `NamingRule` model in `packages/db/schema.zmodel` has `pipeline Json` as a required column, and `override String?` as an optional one. The API body (`NamingRuleBodySchema`) requires exactly one of `pipeline` and `override`. An RPC create of an override rule without a pipeline value fails at the database.

## Decision

An override rule stores `pipeline = { steps: [], template: "" }` next to its `override` value. The planner reads the override first (LIF-030 precedence), so the placeholder never runs. The editor writes it on create and update, and switching a rule from an override back to a pipeline sets `override` to null. The placeholder is one constant in `apps/web/src/config/naming-draft.ts`.

## Alternatives

- Make `pipeline` nullable in the model: a schema change and a migration to DOM-003, beyond a UI task. Rejected here; a follow-up can make it nullable if the human wants the column to be honest.
- Store the override inside the pipeline JSON: it would change the planner input and the LIF-030 precedence code. Rejected.
