# ADR-0506: Illustrative IDs in the overview are not requirements

- Status: agent-decided
- Date: 2026-10-09

## Context

`docs/spec/00-overview.md` (Conventions) uses `LIF-012` as an example of the ID format and of a test name. No spec section defines `LIF-012`. `collectSpecIds` scanned every spec file, so the example became a must-test ID that no honest test can cover, and `--strict` (TST-002, ADR-0029) could never pass. T-097 requires strict to pass.

## Decision

- `tools/spec-coverage.ts` has an explicit `ILLUSTRATIVE_IDS` map from spec file name to IDs that the file mentions only as examples. Those IDs are ignored when read from that file. Today it holds `00-overview.md: LIF-012`.
- The ignore is per file: if another spec file defines the same ID, it is a requirement again.
- `must-test.txt` was regenerated with `pnpm spec:must-test`. No `[LIF-012]` test exists, and none is to be added.
- CI runs `pnpm spec:coverage -- --strict` (ADR-0029, TST-002).

## Alternatives

- Skip the whole Conventions section: needs Markdown section parsing and silently hides future real IDs there.
- Ask the orchestrator to reword the overview example: the spec is read-only for implementors. This remains a valid cleanup; the ignore entry can then be removed.
- Add a fake `[LIF-012]` test: rejected, it proves nothing.

## Affected requirements

TST-002, LIF-012 (illustrative only).
