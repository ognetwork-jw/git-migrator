# ADR-0036: Bitbucket facts the published docs cannot settle

- Status: accepted (spec updated)
- Date: 2026-10-08
- Task: T-030
- Affects: AUTH-050, FAC-ACL-001, FAC-BRR-001, FAC-MRG-002, JOB-015, JOB-043, LIF-070

## Context

T-030 may use only published Atlassian documents. `support.atlassian.com` was unreachable. The OpenAPI document and the API reference intro do not settle some items.

## Decision

Mark these **unverified — validate during live e2e** in `docs/providers/bitbucket-cloud.md` and code defensively until validated:

1. Git HTTPS username for API tokens (`x-bitbucket-api-token-auth`): configurable, with this default.
2. `GET /1.0/groups/{ws}`: absent from the published reference. Probe once per workspace and fall back to `permissions-config` group names on 404/410 (the spec's existing fallback, FAC-ACL-001).
3. Wiki clone URL: probe `{repo}.git/wiki`; failure means wiki unreadable.
4. Repository `size` unit and LFS inclusion: JOB-015 uses it either way.
5. `/downloads` `size` presence: absent means count unknown.
6. Issue endpoints: absent from the OpenAPI document; scope `read:issue:bitbucket` assumed.
7. Whether Standard plans enforce `enforce_merge_checks` and `require_commits_behind` (both kinds exist in the API).
8. Whether `default_branch_deletion` on the repository already reflects project inheritance.
9. Whether branch-level `merge_strategies` and `default_merge_strategy` reflect repository- or project-level settings (ADR-0035).
10. Partial-body `PUT /repositories/{ws}/{slug}` semantics: the reference says the endpoint both creates and updates and takes the full repository body, but not that a `description`-only body leaves other fields unchanged. Mitigation: LIF-070 sends only `description`, after a successful `GET` of the same slug in the same step, never `name`. After the `PUT` the adapter `GET`s again and compares `is_private`, `fork_policy`, `project.key`, `name` and `mainbranch` with the pre-`PUT` `GET`; on any difference it restores them and fails the step. The fake mirrors the real API (`PUT` on a missing slug returns 201 and creates), and T-032 must test that the adapter never `PUT`s without a prior successful `GET` in the same step.
11. The rate-limit numbers in the provider doc come from the original provider-doc author's research; `support.atlassian.com` was unreachable. Quota limits must be configurable (JOB-043 config) with the documented values as defaults.

Items verified and different from the plan: no project-level branch restrictions exist; `write:repository:bitbucket` does not suffice for the description update (`admin:repository:bitbucket` is required); project deploy keys need `admin:project:bitbucket`; `GET /pipelines_config` needs `admin:repository:bitbucket`.

## Alternatives

Block T-030 until `support.atlassian.com` is allowed: rejected by the orchestrator.

## Consequences

The live e2e plan must cover the eleven items. The Bitbucket fake (TST-010) should model item 2 as removable.
