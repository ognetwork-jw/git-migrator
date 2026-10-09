# ADR-0361: The Route default naming pipeline is shown, not edited, on the naming page

- Status: agent-decided
- Date: 2026-10-09
- Task: T-091
- Affects: UI-030, LIF-030, API-012

## Context

UI-030 names "the Route default" as one of the three things the pipeline editor edits. LIF-030 says the Route default comes from `routes[].defaults.naming` in configuration and that "there is no database row for it". API-012 lists no write for Route, and no endpoint changes it.

## Decision

The naming page shows the Route default read-only: the template and each step, read from `Route.defaults.naming` through the RPC read (ADR-0360). It says in the text that the default comes from configuration and cannot be edited there. The editor edits only NamingRule rows: namespace and repository scopes, pipeline or literal override.

## Alternatives

- A write endpoint for the Route default: it would change configuration that the config sync overwrites on the next start (LIF-030, config is the source), and it would be a new endpoint the spec does not list.
- Hide the default: the operator then cannot see what the rules fall back to.

## Follow-up

If the human wants the default editable in the UI, that needs a spec change to the configuration source of truth. Not done here.
