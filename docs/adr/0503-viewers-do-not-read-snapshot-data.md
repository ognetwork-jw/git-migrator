# ADR-0503: Viewers do not read Snapshot data or Analysis translations through RPC

- Status: agent-decided
- Date: 2026-10-10
- Task: T-097
- Amends: ADR-0331 (Diff, "Authorization")
- Affects: AUTH-020, AUTH-021, API-012, FAC-WEB-002, LIF-063, LIF-020, UI-040

## Context

FAC-WEB-002 says a webhook's canonical `url` "may carry credentials in path/query: redact before logging or display". The redacted views do that: the diff (`GET /migrations/{id}/diff`, ADR-0331) reduces the URL to `<origin>/…`, ParityResult diffs and the Mutation ledger store it reduced, and RawResponse bodies are denied to viewers (AUTH-020).

The full URL is still stored in two places: `FacetSnapshot.data` (the source and target reads of the `webhooks` and `org-webhooks` Facets) and `Analysis.translation` (the desired target state). Both models are readable by every role through the RPC mount (`/api/model/facetSnapshot`, `/api/model/analysis`), so a viewer could read the credential the diff hides. ADR-0331 justified the diff's `read` authorization with "the diff holds nothing a viewer cannot read through RPC", which made the redaction bypassable.

AUTH-020 grants viewers "Read everything (except API key hashes, raw responses' bodies)". It does not anticipate stored credentials outside raw responses.

## Decision

1. `FacetSnapshot.data` and `Analysis.translation` carry `@deny('read', auth().role == viewer)`, like `RawResponse.body`. A viewer reading these rows through RPC gets every other field, and `null` for these two. A viewer's filter on them matches nothing, so a prefix filter cannot confirm a credential one character at a time (the policy plugin applies the field rule to filters, as it does for `RawResponse.body`). Ordering, grouping or aggregating by these JSON fields is refused or returns no stored value (a policy test checks each); the facade's `READ_DENIED_FIELDS` guard, which exists for fields denied to every role, is not extended.
2. Viewers see Snapshot data and the desired state through the diff, which reads with the server-only client and redacts (ADR-0331). The web UI already reads them only there: no page selects `data` or `translation` through RPC, so no page loses data.
3. Operators and admins keep RPC read access. They hold the run capability, and the worker needs the full URL to recreate a hook, so it stays stored. The privileged client used by jobs and the diff is not affected.
4. **Task and finding parameters.** The webhook recreate guidance needs the full URL for its copy snippet, so the Facet puts it in the finding's parameters (`targetUrl`, with `key` and `targetUrlDisplay`). Such parameters (`SECRET_PARAMS` in `@git-migrator/guidance`, today `targetUrl`) are stored apart: `PlanItem.secretParams` and `ManualTask.secretParams` (new nullable columns) carry `@deny('read', auth().role == viewer)`, and `params` keeps the rest plus the display form. The identity hash (`paramsHash`) is still taken over all parameters, as the Plan builds it; it is a hash of the URL, which the hook key in the field paths already exposes (ADR-0141). The web UI joins `secretParams` into the guidance values when they are readable: a viewer sees the display form and no copy snippet (the renderer omits a snippet whose parameter is missing), and an operator gets the snippet. The migration moves `targetUrl` out of `params` in existing rows and adds their display form. Parity judges a task on `params` and `secretParams` together, so a migrated task row still completes itself. During a rolling upgrade, pods of the previous version may still write `params.targetUrl` after the migration ran. Every write path of the new version therefore first moves such values of its Migration the same way: an Analysis persisting, and a Run adding a task (`moveLegacySecretParams`). Those rows are cleaned on the Migration's next Analysis or Run finding. The exposure is bounded to the upgrade window plus that next write. With this, no stored path gives a viewer an unredacted webhook URL: Snapshots, translations, Plan items, tasks, ParityResults, the ledger and raw responses.
5. ADR-0331's "Authorization" item now reads: `read` (viewer); the diff is the viewer's only view of Snapshot data and translations, and it is redacted.

## Alternatives

- Store the redacted URL in the Snapshot and the translation, and keep the full URL in a sealed column only the worker reads. It keeps AUTH-020's wording literally, but it changes the canonical Facet document, the Snapshot hash (DOM-012 immutability, parity and drift compare hashes), the translator and the apply path, which is a large change at the end of the project for the same protection.
- Deny only the webhook Facets' Snapshots (`facetKey in ['webhooks', 'org-webhooks']`). Narrower, but any other Facet that later stores a credential-bearing value would repeat the defect, and `Analysis.translation` holds every Facet anyway.
- A result hook that redacts webhook URLs in RPC answers. It would have to know every Facet's shape inside the database package (layering, ARC-012), and filters would still see the stored value.

## Affected requirements

AUTH-020 (viewer read access: four more fields are excepted, as raw response bodies are), AUTH-021 / API-012 (field-level read deny), FAC-WEB-002 (no unredacted webhook URL reaches a viewer), LIF-063 (the diff remains the viewer's view).
