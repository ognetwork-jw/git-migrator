# Progress

The orchestrator maintains this table (see [workflow](workflow.md)). Integration branch: `ai-main` (ADR-0045); the human merges it into `main`. Status values: `todo`, `in_progress`, `in_review`, `merged`, `split`.

| Task | Status | Branch | PR | Review rounds | Notes |
|---|---|---|---|---|---|
| T-001 | merged | task/T-001-bootstrap | [#1](https://github.com/ognetwork-jw/git-migrator/pull/1) | 5 | merged to ai-main 26d7246; ADR-0028..0030 folded into spec |
| T-002 | merged | task/T-002-dev-environment | [#9](https://github.com/ognetwork-jw/git-migrator/pull/9) | 5 | merged to ai-main 822c914 at the review cap (open findings in followups.md); ADR-0066..0068 folded into DEV-020, 0065/0069 accepted |
| T-003 | merged | task/T-003-agent-tooling-ci | [#4](https://github.com/ognetwork-jw/git-migrator/pull/4) | 5 | 5-round cap; merged to ai-main d46ecc4; open findings in docs/followups.md; ADR-0046..0049 accepted |
| T-004 | merged | task/T-004-config-observability | [#7](https://github.com/ognetwork-jw/git-migrator/pull/7) | 5 | merged to ai-main e8054ea at the review cap (r5 findings in followups.md); ADR-0050..0054 folded into DEP-040/DEP-050 |
| T-010 | merged | task/T-010-database | [#20](https://github.com/ognetwork-jw/git-migrator/pull/20) | 5 | merged to ai-main 2421d5d at the 5-round cap (r5 arg-walk security MAJORs → followups.md, fix with T-021 at the latest); ADR-0121/0122 folded into 03, 08, 09 |
| T-011 | merged | task/T-011-core-primitives | [#6](https://github.com/ognetwork-jw/git-migrator/pull/6) | 2 | merged to ai-main 1c654ab; ADR-0058 folded into LIF-002; 0055-0057, 0059 accepted |
| T-012 | merged | task/T-012-facet-engine | [#10](https://github.com/ognetwork-jw/git-migrator/pull/10) | 2 | merged to ai-main 6182a5a; ADR-0080..0082 accepted |
| T-013 | merged | task/T-013-naming | [#13](https://github.com/ognetwork-jw/git-migrator/pull/13) | 4 | merged 1df40cb; ADR-0095 folded into spec 06 |
| T-014 | merged | task/T-014-guidance | [#14](https://github.com/ognetwork-jw/git-migrator/pull/14) | 4 | merged to ai-main a8ec5fa; ADR-0090..0094 folded into UI-040 and 05-facets; AGENTS.md messages rule amended |
| T-015 | merged | task/T-015-canonical-schemas | [#11](https://github.com/ognetwork-jw/git-migrator/pull/11) | 3 | merged to ai-main 9965a55; ADR-0085..0088 folded into spec |
| T-020 | merged | task/T-020-auth | [#27](https://github.com/ognetwork-jw/git-migrator/pull/27) | 4 | merged to ai-main (r4 ACCEPTABLE; MINORs → followups.md; implementor escalated to opus at r4); ADR-0170/0171 folded into AUTH-002/004/005 |
| T-021 | merged | task/T-021-api | [#30](https://github.com/ognetwork-jw/git-migrator/pull/30) | 3 | merged to ai-main 54fcab4 (r3 ACCEPTABLE; MINORs → followups.md); ADRs folded (9f10315) |
| T-022 | merged | task/T-022-events | [#36](https://github.com/ognetwork-jw/git-migrator/pull/36) | 2 | merged to ai-main ea6a2cf (r2 ACCEPTABLE; MINORs → followups.md); ADRs folded (9f10315) |
| T-025 | merged | task/T-025-quota | [#26](https://github.com/ognetwork-jw/git-migrator/pull/26) | 3 | merged to ai-main (r3 ACCEPTABLE; MINORs → followups.md); ADR-0180 folded into JOB-041/043/045 |
| T-026 | merged | task/T-026-adapter-sdk | [#28](https://github.com/ognetwork-jw/git-migrator/pull/28) | 3 | merged to ai-main f73e0b9 (r3 ACCEPTABLE; MINORs → followups.md); ADR-0190 folded into ADP-060 |
| T-027 | merged | task/T-027-git | [#33](https://github.com/ognetwork-jw/git-migrator/pull/33) | 3 | merged to ai-main 3f5d612 (r3 ACCEPTABLE; MINORs → followups.md); ADRs folded (9f10315) |
| T-028 | merged | task/T-028-jobs-runtime | [#29](https://github.com/ognetwork-jw/git-migrator/pull/29) | 5 | merged to ai-main f952add (r4 ACCEPTABLE + reviewed devenv SSL CI fix; escalated to opus at r4 per PROC-008); ADRs folded (9f10315) |
| T-030 | merged | task/T-030-bitbucket-api-verification | [#2](https://github.com/ognetwork-jw/git-migrator/pull/2) | 2 | ADR-0035, 0036 folded into spec; r2 adversarial MAJOR downgraded to MINOR (pre-existing text) |
| T-031 | merged | task/T-031-github-api-verification | [#3](https://github.com/ognetwork-jw/git-migrator/pull/3) | 2 | merged to ai-main 033bd88; ADR-0040, 0041 folded into spec |
| T-032 | merged | task/T-032-bitbucket-adapter | [#31](https://github.com/ognetwork-jw/git-migrator/pull/31) | 3 | merged to ai-main (r3 ACCEPTABLE; MINORs → followups.md); ADR-0221/0222 folded into FAC-BRR-001 and LIF-070 |
| T-033 | merged | task/T-033-github-adapter | [#32](https://github.com/ognetwork-jw/git-migrator/pull/32) | 3 | merged to ai-main (r3 ACCEPTABLE; MINORs → followups.md); ADR-0231 folded into ADP-011, LIF-045, LIF-047 |
| T-034 | merged | task/T-034-adapter-contract | [#34](https://github.com/ognetwork-jw/git-migrator/pull/34) | 2 | merged to ai-main c369b9c (r2 ACCEPTABLE; one known GitHub adapter defect marked it.fails → followups.md) |
| T-040 | merged | task/T-040-fake-git-server | [#8](https://github.com/ognetwork-jw/git-migrator/pull/8) | 2 | merged to ai-main 7875b6a; ADR-0070..0072 accepted |
| T-041 | merged | task/T-041-fake-bitbucket | [#5](https://github.com/ognetwork-jw/git-migrator/pull/5) | 2 | merged to ai-main 69844e8; ADR-0060/0061 accepted |
| T-042 | merged | task/T-042-fake-github | [#12](https://github.com/ognetwork-jw/git-migrator/pull/12) | 5 | merged to ai-main ec3f28a; ADR-0075..0077 accepted (fake internals, no spec change) |
| T-043 | merged | task/T-043-fixture-world | [#19](https://github.com/ognetwork-jw/git-migrator/pull/19) | 2 | merged to ai-main 7ae06b1; ADR-0130 accepted (fixture internals) |
| T-050 | merged | task/T-050-facets-git-settings | [#16](https://github.com/ognetwork-jw/git-migrator/pull/16) | 1 | merged to ai-main 3a7d6a2; ADR-0100..0102 folded into 05-facets, 0103 accepted |
| T-051 | merged | task/T-051-facets-access-codeowners | [#15](https://github.com/ognetwork-jw/git-migrator/pull/15) | 4 | merged to ai-main cd05ef3 (implementor escalated to opus at r4, PROC-008); ADR-0105/0106 folded into FAC-006/FAC-COD |
| T-052 | merged | task/T-052-facets-branch-rules | [#17](https://github.com/ognetwork-jw/git-migrator/pull/17) | 5 | merged to ai-main at the 5-round cap (r5 MAJOR test-vacuity + MINOR → followups.md); ADR-0110/0113 folded into FAC-BRR-003 |
| T-053 | merged | task/T-053-facets-webhooks-deploykeys | [#22](https://github.com/ognetwork-jw/git-migrator/pull/22) | 2 | merged to ai-main c7cc856; ADR-0141 folded into FAC-WEB; 0140/0142 accepted |
| T-054 | merged | task/T-054-facets-env-vars-secrets | [#21](https://github.com/ognetwork-jw/git-migrator/pull/21) | 1 | merged to ai-main d705ec3; ADR-0145 folded into FAC-ENV/FAC-VAR/FAC-SEC |
| T-055 | merged | task/T-055-facets-cr-extras | [#23](https://github.com/ognetwork-jw/git-migrator/pull/23) | 2 | merged to ai-main 8cc5d13; ADR-0155/0156 accepted (param formats, no spec change) |
| T-056 | merged | task/T-056-facets-members-teams-org | [#24](https://github.com/ognetwork-jw/git-migrator/pull/24) | 2 | merged to ai-main c37018c; ADR-0150..0152 folded into 05-facets members/teams/org-* |
| T-057 | merged | task/T-057-facets-pipelines | [#25](https://github.com/ognetwork-jw/git-migrator/pull/25) | 4 | merged to ai-main bfbf891 (r4 ACCEPTABLE; MINORs → followups.md); ADR-0160..0162 folded into FAC-PIP-002/003 |
| T-058 | merged | task/T-058-registry | [#35](https://github.com/ognetwork-jw/git-migrator/pull/35) | 2 | merged to ai-main cc59642 (r2 ACCEPTABLE; adapters aligned to 05 tables); ADRs folded (9f10315) |
| T-060 | merged | task/T-060-inventory | [#37](https://github.com/ognetwork-jw/git-migrator/pull/37) | 2 | merged to ai-main cc60a17 (r2 ACCEPTABLE; MINORs → followups.md); ADRs folded (9f10315) |
| T-061 | merged | task/T-061-analysis | [#40](https://github.com/ognetwork-jw/git-migrator/pull/40) | 4 | merged to ai-main 7ff846c (r4 ACCEPTABLE both; MINORs → followups.md); ADR folding pending |
| T-062 | merged | task/T-062-endpoints | [#42](https://github.com/ognetwork-jw/git-migrator/pull/42) | 2 | merged to ai-main 4c3bf46 (r2 ACCEPTABLE both; MINORs → followups.md); ADR folding pending |
| T-070 | merged | task/T-070-run-executor | [#43](https://github.com/ognetwork-jw/git-migrator/pull/43) | 5 | merged to ai-main 614242b at the 5-round cap (r5 ACCEPTABLE both; MINORs → followups.md); ADR folding pending |
| T-071 | merged | task/T-071-migration-steps | [#48](https://github.com/ognetwork-jw/git-migrator/pull/48) | 3 | merged to ai-main 3e3d04e (r3 ACCEPTABLE both; MINORs → followups.md); ADR folding pending |
| T-072 | merged | task/T-072-parity | [#47](https://github.com/ognetwork-jw/git-migrator/pull/47) | 2 | merged to ai-main 8e07540 (r2 ACCEPTABLE both; MINORs → followups.md); ADR folding pending |
| T-073 | merged | task/T-073-source-read-only | [#52](https://github.com/ognetwork-jw/git-migrator/pull/52) | 4 | merged to ai-main 3572bd8 via local gate (ADR-0455); escalated at r3 (PROC-008); r4 ACCEPTABLE both; MINORs → followups.md; ADR-0425 folding pending |
| T-074 | merged | task/T-074-run-endpoints | [#50](https://github.com/ognetwork-jw/git-migrator/pull/50) | 2 | merged to ai-main d1265cd (r2 ACCEPTABLE both; MINORs → followups.md); ADR folding pending |
| T-075 | merged | task/T-075-phase1-integration | [#54](https://github.com/ognetwork-jw/git-migrator/pull/54) | 1 | merged to ai-main b8b2f7d via local gate (ADR-0455); r1 ACCEPTABLE both; MINORs → followups.md; ADR-0475 folding pending |
| T-080 | merged | task/T-080-web-shell | [#39](https://github.com/ognetwork-jw/git-migrator/pull/39) | 2 | merged to ai-main 31b7577 (MINORs → followups.md); ADRs folded (9f10315) |
| T-081 | merged | task/T-081-dashboard | [#44](https://github.com/ognetwork-jw/git-migrator/pull/44) | 3 | merged to ai-main 6435ad0 (r3 ACCEPTABLE both; MINORs → followups.md); ADR folding pending |
| T-082 | merged | task/T-082-detail-pages | [#53](https://github.com/ognetwork-jw/git-migrator/pull/53) | 1 | merged to ai-main 20e51c9 (rebased head passed local gate; fast-forward pushed with user approval after the classifier denied it; task branch not republished, PR closed); MINORs → followups.md; ADR-0445/0446 folding pending |
| T-083 | merged | task/T-083-ui-e2e | [#57](https://github.com/ognetwork-jw/git-migrator/pull/57) | 2 | merged to ai-main 6b7bb7f; adds the CI e2e job (TST-001) and reuses the T-087 harness (ADR-0485/0486); MINORs → followups.md |
| T-084 | merged | task/T-084-identity-mapping | [#41](https://github.com/ognetwork-jw/git-migrator/pull/41) | 3 | merged to ai-main f66c9ae (r3 ACCEPTABLE both; MINORs → followups.md); ADR folding pending |
| T-085 | merged | task/T-085-invitations | [#46](https://github.com/ognetwork-jw/git-migrator/pull/46) | 5 | merged to ai-main 556e67f (r5 ACCEPTABLE both after escalation; MINORs → followups.md); ADR folding pending |
| T-086 | merged | task/T-086-endpoint-migration | [#51](https://github.com/ognetwork-jw/git-migrator/pull/51) | 4 | merged to ai-main 8e6cdb5 via local gate (ADR-0455; GitHub Actions down); r4 ACCEPTABLE both; MINORs → followups.md; ADR folding pending |
| T-087 | merged | task/T-087-needs-attention | [#56](https://github.com/ognetwork-jw/git-migrator/pull/56) | 2 | merged to ai-main a90d746; NeedsAttention e2e spec; found and fixed bullmq bundling in the standalone build (ADR-0486) |
| T-088 | merged | task/T-088-waves-bulk | [#49](https://github.com/ognetwork-jw/git-migrator/pull/49) | 2 | merged to ai-main eb9ed1d (r2 ACCEPTABLE both; MINORs → followups.md); ADR folding pending |
| T-089 | merged | task/T-089-drift-rollback | [#55](https://github.com/ognetwork-jw/git-migrator/pull/55) | 5 | merged to ai-main ce87ebf; escalated at r3 (PROC-008); r5 ACCEPTABLE both; MINORs → followups.md; ADR-0465/0466/0467 folding pending (Round 2-5 sections supersede base text) |
| T-090 | merged | task/T-090-release | [#38](https://github.com/ognetwork-jw/git-migrator/pull/38) | 2 | merged to ai-main 441c0ff (r2 ACCEPTABLE + reviewed erasable-syntax CI fix); ADRs folded (9f10315) |
| T-091 | merged | task/T-091-admin-pages | [#45](https://github.com/ognetwork-jw/git-migrator/pull/45) | 2 | merged to ai-main 1108bc4 (r2 ACCEPTABLE both; MINORs → followups.md); ADR folding pending |
| T-093 | merged | task/T-093-devenv-ci | [#18](https://github.com/ognetwork-jw/git-migrator/pull/18) | 2 | merged to ai-main 8dba617 (r2 ACCEPTABLE; CI green incl. devenv test); ADR-0135/0137 folded into DEV-010/DEV-030 |
| T-095 | in_progress | task/T-095-live-e2e | | | implementor dispatched |
| T-096 | todo |  | | | |
| T-097 | todo |  | | | |

> 2026-10-09 12:53 UTC: GitHub Actions jobs fail instantly with no runner (runner_id 0, no logs) on every PR. Merges use the local gate of ADR-0455 until Actions runs jobs again; re-run CI on the ai-main head then.

> 2026-10-09 ~16:00 UTC: GitHub Actions runs jobs again (repository made public). CI re-run on ai-main a412178 passed all jobs; the ADR-0455 local-gate fallback has ended. Merges again require CI green on the exact head.

> 2026-10-09 ~22:00 UTC: Docker Hub refused the GitHub runners' anonymous image pulls; CI now pulls through mirror.gcr.io with digest pins ([#58](https://github.com/ognetwork-jw/git-migrator/pull/58), ADR-0490, merged to ai-main 4e89034). The user approved fast-forwards of ai-main for reviewed, CI-green heads.
