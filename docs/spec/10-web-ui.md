# 10 — Web UI

## Principles (UI-001)

- **Styling split.** Tailwind CSS owns page layout: shell, grids, spacing and responsive structure. Open-source Ant Design provides interactive components: Table, Form, Modal, Drawer, Tabs, Tag, Badge, Steps, Descriptions, Statistic, Progress, Select, Upload, notification. Ant Design Pro is not used.
- **CSS ordering.** Ant Design styles are wrapped in `@ant-design/cssinjs` `StyleProvider` with `layer` enabled, and Tailwind's layer order is configured so Tailwind utilities win over antd base styles. The App Router SSR style registry pattern from antd docs is required.
- **No inline literals.** All strings go through next-intl (`messages/en.json`). Dates use the user's locale and time zone, through `Intl` formatting.
- **Accessibility.** Semantic landmarks (`header`, `nav`, `main`), every interactive element keyboard-reachable, visible focus, color never the only status signal (status tags carry text and an icon), `aria-live="polite"` for run progress. Target WCAG 2.2 AA where cheap, without formal certification (Q46).
- **Light and dark themes** come from antd `theme.algorithm` and Tailwind `dark:` variants, following the OS preference.
- **Live data.** Every list and detail view stays live through the SSE invalidation described in JOB-060. The shell owns the page's only event stream. A view adds the topics it shows, and the shell merges them into that one connection: a topic change settles for 100 ms before the stream reopens, and views refetch at most once per 300 ms. A page or a row never opens its own stream (ADR-0350).
- **Destructive actions** (rollback, target deletion, force-adopt, undo source read-only) use a Modal that requires typing the exact target full name.

## Shell (UI-010)

- A left sidebar on desktop collapses to a drawer below 1024 px.
- Sidebar sections:
  - **Migration:** Dashboard, Repositories, Waves, Endpoints.
  - **People:** Identity mapping, Team mapping, Invitations.
  - **Configuration:** Naming rules, Webhook allowlist, Overlays, Capability matrix.
  - **Admin:** Actors and API keys, Audit log.
- The header shows the signed-in Actor, their role and a sign-out button.
- Items the Actor's role can't use are hidden. Their routes still enforce permissions server-side. "Can use" means the capability the page exists for (AUTH-020), not read access: Migration items and the Capability matrix need `read` (every role); Identity mapping and Team mapping need the mapping-decision capability, Invitations the invitation capability (operator and admin); Naming rules, Webhook allowlist and Overlays need the rules capability, and Actors and API keys the Actor capability (admin); Audit log is for every role. Empty sections are hidden. A page outside the sidebar needs `read`. Opening a page without its capability redirects to `/denied?required=<role>` (ADR-0300). The server component of every gated page checks this before it renders. It resolves the Actor the way the API does, and redirects to `/signin?next=` when nobody is signed in. The capability is the one the sidebar item names. The client-side redirect is only the quick path (ADR-0321).

## Pages (UI-020 … UI-036)

| ID | Route | Content |
|---|---|---|
| UI-020 | `/` Dashboard | Per Route: Statistic cards per status and readiness. Progress of each Wave. Quota gauges per bucket with background ETA (JOB-047). Recent Runs (last 20). Endpoint migration status. "Refresh inventory" button (operator). Reads `GET /dashboard` and `GET /quota`. Status and readiness cards link to the pre-filtered list (`/repositories?route=&status=&readiness=`) (ADR-0332, ADR-0350). |
| UI-021 | `/repositories` | Server-paginated antd Table, 50 per page, with server-side sort and filters. **Filters:** Route; source namespace (project); status (default: unmigrated); readiness; size class; wave; blocker code; has open tasks; text search on name and path. **Columns:** source path, planned target name, status tag, readiness tag with counts (blockers, pre, post), Facet badge strip, size, wave, last analyzed, last run. Row selection persists across pages. **Bulk bar:** Analyze, Migrate ready, Assign to wave, Remove from wave. **Row actions:** Migrate (only when `ready`), Run anyway (`needs_attention`), Analyze. The list reads the Model API with numbered pages (`skip`/`take` and a `count`), and the order always ends with `id`. Text search is case-insensitive `contains`. "Unmigrated" follows LIF-001. A Facet badge has one entry per Facet in the latest Plan, colored by its worst finding, or "no findings". The selection is a set of ids kept across page, sort and filter changes and cleared when the Route changes. Up to 100 selected ids, it reports how many are hidden by the filters. The bulk bar is shown to operators. It sends ids only, is disabled above 200, and the server re-validates every id. Migrate and Run anyway are hidden while `running` or `source_missing`. Each opens a confirmation; Run anyway names the open pre tasks it skips, read live. A 409 or 422 shows its own text and refreshes the list (ADR-0350, ADR-0406, ADR-0415). |
| UI-022 | `/repositories/[migrationId]` | **Header:** source and target links, status, readiness, actions (Migrate / Run anyway / Resync / Verify / Rollback / Apply or undo source read-only / Mark complete or revoke / Analyze), wave selector. **Facet strip:** one badge per Facet, colored by worst finding, with hover text giving the reason, and click to jump to the Facet tab. **Tabs:** *Overview* (findings grouped by blocker, pre task, post task, warning, each with guidance); *Facets* (per Facet: source, desired and target side-by-side JSON tree diff, field fidelity markers, and Expected Differences with revoke buttons); *Tasks* (checklist with done, reopen and dismiss, notes, and guidance rendered with copyable values); *Runs* (history); *Audit*. |
| UI-023 | `/runs/[runId]` | antd Steps timeline of RunSteps with status and duration, a live log viewer (virtualized, level filter, follows the tail), Mutations made, and a Cancel button while running. |
| UI-024 | `/waves`, `/waves/[id]` | CRUD. The detail page shows a status breakdown and a repository table pre-filtered to the wave. CRUD goes through the Model API. Progress and the breakdown read `GET /dashboard`. The embedded list opens on the Route of one of the Wave's repositories, with status `all` (ADR-0407). |
| UI-025 | `/endpoints` | Configured Endpoints and Routes (read-only), last inventory time and counts, and per Route a link to the endpoint migration. Reads the Model API (ADR-0435). |
| UI-026 | `/endpoints/routes/[routeId]/migration` | Endpoint migration: findings, Facet diffs and Runs, in the same layout as UI-022. Reads the Model API, `GET /dashboard` and `GET /migrations/{id}/diff`. Actions are Analyze and a Run: `migrate` when `ready`, `run_anyway` when it needs attention. Both pages need `read`, and the actions need the run capability (ADR-0435). |
| UI-027 | `/people/identities` | Table of source Identities with mapping status and method, suggested target, and actions (confirm, change target, exclude with reason, unmap). Filters by status. CSV import Drawer with dry-run results per row. Reads the `/api/v1` mapping endpoints and refetches after its own changes and on window focus. Report cells are shown neutralized (AUTH-050, ADR-0320). |
| UI-028 | `/people/teams` | Group → team mappings: planned slug (editable), status, member counts, collisions. |
| UI-029 | `/people/invitations`, `/people/invitations/[batchId]` | Batch list. Batch detail: seat preview, item table with select and deselect (reason prompt on deselect), approve button with a confirmation showing the final count, and per-item send status after approval. Approval sends the token of the confirmed selection. `unknown` entries offer resolve, and `sent` entries offer revoke and suggestions. An entry without a provider id is marked, and its revoke dialog warns that a miss releases the person (ADR-0370). |
| UI-030 | `/config/naming` | Pipeline editor for the Route default, namespace overrides and repository overrides. Preview table (changed names, collisions) via the naming preview endpoint before saving. The Route default comes from configuration (LIF-030), so the page shows it read-only; the editor edits only NamingRule rows (ADR-0361). Save stays disabled until a preview of the exact body exists, and any edit makes that preview stale. Collisions need an explicit checkbox, which resets on each preview. A failed preview blocks the save. Deleting a rule is confirmed but not previewed (ADR-0363). |
| UI-031 | `/config/webhook-allowlist` | CRUD with a pattern tester (enter a URL, see matches). The tester runs the FAC-WEB-002 matcher in the browser, debounced, and sends and stores nothing. Patterns must be http(s) URLs with no spaces, no `**` in the host, no backslash or control character, and at most 2,048 characters (ADR-0366). |
| UI-032 | `/config/overlays` | Per Route and Facet JSON editor, validated against the Facet's partial schema. It writes through `/api/v1/overlays` and runs the same check locally; the server's path errors are shown in the editor (ADR-0362). |
| UI-033 | `/config/capabilities` | Matrix: Facet rows, fidelity per field for each Route's source → target, plus the policies that accept lossy fields. Columns are the ordered adapter pairs, and fidelity is shown as text and color with read and write flags. A field table lists the non-exact fields of one chosen pair. The policies are each Route's `acceptLossy` keys. The page says that the matrix is a static ceiling (ADR-0367). |
| UI-034 | `/admin/actors` | Actors list (human and service). Service Actor creation. API keys: create (shown once, copy button), revoke. Disable Actor. Enabling a disabled Actor is offered too, while an admin's own account cannot be disabled and roles are not changed here. The issued key lives only in the dialog's component state, never in a query or mutation cache, Context, URL or storage, and leaves when the dialog closes (ADR-0365, ADR-0369). |
| UI-035 | `/admin/audit` | Filterable audit table (Actor, action, subject, date range). The date range covers whole local days. Events are ordered by `at`, then `id`, both descending, 50 per page, and paged by cursor. The stored diff is shown as written (ADR-0368). |
| UI-036 | `/signin`, `/denied` | Entra sign-in button, plus the test sign-in form when it's enabled. `/denied` explains the role requirement. |

## Guidance rendering (UI-040)

Guidance content (`packages/guidance`) is structured data:

```ts
type Guidance = {
  code: string;
  title: string;          // i18n key
  summary: string;        // i18n key, may interpolate params
  steps: { text: string; copy?: string; link?: string }[];   // text is an i18n key; copy is a template over params (not translated)
  verification?: string;  // i18n key: how parity verifies it, if verifiable
};
```

- English guidance messages live in `packages/guidance/src/messages/en.json` (flat dotted keys such as `finding.<code>.title`). The web app mounts them under its guidance namespace with `nestCatalog` and renders with `renderGuidance(code, params, { lookup: nextIntlLookup(t) })`, which uses next-intl's `t.raw` so ICU syntax does not interfere; missing keys fall back to English (ADR-0093).
- Templates use `{name}` or `{name:context}` placeholders with typed parameters and three contexts: `markdown` (escaped, autolinks neutralised), `shell` (POSIX single-quoted; values starting with `-` refused) and `raw` (URL parameters only). Invalid or missing parameters render as a `‹name›` marker and drop the step's `copy`; rendering never throws (ADR-0092).
- Severity is `blocker`, `pre`, `post` or `warning`, with a separate verifiable flag. The catalog carries no unverified external links (ADR-0094).
- `packages/guidance/src/codes.ts` is the single list of finding codes, including the LIF-031 lifecycle blockers; a test cross-checks it against `05-facets.md` and the LIF-031 bullets (ADR-0090, ADR-0091).

The UI renders it with copy-to-clipboard buttons for `copy` values. Every code emitted by any Facet MUST have guidance; a unit test enforces this (FAC-002).
