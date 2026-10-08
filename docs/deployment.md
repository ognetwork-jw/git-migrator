# Deployment notes

This file collects operational facts the spec asks implementors to record. The chart and image documentation (T-090) extends it.

## Worker database connections (JOB-014)

Each process creates one shared BullMQ `pg.Pool` (ADR-0210) and one application pool. Maximum connections per process:

```
bullmq pool     = workers + 4          (each Worker holds one LISTEN client; 4 serve queries)
application     = postgres.pool.app    (default 10)
leader election = 1                    (standard and all roles only)
total           = bullmq + application + leader
```

| Process | Workers | BullMQ pool | App pool | Leader | Total (defaults) |
|---|---|---|---|---|---|
| `worker --role standard` | 6 | 10 | 10 | 1 | 21 |
| `worker --role large` | 1 | 5 | 10 | 0 | 15 |
| `worker --role all` | 7 | 11 | 10 | 1 | 22 |
| `migrate` | 0 | 0 | 2 | 0 | 2 to 3 at a time |

The BullMQ pool is a cap: measured with the `all` role and 20 jobs processed, it held 4 connections. Size `max_connections` for the sum over all pods plus the web pods' pools.

## Database setup

`migrate` (DATA-030) creates the `app`, `auth` and `bullmq` schemas and `pg_trgm`. On Azure Database for PostgreSQL Flexible Server, add `pg_trgm` to the `azure.extensions` server parameter first.

## Worker health

Workers serve `GET /healthz` and `GET /readyz` on port 8081 from the first moment. `/readyz` is 503 while the worker waits for the database and its `app` and `bullmq` schemas (exponential backoff up to 10 s, 3 minutes in all, then the process exits with one logged error), 200 once the queue Workers run, and 503 again as soon as shutdown begins. `/healthz` stays 200 during the drain, and the health server closes last. In development run `pnpm db:migrate` (devenv does it for you; with Compose use `docker compose exec dev pnpm db:migrate`). On SIGTERM a worker stops taking jobs, lets in-flight jobs finish, then closes its pools; set `terminationGracePeriodSeconds` to 120 (standard) and 600 (large). After start-up the worker has no forced-exit timer of its own: the grace period is the only bound. Only a SIGTERM during start-up exits after at most 30 s (ADR-0213).

## Scratch

`GM_SCRATCH_DIR` (default `/scratch`) holds `<runId>` directories. Every worker pod removes directories older than 24 h at start-up and on `schedules.scratchCleanup`.

## Scheduler leader failover

The leader holds a session advisory lock on a dedicated connection. That session sets `idle_session_timeout` (6 ping intervals, at least 30 s) and short TCP keepalives, and pings every 5 s with a 10 s query timeout. If the leader's node or network disappears without closing the socket, the server drops the session and a follower takes over in about a minute.

## Run leases

A Run's lease token is unique per claim and renewed every 30 s (valid 2 min). A worker that cannot renew for 90 s stops the Run locally. Run queues use `maxStalledCount: 0`, so the reaper is the only resume path. On SIGTERM the executor hands the Run off (`handOffRun`): the lease is released with a 2-minute grace and no resumption is counted. While a Run waits for its resume or hand-off job, the reaper checks that the job still exists: a waiting job is never counted, and a job that died counts toward the 3-resumption bound (ADR-0212).
