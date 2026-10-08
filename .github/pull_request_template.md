## Summary

<!-- What changed and why, in a few sentences. -->

Base branch: `ai-main` (ADR-0045). Do not target `main`.

## Task

- Task: T-xxx <!-- from docs/spec/15-work-breakdown.md -->
- Dependencies merged: yes / no

## Requirement-ID checklist

<!-- List every requirement ID of the task. Each must appear in a test name, `it('[ID] ...')`, where it is testable. -->

- [ ] `XXX-000`: implemented, covered by a test named with the ID
- [ ] Tests assert behavior. None are tautological, snapshot-only or over-mocked for logic.
- [ ] `docs/spec/**` is unchanged (PROC-011). Spec gaps are recorded as `agent-decided` ADRs.

## Acceptance checklist

<!-- Copy the task's acceptance criteria from docs/spec/15-work-breakdown.md and tick each one. -->

- [ ] Acceptance criterion 1
- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass locally
- [ ] Coverage thresholds (TST-005) hold for the packages touched
- [ ] Package README and affected docs are updated
- [ ] No secrets, tokens or real customer data are committed
- [ ] Provider vocabulary appears only in adapters, provider docs and guidance text (GLO-002); user-facing strings are in `apps/web/messages/en.json`
- [ ] Every `TODO` has an entry for the orchestrator to add to `docs/followups.md`

## ADRs recorded

<!-- Number, title and the requirement IDs affected, or "none". -->

## Follow-ups and notes for reviewers

<!-- Deferred work, uncertainty, anything a reviewer should look at first. -->
