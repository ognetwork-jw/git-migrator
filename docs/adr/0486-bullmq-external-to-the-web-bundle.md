# ADR-0486: The queue library is external to the web bundle

- Status: agent-decided
- Date: 2026-10-09
- Task: T-087
- Affects: DEP-001, API-001, JOB-001

## Context

The first e2e run against the standalone web build answered every endpoint that enqueues a job (inventory refresh, analyze, Run) with 503 `not_ready`, and the quota page with an error. The cause was in the logs of the web process: `ENOENT ... bullmq/dist/esm/postgres/commands/get_counts.sql`. The queue library keeps its SQL commands as `.sql` files next to its modules and reads them at run time. The bundler inlined the library's modules and left the files behind, so the standalone image could not enqueue anything. Integration tests call the API in process, so nothing caught it.

## Decision

`apps/web/next.config.ts` lists the queue library in `serverExternalPackages`. The standalone trace then copies the package with its `.sql` files, and the server loads it from `node_modules`. The e2e tier (ADR-0485) is the test: it enqueues through the built app.

## Alternatives

- `outputFileTracingIncludes` for the `.sql` files: the bundled code looks for them under a virtual path, so copying them would not help.
- Ship a hand-written copy of the commands: duplicates library internals.

## Consequences

The runtime image (DEP-001) contains the library in its traced `node_modules`. The image build (T-090) needs no change, because it copies the standalone folder.
