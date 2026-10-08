# ADR-0076: Fake GitHub behavior where the provider doc and OpenAPI description are silent

- Status: agent-decided
- Date: 2026-10-08
- Task: T-042
- Affects: TST-011, FAC-DKY-002, LIF-047, LIF-077, FAC-ACL-002, FAC-VAR-003, FAC-BRR-002

## Context

The provider doc and the saved OpenAPI description give status codes but not the bodies and messages of several failures, and some behaviors are only described in prose. The fake needs a definite answer for each.

## Decision

- **Deploy key reuse** (FAC-DKY-002): `422` `{"message":"Validation Failed","errors":[{"resource":"PublicKey","code":"custom","field":"key","message":"key is already in use"}]}`. Uniqueness is across all repositories of the fake and compares the type and key blob (comment ignored). A malformed key is a 422 with `key is invalid`. This is a reconstruction; the provider doc lists capturing the exact body on staging as a follow-up.
- **Empty repositories** (LIF-047): `POST /git/refs`, `POST /git/blobs|trees|commits` and the Git Data reads answer `409 Git Repository is empty.`; `GET /contents/...` answers `404 This repository is empty.`. "Empty" means no branches.
- **Hidden refs**: `refs/pull/*` cannot be created, updated or deleted through REST (`422 Reference update failed`); creating a pull request writes `refs/pull/N/head` for the git server to advertise. Matching-refs never lists them.
- **Repository delete** (LIF-077): `403 Repository deletion is restricted by organization policy.` when `config.repositoryDeletion` is `forbidden` or the organization has `membersCanDeleteRepositories: false` (applies to Apps; the provider doc leaves that open).
- **Private repository creation**: `403 You are not permitted to create private repositories.` when the organization disallows it (the doc says 403 or 422).
- **Invitations**: the OpenAPI description documents only 404 and 422 for creation, so the 24-hour limit and a missing seat are `422` with a `custom` error message. Re-inviting the same person is `already_exists`, inviting a member is `invitee is already a part of this organization`. Expired invitations disappear from lists and deletes (404).
- **Collaborators** (FAC-ACL-002): a non-member gets an invitation (201), a member or an existing collaborator is `204`. `affiliation=direct` includes outside collaborators. A permission below the organization base role is `422 Cannot assign {login} permission of {role}`; roles are `pull|triage|push|maintain|admin` plus `read`/`write` aliases and `org.customRoles`.
- **Environment protection**: reviewers and wait timers on a private repository of a non-Enterprise organization answer `422` by default (`config.environmentProtection: 'reject'`), so an adapter that sends them fails its tests; `'ignore'` drops them silently. The provider doc says the endpoint accepts them regardless, which would hide the mistake; the request body validation of the real service is not documented.
- **Variables and secrets** (FAC-VAR-003): names are stored upper-case, `GITHUB_*`, leading digits and non-`[A-Za-z0-9_]` characters are `422`; a duplicate variable is `409`. Secret values are never stored; `PUT` only checks `encrypted_value` is base64 and `key_id` matches the fake public key.
- **REST branch protection**: `PUT` requires `required_status_checks`, `enforce_admins`, `required_pull_request_reviews` and `restrictions` (null allowed) and answers the `validation-error-simple` shape; it replaces the whole rule except the GraphQL-only bypass lists.
- **Enforcement** (ADR-0040, ADR-0041), for REST ref writes and for `git push` through the git server's ref-policy seam, on `refs/heads/*` only: a force update needs `allowsForcePushes` or the actor in `bypassForcePushActorIds`; a deletion needs `allowsDeletions`; a creation is refused when `blocksCreations` is set and the actor is not in `pushActorIds`; any update is refused when `restrictsPushes` is set and the actor is not in `pushActorIds`. The actor is the App behind the installation token. A token with Administration: write is a repository admin and bypasses a rule unless the rule has `isAdminEnforced`, as on GitHub; a contract check of ADR-0040 therefore uses a token without Administration, once for a listed and once for an unlisted App. Pull request, status check, signature and linear-history requirements are not enforced on pushes. REST refusals are `422`, pushes are rejected by the pre-receive hook (`Protected branch update failed for {ref}. {reason}.`); `refs/pull/*` pushes are refused as hidden refs.
- **GraphQL**: `first`/`last` is mandatory and at most 100; `requiredApprovingReviewCount` defaults to 1 when `requiresApprovingReviews` is true and is null otherwise; setting `requiredStatusChecks` or contexts turns on `requiresStatusChecks` unless given. Domain failures (`Name already protected: {pattern}`, actors without write access, unknown ids) are `errors[]` entries with `type` `UNPROCESSABLE` or `NOT_FOUND` and HTTP 200.
- **Internal visibility** needs an enterprise plan (`422` otherwise). Environment, webhook (a duplicate `config.url` in a scope is `422 Hook already exists on this repository|organization`) and invitation rules: sent invitations stay in a 24-hour log even when cancelled, a duplicate or an email of an existing member is `422`; only the internal team-membership path merges team ids into a pending invitation.
- **Git access**: the `target` side of the git server accepts installation tokens as Basic passwords (any username); 404 when the token cannot see the repository, 403 below Contents read (fetch) or write (push).
- **Push policy flag**: to keep pushes to repositories without rules fast, the pre-receive hook calls the policy only if `{bare repo}/gm-policy-active` exists *when the hook runs*. The flag is created and removed synchronously by the one helper behind every rule mutation (`createRule`/`deleteRule`: GraphQL, REST protection, state builders) through `repositoryHooks.policyChanged`, so a rule committed before the hook runs, even mid-push, is enforced. The flag is re-derived from `repo.rules` by `syncPolicyFlag` at the end of the `created` and `renamed` hooks (a rule may have been created during them) and by `fake.syncPolicy(repo?)`, which fixtures that create rules before seeding the bare repository (T-043) call after `createBareRepo`/`seedBareRepo`. Pushes to `refs/pull/*` are denied by the hook itself (`deny updating a hidden ref`) whenever the ref policy is configured, protected or not, without spawning node.
- **LFS upload target**: the `upload` action's PUT needs the same installation auth as the batch call (repository restriction, Contents: write), the body must hash to the oid and match the announced size, else 401/403/404/422.
- **LFS batch**: errors use `application/vnd.git-lfs+json`; more than 100 objects is 413; `upload` needs `contents: write`.

## Alternatives

- Accept everything the real API might accept. Rejected: a fake that is more lenient than the provider hides adapter bugs.

## Consequences

When staging captures differ (deploy key body, delete policy for Apps, environment rules on Team) these are one-line changes in the fake; the adapter should depend only on the status code and the `key is already in use` text.
