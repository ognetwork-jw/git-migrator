# Provider API specs

## bitbucket-cloud.openapi.json

- Source: <https://dac-static.atlassian.com/cloud/bitbucket/swagger.v3.json> (Atlassian's published Bitbucket Cloud OpenAPI 3.0 document, linked from <https://developer.atlassian.com/cloud/bitbucket/rest/>).
- Retrieved: 2026-10-08 by task T-030, unmodified (1,374,776 bytes, `info.version` 2.0).
- Used for: verifying `docs/providers/bitbucket-cloud.md` and, later, response validation in the Bitbucket fake (TST-010).
- Known gaps: no `/1.0/` paths, no issue-tracker paths, and some responses (for example `/downloads`) have no schema. See ADR-0036.
