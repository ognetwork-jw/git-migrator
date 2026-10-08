# ADR-0025: Single image, three entrypoints

- Status: accepted
- Date: 2026-10-08

## Context

Web, workers and migrations share code and dependencies (Q91).

## Decision

One `node:24-slim` image with git, git-lfs and secretspec, UID 10001, with entrypoints `web`, `worker` and `migrate`.

## Consequences

The image is larger than a web-only image, which is acceptable.
