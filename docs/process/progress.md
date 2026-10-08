# Progress

The orchestrator maintains this table (see [workflow](workflow.md)). Integration branch: `ai-main` (ADR-0045); the human merges it into `main`. Status values: `todo`, `in_progress`, `in_review`, `merged`, `split`.

| Task | Status | Branch | PR | Review rounds | Notes |
|---|---|---|---|---|---|
| T-001 | merged | task/T-001-bootstrap | [#1](https://github.com/ognetwork-jw/git-migrator/pull/1) | 5 | merged to ai-main 26d7246; ADR-0028..0030 folded into spec |
| T-002 | in_review | task/T-002-dev-environment | [#9](https://github.com/ognetwork-jw/git-migrator/pull/9) | 5 | r4 fixed + rebased (df6d10a); final round-5 review |
| T-003 | merged | task/T-003-agent-tooling-ci | [#4](https://github.com/ognetwork-jw/git-migrator/pull/4) | 5 | 5-round cap; merged to ai-main d46ecc4; open findings in docs/followups.md; ADR-0046..0049 accepted |
| T-004 | merged | task/T-004-config-observability | [#7](https://github.com/ognetwork-jw/git-migrator/pull/7) | 5 | merged to ai-main e8054ea at the review cap (r5 findings in followups.md); ADR-0050..0054 folded into DEP-040/DEP-050 |
| T-010 | todo |  | | | |
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
| T-042 | in_review | task/T-042-fake-github | [#12](https://github.com/ognetwork-jw/git-migrator/pull/12) | 5 | r4: 1 MAJOR (policy flag lost before seeding/during create+rename); final fix pass |
| T-043 | todo |  | | | |
| T-050 | in_progress | task/T-050-facets-git-settings | | 0 | implementing (ADR range 0100-0104) |
| T-051 | in_progress | task/T-051-facets-access-codeowners | | 0 | implementing (ADR range 0105-0109) |
| T-052 | in_progress | task/T-052-facets-branch-rules | | 0 | implementing (ADR range 0110-0114) |
| T-053 | todo |  | | | |
| T-054 | todo |  | | | |
| T-055 | todo |  | | | |
| T-056 | todo |  | | | |
| T-057 | todo |  | | | |
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
| T-093 | todo |  | | | |
| T-095 | todo |  | | | |
| T-096 | todo |  | | | |
| T-097 | todo |  | | | |
