# Progress

The orchestrator maintains this table (see [workflow](workflow.md)). Integration branch: `ai-main` (ADR-0045); the human merges it into `main`. Status values: `todo`, `in_progress`, `in_review`, `merged`, `split`.

| Task | Status | Branch | PR | Review rounds | Notes |
|---|---|---|---|---|---|
| T-001 | merged | task/T-001-bootstrap | [#1](https://github.com/ognetwork-jw/git-migrator/pull/1) | 5 | merged to ai-main 26d7246; ADR-0028..0030 folded into spec |
| T-002 | merged | task/T-002-dev-environment | [#9](https://github.com/ognetwork-jw/git-migrator/pull/9) | 5 | merged to ai-main 822c914 at the review cap (open findings in followups.md); ADR-0066..0068 folded into DEV-020, 0065/0069 accepted |
| T-003 | merged | task/T-003-agent-tooling-ci | [#4](https://github.com/ognetwork-jw/git-migrator/pull/4) | 5 | 5-round cap; merged to ai-main d46ecc4; open findings in docs/followups.md; ADR-0046..0049 accepted |
| T-004 | merged | task/T-004-config-observability | [#7](https://github.com/ognetwork-jw/git-migrator/pull/7) | 5 | merged to ai-main e8054ea at the review cap (r5 findings in followups.md); ADR-0050..0054 folded into DEP-040/DEP-050 |
| T-010 | in_review | task/T-010-database | [#20](https://github.com/ognetwork-jw/git-migrator/pull/20) | 3 | r2 fixed (allow-list facade, SIGTERM forwarding; 6b549c1); round-3 review |
| T-011 | merged | task/T-011-core-primitives | [#6](https://github.com/ognetwork-jw/git-migrator/pull/6) | 2 | merged to ai-main 1c654ab; ADR-0058 folded into LIF-002; 0055-0057, 0059 accepted |
| T-012 | merged | task/T-012-facet-engine | [#10](https://github.com/ognetwork-jw/git-migrator/pull/10) | 2 | merged to ai-main 6182a5a; ADR-0080..0082 accepted |
| T-013 | merged | task/T-013-naming | [#13](https://github.com/ognetwork-jw/git-migrator/pull/13) | 4 | merged 1df40cb; ADR-0095 folded into spec 06 |
| T-014 | merged | task/T-014-guidance | [#14](https://github.com/ognetwork-jw/git-migrator/pull/14) | 4 | merged to ai-main a8ec5fa; ADR-0090..0094 folded into UI-040 and 05-facets; AGENTS.md messages rule amended |
| T-015 | merged | task/T-015-canonical-schemas | [#11](https://github.com/ognetwork-jw/git-migrator/pull/11) | 3 | merged to ai-main 9965a55; ADR-0085..0088 folded into spec |
| T-020 | todo |  | | | |
| T-021 | todo |  | | | |
| T-022 | todo |  | | | |
| T-025 | todo |  | | | |
| T-026 | todo |  | | | |
| T-027 | todo |  | | | |
| T-028 | todo |  | | | |
| T-030 | merged | task/T-030-bitbucket-api-verification | [#2](https://github.com/ognetwork-jw/git-migrator/pull/2) | 2 | ADR-0035, 0036 folded into spec; r2 adversarial MAJOR downgraded to MINOR (pre-existing text) |
| T-031 | merged | task/T-031-github-api-verification | [#3](https://github.com/ognetwork-jw/git-migrator/pull/3) | 2 | merged to ai-main 033bd88; ADR-0040, 0041 folded into spec |
| T-032 | todo |  | | | |
| T-033 | todo |  | | | |
| T-034 | todo |  | | | |
| T-040 | merged | task/T-040-fake-git-server | [#8](https://github.com/ognetwork-jw/git-migrator/pull/8) | 2 | merged to ai-main 7875b6a; ADR-0070..0072 accepted |
| T-041 | merged | task/T-041-fake-bitbucket | [#5](https://github.com/ognetwork-jw/git-migrator/pull/5) | 2 | merged to ai-main 69844e8; ADR-0060/0061 accepted |
| T-042 | merged | task/T-042-fake-github | [#12](https://github.com/ognetwork-jw/git-migrator/pull/12) | 5 | merged to ai-main ec3f28a; ADR-0075..0077 accepted (fake internals, no spec change) |
| T-043 | merged | task/T-043-fixture-world | [#19](https://github.com/ognetwork-jw/git-migrator/pull/19) | 2 | merged to ai-main 7ae06b1; ADR-0130 accepted (fixture internals) |
| T-050 | merged | task/T-050-facets-git-settings | [#16](https://github.com/ognetwork-jw/git-migrator/pull/16) | 1 | merged to ai-main 3a7d6a2; ADR-0100..0102 folded into 05-facets, 0103 accepted |
| T-051 | merged | task/T-051-facets-access-codeowners | [#15](https://github.com/ognetwork-jw/git-migrator/pull/15) | 4 | merged to ai-main cd05ef3 (implementor escalated to opus at r4, PROC-008); ADR-0105/0106 folded into FAC-006/FAC-COD |
| T-052 | in_review | task/T-052-facets-branch-rules | [#17](https://github.com/ognetwork-jw/git-migrator/pull/17) | 5 | r4 fixed (topological apply order; 95ea925); final round-5 review, merge at cap |
| T-053 | merged | task/T-053-facets-webhooks-deploykeys | [#22](https://github.com/ognetwork-jw/git-migrator/pull/22) | 2 | merged to ai-main c7cc856; ADR-0141 folded into FAC-WEB; 0140/0142 accepted |
| T-054 | merged | task/T-054-facets-env-vars-secrets | [#21](https://github.com/ognetwork-jw/git-migrator/pull/21) | 1 | merged to ai-main d705ec3; ADR-0145 folded into FAC-ENV/FAC-VAR/FAC-SEC |
| T-055 | merged | task/T-055-facets-cr-extras | [#23](https://github.com/ognetwork-jw/git-migrator/pull/23) | 2 | merged to ai-main 8cc5d13; ADR-0155/0156 accepted (param formats, no spec change) |
| T-056 | merged | task/T-056-facets-members-teams-org | [#24](https://github.com/ognetwork-jw/git-migrator/pull/24) | 2 | merged to ai-main c37018c; ADR-0150..0152 folded into 05-facets members/teams/org-* |
| T-057 | in_review | task/T-057-facets-pipelines | [#25](https://github.com/ognetwork-jw/git-migrator/pull/25) | 2 | r1: BLOCKER (manual gate bypass) + MAJORs; fix pass |
| T-058 | todo |  | | | |
| T-060 | todo |  | | | |
| T-061 | todo |  | | | |
| T-062 | todo |  | | | |
| T-070 | todo |  | | | |
| T-071 | todo |  | | | |
| T-072 | todo |  | | | |
| T-073 | todo |  | | | |
| T-074 | todo |  | | | |
| T-075 | todo |  | | | |
| T-080 | todo |  | | | |
| T-081 | todo |  | | | |
| T-082 | todo |  | | | |
| T-083 | todo |  | | | |
| T-084 | todo |  | | | |
| T-085 | todo |  | | | |
| T-086 | todo |  | | | |
| T-087 | todo |  | | | |
| T-088 | todo |  | | | |
| T-089 | todo |  | | | |
| T-090 | todo |  | | | |
| T-091 | todo |  | | | |
| T-093 | in_review | task/T-093-devenv-ci | [#18](https://github.com/ognetwork-jw/git-migrator/pull/18) | 2 | r1 fixed; devenv CI cache + version-pattern fix (4ff633e); awaiting CI, then round-2 review |
| T-095 | todo |  | | | |
| T-096 | todo |  | | | |
| T-097 | todo |  | | | |
