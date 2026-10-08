# Progress

The orchestrator maintains this table (see [workflow](workflow.md)). Integration branch: `ai-main` (ADR-0045); the human merges it into `main`. Status values: `todo`, `in_progress`, `in_review`, `merged`, `split`.

| Task | Status | Branch | PR | Review rounds | Notes |
|---|---|---|---|---|---|
| T-001 | merged | task/T-001-bootstrap | [#1](https://github.com/ognetwork-jw/git-migrator/pull/1) | 5 | merged to ai-main 26d7246; ADR-0028..0030 folded into spec |
| T-002 | in_review | task/T-002-dev-environment | [#9](https://github.com/ognetwork-jw/git-migrator/pull/9) | 2 | r1 fixed (ae93884); round-2 review |
| T-003 | in_review | task/T-003-agent-tooling-ci | [#4](https://github.com/ognetwork-jw/git-migrator/pull/4) | 5 | r4: spec ACCEPTABLE; adversarial 1 MAJOR + late r3-spec 2 MAJOR; final fix pass running |
| T-004 | in_review | task/T-004-config-observability | [#7](https://github.com/ognetwork-jw/git-migrator/pull/7) | 5 | r4: 3 BLOCKER (redaction); escalated implementor sonnet→opus (PROC-008); final fix pass running |
| T-010 | todo |  | | | |
| T-011 | merged | task/T-011-core-primitives | [#6](https://github.com/ognetwork-jw/git-migrator/pull/6) | 2 | merged to ai-main 1c654ab; ADR-0058 folded into LIF-002; 0055-0057, 0059 accepted |
| T-012 | merged | task/T-012-facet-engine | [#10](https://github.com/ognetwork-jw/git-migrator/pull/10) | 2 | merged to ai-main 6182a5a; ADR-0080..0082 accepted |
| T-013 | in_review | task/T-013-naming | [#13](https://github.com/ognetwork-jw/git-migrator/pull/13) | 2 | r1: 3 MAJOR (adoption, owned-masks-collision, ReDoS); fix pass queued (implementor cap) |
| T-014 | in_review | task/T-014-guidance | [#14](https://github.com/ognetwork-jw/git-migrator/pull/14) | 2 | r1: 3 MAJOR (next-intl ICU, keygen path from provider data, translation.unsupported); fix pass queued (implementor cap) |
| T-015 | in_review | task/T-015-canonical-schemas | [#11](https://github.com/ognetwork-jw/git-migrator/pull/11) | 3 | r2: 2 MAJOR (webhook URL secrets in key/paths); orchestrator revised decision; fix pass running |
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
| T-042 | in_review | task/T-042-fake-github | [#12](https://github.com/ognetwork-jw/git-migrator/pull/12) | 1 | |
| T-043 | todo |  | | | |
| T-050 | todo |  | | | |
| T-051 | todo |  | | | |
| T-052 | todo |  | | | |
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
