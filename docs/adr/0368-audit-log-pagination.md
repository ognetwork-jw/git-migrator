# ADR-0368: Audit log paging and date bounds

- Status: accepted (spec updated)
- Date: 2026-10-09
- Task: T-091
- Affects: UI-035, AUTH-022, UI-001

## Context

UI-035: a filterable audit table (Actor, action, subject, date range). AuditEvent is append-only and read by every role (AUTH-020). The RPC answers `findMany` with `take`, `skip` and `cursor`. No list endpoint exists for it (ADR-0360).

## Decision

- Filters: Actor (`actorId`), action (`contains`), subject type (equal), and a date range. The range is two date inputs. The start is the beginning of the first day and the end is the last millisecond of the last day, both in the viewer's local time, sent as ISO instants (`auditBounds`).
- Order: `at` descending, then `id` descending, so events with one timestamp keep a stable order.
- Paging: 50 per page. The next page takes the last id as `cursor` with `skip: 1`. A page shorter than 50 ends the list.
- Dates on screen use `formatDateTime` (UI-001).
- The `data` column shows the stored diff as JSON. AUTH-022 redacts it when written, so the page does not redact again.

## Alternatives

- Offset paging: unstable while events arrive. Rejected.
- A date picker library: a new dependency for two inputs. Rejected; native date inputs are enough.
