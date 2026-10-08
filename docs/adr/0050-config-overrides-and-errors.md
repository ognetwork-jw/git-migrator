# ADR-0050: Configuration environment overrides and error reporting

- Status: accepted (spec updated)
- Date: 2026-10-08
- Affects: ARC-030, DEP-040

## Context

ARC-030 says `GM_…` environment variables override individual keys, and that the `config` package "validates the merged result with Zod at startup and exits with a clear message on failure". It does not say how a key path becomes a variable name, how values are typed, what an empty variable means, what happens to variables that are not configuration, or which exit status is used.

Other `GM_*` variables already exist in the spec and are read elsewhere: `GM_CONFIG_FILE`, `GM_WORKER_ROLE`, `GM_SCRATCH_DIR`, `GM_SECRETSPEC_PROVIDER`, `GM_SECRETSPEC_PROFILE` (read by `entrypoint.sh`, DEP-002), and `GM_TEST_USER_PASSWORD`.

## Decision

1. **Name mapping.** The variable for a key path is `GM_` followed by each segment in SCREAMING_SNAKE_CASE, joined with `_`: `quota.safetyFactor` becomes `GM_QUOTA_SAFETY_FACTOR`. This makes `GM_ENVIRONMENT` and `GM_SECRETSPEC_PROFILE` (the entrypoint's variable) the same key as the file's `environment` and `secretspec.profile`, so one name works in both places.
2. **Derived from the schema.** The overridable keys are every scalar leaf reached through objects. The list is computed from the Zod schema by `envOverrideKeys()`, so it cannot drift. Lists and maps are not overridable: one variable cannot address `endpoints[2].options`.
3. **Typing.** Text the key's schema accepts as it is stays text (URLs, enums, cron, durations). A plain decimal literal (`/^-?\d+(\.\d+)?$/`) becomes a number, so `0x2000` and `1e3` stay text and are rejected. `true`/`false` become booleans. Anything else stays text and fails validation. Coercing before validation makes the report state the rule (`must be greater than 0`) rather than a type error.
4. **Empty and unset are the same.** An empty variable is ignored. Manifests often render `value: ""`, and a blank override should not erase a key.
5. **Unknown `GM_*` variables are ignored**, not rejected, because several other `GM_*` variables are read by other code. A misspelled override therefore has no effect; the report cannot catch it. Documented in the README.
6. **Overrides apply after the file and before validation**, so the schema validates the final value and the report can say which variable caused a problem.
7. **Missing `GM_CONFIG_FILE`** means no file: the configuration is the defaults plus overrides. A set variable naming an unreadable file is an error.
8. **Exit status 78** (`EX_CONFIG` from sysexits.h) for an invalid configuration, written to standard error. Other errors are rethrown, so a bug is not reported as a configuration problem.
9. **Report format.** One line per problem with its dotted path, the variable name when an override set it, and one closing advice line. All problems are reported together, not only the first.

## Alternatives

- Double-underscore separators (`GM_QUOTA__SAFETY_FACTOR`) keep camelCase intact, but the entrypoint already uses single-underscore names such as `GM_SECRETSPEC_PROFILE`, which must map to `secretspec.profile`.
- Rejecting unknown `GM_*` variables would catch typos, but needs a list of every non-configuration variable in the runtime, which would have to be maintained in two places.
- Exit status 1 is simpler, but 78 distinguishes a configuration failure from a crash for the Kubernetes event log.

## Affected requirements

ARC-030, DEP-002 (names read by `entrypoint.sh`), DEP-040.
