# 01 — Glossary

Core code, database models, API paths and UI copy MUST use these terms (GLO-001). Provider terms such as "organization", "workspace", "project", "pull request" or "merge request" appear only inside adapter packages, provider docs and guidance text that quotes the provider UI (GLO-002).

| Term | Definition |
|---|---|
| **Provider** | A type of git service, implemented by one adapter package. For example `bitbucket-cloud` or `github`. |
| **Endpoint** | A configured instance of a Provider: base URL, credentials and options. Endpoints are defined at deploy time (ADR-0010). |
| **Route** | A configured source Endpoint → target Endpoint pairing with a target Namespace and policies. Every Migration belongs to one Route. |
| **Namespace** | A container of Repositories. Namespaces can nest. Bitbucket: workspace → project. GitHub: organization. |
| **Repository** | A git repository plus its hosted metadata, identified by its Provider-stable ID. |
| **Facet** | One independently readable, translatable, writable and comparable aspect of a Repository or Endpoint. For example `branch-rules`. |
| **Canonical Model** | The provider-neutral, versioned schema of a Facet's data. |
| **Snapshot** | One stored read of a Facet from one side, in canonical form. |
| **Fidelity** | How faithfully a canonical field survives a source → target translation: `exact`, `translated`, `lossy`, `unsupported`, `unreadable`. |
| **Policy** | A Route-level, pre-made decision. For example, "accept this lossy translation everywhere". |
| **Migration** | The record tracking one source Repository on one Route, or one Endpoint-level migration for a Route. It holds lifecycle status and readiness. |
| **Analysis** | A dated evaluation of a Migration: Snapshots, translation results, readiness and plan. |
| **Plan** | The ordered Steps, Manual Tasks, Blockers and Warnings produced by an Analysis. |
| **Run** | One execution against a Migration: migrate, run-anyway, resync, verify, rollback, or source read-only (apply or undo). |
| **Step** | One idempotent unit of work inside a Run. |
| **Blocker** | A condition that prevents migrate, run-anyway and resync Runs (LIF-005). |
| **Manual Task** | A human action, either `pre` (needed for a faithful result; makes the Migration NeedsAttention) or `post` (only possible after a Run; gates verification but not readiness). |
| **Warning** | Information that never gates anything. For example, a wiki that will not be migrated. |
| **Readiness** | `ready`, `needs_attention` or `blocked`, derived from the latest Analysis, open tasks and run-origin blockers (LIF-004). |
| **Parity Check** | Comparison of the desired target document (translated from the source) with the actual target document, minus Expected Differences (LIF-060). |
| **Expected Difference** | A recorded, justified difference that parity ignores, scoped to a field path. |
| **Mutation** | A recorded change the framework made to either side. It is used for rollback, for undoing source read-only, and for drift exclusion. |
| **Drift** | A parity difference detected after a Migration was verified or manually completed. |
| **Wave** | A named group of Migrations that is tracked and actioned together. |
| **Identity** | An account on a Provider. It is never an Actor. |
| **Group** | A set of Identities on a Provider. Bitbucket group, GitHub team. |
| **Identity Mapping** | The link from a source Identity to a target Identity, or an exclusion. |
| **Invitation Batch** | A reviewed, approved set of target invitations. |
| **Actor** | A principal of git-migrator itself: `human` (linked to a Better Auth user) or `service` (authenticates with API keys). |
| **Role** | The in-app permission level of an Actor: `viewer`, `operator` or `admin`. |
| **Change Request** | A proposed change to a branch: Bitbucket pull request, GitHub pull request. |
| **Overlay** | Target-only configuration applied by the framework on top of translated source configuration. Excluded from parity. |
| **Credential** | A secret allowing API and git access to an Endpoint, loaded from secretspec. |
