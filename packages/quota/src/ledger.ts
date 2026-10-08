import {
  backgroundLimit,
  DEFAULT_TUNING,
  effectiveLimit,
  parseBucketKey,
  poolCeiling,
  type QuotaPool,
  type QuotaTuning,
} from './bucket.ts';
import { databaseNow, inTransaction, lockKeys, type PgClient, type PgPool } from './db.ts';

/** The metric sink the service writes to. `MetricRecorders` from `packages/observability` satisfies it. */
export interface QuotaMetricsSink {
  setQuotaUsed(bucket: string, pool: QuotaPool, value: number): void;
  setQuotaLimit(bucket: string, value: number): void;
}

export interface QuotaServiceOptions {
  readonly pool: PgPool;
  /** `quota.safetyFactor` and `quota.backgroundShare`. Defaults 0.95 and 0.9. */
  readonly tuning?: QuotaTuning;
  readonly metrics?: QuotaMetricsSink;
  /**
   * TEST SEAM ONLY. By default every window and event stamp comes from the database clock, read
   * after the advisory lock is held (ADR-0180). Tests pass this to control time. Production never does.
   */
  readonly now?: () => Date;
}

/** One bucket a request is charged to. */
export interface BucketSpec {
  /** `<endpointId>:<accountKey>:<resourceGroup>` from `bucketKey()`. */
  readonly key: string;
  /** The configured limit per window (JOB-043 config); provider feedback may lower or raise it while live. */
  readonly limit: number;
  readonly windowSeconds: number;
  /** Ledger units the request costs. Default 1 (git commands cost more, JOB-041). */
  readonly units?: number;
}

export interface BucketGrant {
  readonly key: string;
  readonly used: number;
  readonly ceiling: number;
}

export type AcquireResult =
  | {
      readonly granted: true;
      /**
       * The database time stamped on the events. Adapters pass it back as
       * `QuotaFeedback.observedSince` when the response of this request carries a report.
       */
      readonly at: Date;
      readonly buckets: readonly BucketGrant[];
    }
  | {
      readonly granted: false;
      /** `blocked`: `blockedUntil` is in the future. `pool`: background share used up or clamped. `limit`: window full. */
      readonly reason: 'blocked' | 'pool' | 'limit';
      readonly bucketKey: string;
      /** When to try again. A job calls `moveToDelayed(retryAt)` and does not sleep (JOB-044). */
      readonly retryAt: Date;
    };

/**
 * Provider feedback for one bucket, already parsed by the adapter into neutral terms. Parsing the
 * provider's headers is the adapter's job (GLO-002); the service only applies the numbers.
 * Reported use is a floor: it can make the service more conservative, never less (ADR-0180).
 */
export interface QuotaFeedback {
  readonly bucketKey: string;
  readonly limit: number;
  readonly windowSeconds: number;
  /** Requests the provider says are left in its window. */
  readonly remaining?: number;
  /** When the provider's window resets. Defaults to now + windowSeconds. */
  readonly resetAt?: Date;
  /**
   * When the request whose response carried this report was acquired. Events at or after it are
   * added to the reported use, so requests in flight at report time are not forgotten. Adapters
   * MUST pass it. Defaults to now, which can under-count requests in flight.
   */
  readonly observedSince?: Date;
  /** The provider's window is fixed, not rolling: after `resetAt` only newer events count. */
  readonly fixedWindow?: boolean;
  /** The provider says 20% or less is left: the background pool is 0 until the window advances (JOB-043). */
  readonly nearLimit?: boolean;
}

export interface BucketSnapshot {
  readonly bucketKey: string;
  readonly limit: number;
  readonly effectiveLimit: number;
  readonly backgroundLimit: number;
  readonly windowSeconds: number;
  readonly used: number;
  readonly usedBackground: number;
  readonly usedInteractive: number;
  /** Provider-reported remaining, when known and live. */
  readonly remaining: number | null;
  readonly resetAt: Date | null;
  readonly blockedUntil: Date | null;
  /** True while a near-limit signal clamps the background pool to 0. */
  readonly nearLimit: boolean;
  readonly backgroundClampedUntil: Date | null;
  /** Calls per second available to background work at full use of its share. */
  readonly backgroundRatePerSecond: number;
}

type StateRow = {
  bucket_key: string;
  limit_per_window: number;
  window_seconds: number;
  remaining: number | null;
  reset_at: Date | null;
  blocked_until: Date | null;
  updated_at: Date;
};

interface Evaluation {
  readonly limit: number;
  readonly windowSeconds: number;
  /** The provider's reset time is still in the future. */
  readonly live: boolean;
  readonly reportedLive: boolean;
  readonly resetAt: Date | null;
  readonly blockedUntil: Date | null;
  readonly clampedUntil: Date | null;
  readonly remaining: number | null;
  readonly used: number;
  readonly usedBackground: number;
  readonly usedInteractive: number;
  /** Events at or after this instant are what `used` counts, for retry timing. */
  readonly countFrom: Date;
}

type MergedSpec = BucketSpec & { units: number };

const SECONDARY_SUFFIX = '#secondary-hits';
/** Companion row of a bucket: fixed-window flag (limit_per_window), observedSince (reset_at), clamp expiry (blocked_until). */
const FEEDBACK_SUFFIX = '#feedback';
/** How far past one window a reported `resetAt` may lie before it is clamped. */
export const RESET_SLACK_SECONDS = 60;
export const SECONDARY_BASE_SECONDS = 60;
export const SECONDARY_CAP_SECONDS = 15 * 60;
/** Longest Retry-After honored for a 429. */
export const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

const addSeconds = (date: Date, seconds: number): Date => new Date(date.getTime() + seconds * 1000);
const laterOf = (a: Date, b: Date): Date => (a > b ? a : b);

function assertWhole(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) throw new Error(`Invalid ${name}: ${value}`);
}

function assertKey(key: string): void {
  if (parseBucketKey(key) === undefined) {
    throw new Error(`Invalid bucket key: ${key}`);
  }
}

function assertSpec(spec: BucketSpec): number {
  assertKey(spec.key);
  const units = spec.units ?? 1;
  assertWhole(`units for ${spec.key}`, units, 1);
  assertWhole(`limit for ${spec.key}`, spec.limit, 0);
  assertWhole(`windowSeconds for ${spec.key}`, spec.windowSeconds, 1);
  return units;
}

function assertDate(name: string, value: Date | undefined): void {
  if (value !== undefined && !Number.isFinite(value.getTime())) {
    throw new Error(`Invalid ${name}`);
  }
}

/** Validates a Retry-After in seconds: finite and not negative, clamped to `max`. */
function retryAfter(name: string, value: number, max: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${name}: ${value}`);
  return Math.min(value, max);
}

const STATE_COLUMNS =
  'bucket_key, limit_per_window, window_seconds, remaining, reset_at, blocked_until, updated_at';

/**
 * The sliding-window ledger and per-bucket state (JOB-041, JOB-043 to JOB-045, JOB-047).
 * Every method that decides or changes a bucket does so in a transaction holding the bucket's
 * advisory lock and reads the clock after the lock is held, so any number of pods and workers
 * share one consistent count.
 */
export class QuotaService {
  readonly #pool: PgPool;
  readonly #tuning: QuotaTuning;
  readonly #metrics: QuotaMetricsSink | undefined;
  readonly #clock: (() => Date) | undefined;

  constructor(options: QuotaServiceOptions) {
    this.#pool = options.pool;
    this.#tuning = options.tuning ?? DEFAULT_TUNING;
    this.#metrics = options.metrics;
    this.#clock = options.now;
  }

  get tuning(): QuotaTuning {
    return this.#tuning;
  }

  /**
   * Acquires every bucket in `buckets` in one transaction, or none (JOB-041). A request counted in
   * two resource groups lists both. On success one `QuotaEvent` per unit is recorded for each
   * bucket, so a request that later gets a 429 still counts (JOB-044).
   */
  async acquire(buckets: readonly BucketSpec[], pool: QuotaPool): Promise<AcquireResult> {
    if (buckets.length === 0) throw new Error('acquire needs at least one bucket');
    const merged = new Map<string, MergedSpec>();
    for (const spec of buckets) {
      const units = assertSpec(spec);
      const existing = merged.get(spec.key);
      merged.set(spec.key, { ...spec, units: (existing?.units ?? 0) + units });
    }
    const specs = [...merged.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
    const outcome = await inTransaction(this.#pool, async (client) => {
      await lockKeys(
        client,
        specs.map((spec) => spec.key),
      );
      const now = await databaseNow(client, this.#clock);
      const evaluations: { spec: MergedSpec; ev: Evaluation }[] = [];
      for (const spec of specs) {
        const state = await this.#loadState(client, spec.key);
        const ev = await this.#evaluate(client, spec, state, now);
        await this.#syncState(client, spec, state, ev, now);
        evaluations.push({ spec, ev });
      }
      const denied = await this.#firstDenial(client, evaluations, pool, now);
      if (!denied) {
        for (const { spec } of evaluations) {
          await client.query(
            `INSERT INTO app.quota_event (bucket_key, pool, at)
             SELECT $1, $2, $3 FROM generate_series(1, $4::int)`,
            [spec.key, pool, now, spec.units],
          );
        }
      }
      return { denied, evaluations, at: now };
    });
    for (const { spec, ev } of outcome.evaluations) {
      this.#publish(spec.key, ev, pool, outcome.denied ? 0 : spec.units);
    }
    if (outcome.denied) return { granted: false, ...outcome.denied };
    return {
      granted: true,
      at: outcome.at,
      buckets: outcome.evaluations.map(({ spec, ev }) => ({
        key: spec.key,
        used: ev.used + spec.units,
        ceiling: this.#ceiling(ev, pool),
      })),
    };
  }

  /**
   * Free capacity of a bucket for `pool` without taking anything (JOB-042): the ceiling minus use.
   * Negative when over. `blockedUntil` is set while the bucket is blocked.
   */
  async freeCapacity(
    spec: BucketSpec,
    pool: QuotaPool,
  ): Promise<{ free: number; blockedUntil: Date | null }> {
    assertSpec(spec);
    const client = await this.#pool.connect();
    try {
      const now = await databaseNow(client, this.#clock);
      const state = await this.#loadState(client, spec.key);
      const ev = await this.#evaluate(client, spec, state, now);
      const blocked = ev.blockedUntil && ev.blockedUntil > now ? ev.blockedUntil : null;
      return { free: this.#ceiling(ev, pool) - ev.used, blockedUntil: blocked };
    } finally {
      client.release();
    }
  }

  /**
   * Applies provider feedback (JOB-043, JOB-045). Reported use is a floor under the local sliding
   * count, never a replacement for it. `nearLimit` clamps only the background pool, until the
   * window advances, and never touches the interactive count. A report whose `resetAt` is older
   * than the stored one is ignored.
   */
  async recordFeedback(feedback: QuotaFeedback): Promise<void> {
    assertKey(feedback.bucketKey);
    assertWhole('limit', feedback.limit, 1);
    assertWhole('windowSeconds', feedback.windowSeconds, 1);
    if (feedback.remaining !== undefined) assertWhole('remaining', feedback.remaining, 0);
    assertDate('resetAt', feedback.resetAt);
    assertDate('observedSince', feedback.observedSince);
    await inTransaction(this.#pool, async (client) => {
      await lockKeys(client, [feedback.bucketKey]);
      const now = await databaseNow(client, this.#clock);
      const state = await this.#loadState(client, feedback.bucketKey);
      const companion = await this.#loadState(client, `${feedback.bucketKey}${FEEDBACK_SUFFIX}`);
      // A far-future reset would lock the bucket for good: clamp it to one window plus slack.
      const latestReset = addSeconds(now, feedback.windowSeconds + RESET_SLACK_SECONDS);
      let resetAt = feedback.resetAt ?? addSeconds(now, feedback.windowSeconds);
      if (resetAt > latestReset) resetAt = latestReset;
      if (state?.reset_at && resetAt < state.reset_at) return;
      let remaining = feedback.remaining ?? null;
      // A future observation point would hide every earlier event from the floor: at most now.
      let observedSince = feedback.observedSince ?? now;
      if (observedSince > now) observedSince = now;
      const sameWindow = state?.reset_at?.getTime() === resetAt.getTime();
      // A report without `remaining` must not erase a live floor: keep it for that window.
      const storedLive = state?.reset_at != null && state.reset_at > now && state.remaining != null;
      if (
        remaining === null &&
        storedLive &&
        state?.reset_at &&
        (feedback.resetAt === undefined || sameWindow)
      ) {
        remaining = state.remaining;
        resetAt = state.reset_at;
        observedSince = companion?.reset_at ?? observedSince;
      }
      // Responses can arrive out of order: within one window keep the smallest remaining, with the
      // observation point of the report that supplied it.
      if (remaining !== null && sameWindow && state?.remaining != null) {
        if (state.remaining < remaining) {
          remaining = state.remaining;
          observedSince = companion?.reset_at ?? observedSince;
        }
      }
      await client.query(
        `INSERT INTO app.quota_state
           (bucket_key, limit_per_window, window_seconds, remaining, reset_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (bucket_key) DO UPDATE SET
           limit_per_window = EXCLUDED.limit_per_window,
           window_seconds = EXCLUDED.window_seconds,
           remaining = EXCLUDED.remaining,
           reset_at = EXCLUDED.reset_at,
           updated_at = EXCLUDED.updated_at`,
        [feedback.bucketKey, feedback.limit, feedback.windowSeconds, remaining, resetAt, now],
      );
      const clampUntil = feedback.nearLimit
        ? laterOf(resetAt, companion?.blocked_until ?? resetAt)
        : (companion?.blocked_until ?? null);
      await client.query(
        `INSERT INTO app.quota_state
           (bucket_key, limit_per_window, window_seconds, reset_at, blocked_until, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (bucket_key) DO UPDATE SET
           limit_per_window = EXCLUDED.limit_per_window,
           reset_at = EXCLUDED.reset_at,
           blocked_until = EXCLUDED.blocked_until,
           updated_at = EXCLUDED.updated_at`,
        [
          `${feedback.bucketKey}${FEEDBACK_SUFFIX}`,
          feedback.fixedWindow ? 1 : 0,
          feedback.windowSeconds,
          observedSince,
          clampUntil,
          now,
        ],
      );
    });
  }

  /**
   * Handles a 429 (JOB-044): blocks the bucket until `Retry-After` (at most 24 h) when given, else
   * until the oldest event in the window leaves it (at least `minBlockSeconds`, 60 for Bitbucket).
   * A block is never shortened. Returns `blockedUntil`.
   */
  async recordRateLimited(input: {
    readonly bucketKey: string;
    readonly limit: number;
    readonly windowSeconds: number;
    readonly retryAfterSeconds?: number;
    readonly minBlockSeconds?: number;
  }): Promise<Date> {
    assertKey(input.bucketKey);
    assertWhole('limit', input.limit, 0);
    assertWhole('windowSeconds', input.windowSeconds, 1);
    const explicit =
      input.retryAfterSeconds === undefined
        ? undefined
        : retryAfter('retryAfterSeconds', input.retryAfterSeconds, MAX_RETRY_AFTER_SECONDS);
    const minBlock =
      input.minBlockSeconds === undefined
        ? 0
        : retryAfter('minBlockSeconds', input.minBlockSeconds, MAX_RETRY_AFTER_SECONDS);
    return inTransaction(this.#pool, async (client) => {
      await lockKeys(client, [input.bucketKey]);
      const now = await databaseNow(client, this.#clock);
      let until: Date;
      if (explicit !== undefined) {
        until = addSeconds(now, explicit);
      } else {
        const oldest = await client.query<{ at: Date | null }>(
          'SELECT min(at) AS at FROM app.quota_event WHERE bucket_key = $1 AND at >= $2',
          [input.bucketKey, addSeconds(now, -input.windowSeconds)],
        );
        until = addSeconds(oldest.rows[0]?.at ?? now, input.windowSeconds);
        const floor = addSeconds(now, minBlock);
        if (until < floor) until = floor;
      }
      return this.#block(client, input.bucketKey, input.limit, input.windowSeconds, until, now);
    });
  }

  /**
   * Handles a secondary-limit hit (JOB-045): waits `retry-after` (at most 15 minutes), or 60 s
   * doubled per consecutive hit, capped at 15 minutes. Hits that arrive while a block is already
   * active keep that block and do not raise the counter, so simultaneous responses count once.
   * A hit is consecutive when it lands within 15 minutes of the end of the previous block.
   * Returns `blockedUntil`.
   */
  async recordSecondaryLimit(input: {
    readonly bucketKey: string;
    readonly limit: number;
    readonly windowSeconds: number;
    readonly retryAfterSeconds?: number;
  }): Promise<Date> {
    assertKey(input.bucketKey);
    assertWhole('limit', input.limit, 0);
    assertWhole('windowSeconds', input.windowSeconds, 1);
    const explicit =
      input.retryAfterSeconds === undefined
        ? undefined
        : retryAfter('retryAfterSeconds', input.retryAfterSeconds, SECONDARY_CAP_SECONDS);
    const counterKey = `${input.bucketKey}${SECONDARY_SUFFIX}`;
    return inTransaction(this.#pool, async (client) => {
      await lockKeys(client, [input.bucketKey]);
      const now = await databaseNow(client, this.#clock);
      const state = await this.#loadState(client, input.bucketKey);
      if (state?.blocked_until && state.blocked_until > now) {
        const wanted = explicit === undefined ? state.blocked_until : addSeconds(now, explicit);
        return this.#block(client, input.bucketKey, input.limit, input.windowSeconds, wanted, now);
      }
      const counter = await this.#loadState(client, counterKey);
      const consecutive =
        counter?.reset_at && counter.reset_at > now ? counter.limit_per_window : 0;
      const wait =
        explicit ?? Math.min(SECONDARY_BASE_SECONDS * 2 ** consecutive, SECONDARY_CAP_SECONDS);
      const until = addSeconds(now, wait);
      // The counter row keeps the hit count in limit_per_window and its expiry in reset_at.
      await client.query(
        `INSERT INTO app.quota_state
           (bucket_key, limit_per_window, window_seconds, reset_at, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (bucket_key) DO UPDATE SET
           limit_per_window = EXCLUDED.limit_per_window,
           reset_at = EXCLUDED.reset_at,
           updated_at = EXCLUDED.updated_at`,
        [
          counterKey,
          consecutive + 1,
          SECONDARY_CAP_SECONDS,
          addSeconds(until, SECONDARY_CAP_SECONDS),
          now,
        ],
      );
      return this.#block(client, input.bucketKey, input.limit, input.windowSeconds, until, now);
    });
  }

  /**
   * Reconciles an estimate with the real cost (JOB-045, GraphQL): a positive `delta` records more
   * units, a negative one removes the most recent units of that pool.
   */
  async adjust(bucketKey: string, pool: QuotaPool, delta: number): Promise<void> {
    assertKey(bucketKey);
    if (!Number.isInteger(delta) || delta === 0) return;
    await inTransaction(this.#pool, async (client) => {
      await lockKeys(client, [bucketKey]);
      if (delta > 0) {
        const now = await databaseNow(client, this.#clock);
        await client.query(
          `INSERT INTO app.quota_event (bucket_key, pool, at)
           SELECT $1, $2, $3 FROM generate_series(1, $4::int)`,
          [bucketKey, pool, now, delta],
        );
      } else {
        await client.query(
          `DELETE FROM app.quota_event WHERE id IN (
             SELECT id FROM app.quota_event WHERE bucket_key = $1 AND pool = $2
             ORDER BY at DESC, id DESC LIMIT $3)`,
          [bucketKey, pool, -delta],
        );
      }
    });
  }

  /** Per-bucket view for `GET /api/v1/quota` and the gauges (JOB-047). Internal rows are omitted. */
  async snapshot(): Promise<BucketSnapshot[]> {
    const client = await this.#pool.connect();
    try {
      const now = await databaseNow(client, this.#clock);
      const states = await client.query<StateRow>(
        `SELECT ${STATE_COLUMNS} FROM app.quota_state WHERE bucket_key NOT LIKE '%#%' ORDER BY bucket_key`,
      );
      const out: BucketSnapshot[] = [];
      for (const state of states.rows) {
        const spec = {
          key: state.bucket_key,
          limit: state.limit_per_window,
          windowSeconds: state.window_seconds,
        };
        const ev = await this.#evaluate(client, spec, state, now);
        const bg = backgroundLimit(ev.limit, this.#tuning);
        out.push({
          bucketKey: state.bucket_key,
          limit: ev.limit,
          effectiveLimit: effectiveLimit(ev.limit, this.#tuning.safetyFactor),
          backgroundLimit: bg,
          windowSeconds: ev.windowSeconds,
          used: ev.used,
          usedBackground: ev.usedBackground,
          usedInteractive: ev.usedInteractive,
          remaining: ev.reportedLive ? ev.remaining : null,
          resetAt: ev.resetAt,
          blockedUntil: ev.blockedUntil && ev.blockedUntil > now ? ev.blockedUntil : null,
          nearLimit: ev.clampedUntil !== null,
          backgroundClampedUntil: ev.clampedUntil,
          backgroundRatePerSecond: bg / ev.windowSeconds,
        });
      }
      return out;
    } finally {
      client.release();
    }
  }

  /** Writes the quota gauges from a fresh snapshot (JOB-047). Returns the snapshot. */
  async exportMetrics(): Promise<BucketSnapshot[]> {
    const snapshot = await this.snapshot();
    for (const bucket of snapshot) {
      this.#metrics?.setQuotaLimit(bucket.bucketKey, bucket.limit);
      this.#metrics?.setQuotaUsed(bucket.bucketKey, 'background', bucket.usedBackground);
      this.#metrics?.setQuotaUsed(bucket.bucketKey, 'interactive', bucket.usedInteractive);
    }
    return snapshot;
  }

  /**
   * Prunes (JOB-046): deletes `QuotaEvent` rows older than 2 x the longest window and expired
   * `quota_lease` rows. Called by `maintenance.prune` every 10 minutes.
   */
  async prune(): Promise<{ events: number; leases: number }> {
    const client = await this.#pool.connect();
    try {
      const now = await databaseNow(client, this.#clock);
      const longest = await client.query<{ longest: number | null }>(
        "SELECT max(window_seconds) AS longest FROM app.quota_state WHERE bucket_key NOT LIKE '%#%'",
      );
      const seconds = longest.rows[0]?.longest ?? 3600;
      const events = await client.query('DELETE FROM app.quota_event WHERE at < $1', [
        addSeconds(now, -2 * seconds),
      ]);
      const leases = await client.query('DELETE FROM app.quota_lease WHERE expires_at <= $1', [
        now,
      ]);
      return { events: events.rowCount ?? 0, leases: leases.rowCount ?? 0 };
    } finally {
      client.release();
    }
  }

  /** The ceiling for `pool`: 0 for background while a near-limit clamp is active. */
  #ceiling(ev: Evaluation, pool: QuotaPool): number {
    if (pool === 'background' && ev.clampedUntil) return 0;
    return poolCeiling(ev.limit, pool, this.#tuning);
  }

  async #firstDenial(
    client: PgClient,
    evaluations: readonly { spec: MergedSpec; ev: Evaluation }[],
    pool: QuotaPool,
    now: Date,
  ): Promise<
    { reason: 'blocked' | 'pool' | 'limit'; bucketKey: string; retryAt: Date } | undefined
  > {
    for (const { spec, ev } of evaluations) {
      if (ev.blockedUntil && ev.blockedUntil > now) {
        return { reason: 'blocked', bucketKey: spec.key, retryAt: ev.blockedUntil };
      }
      if (pool === 'background' && ev.clampedUntil) {
        return { reason: 'pool', bucketKey: spec.key, retryAt: ev.clampedUntil };
      }
      const ceiling = this.#ceiling(ev, pool);
      if (ev.used + spec.units > ceiling) {
        const full = ev.used + spec.units > effectiveLimit(ev.limit, this.#tuning.safetyFactor);
        return {
          reason: full ? 'limit' : 'pool',
          bucketKey: spec.key,
          retryAt: await this.#retryAt(client, spec, ev, ceiling, now),
        };
      }
    }
    return undefined;
  }

  async #block(
    client: PgClient,
    key: string,
    limit: number,
    windowSeconds: number,
    until: Date,
    now: Date,
  ): Promise<Date> {
    const result = await client.query<{ blocked_until: Date }>(
      `INSERT INTO app.quota_state
         (bucket_key, limit_per_window, window_seconds, blocked_until, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (bucket_key) DO UPDATE SET
         blocked_until = GREATEST(app.quota_state.blocked_until, EXCLUDED.blocked_until)
       RETURNING blocked_until`,
      [key, limit, windowSeconds, until, now],
    );
    return result.rows[0]?.blocked_until ?? until;
  }

  async #loadState(client: PgClient, key: string): Promise<StateRow | undefined> {
    const result = await client.query<StateRow>(
      `SELECT ${STATE_COLUMNS} FROM app.quota_state WHERE bucket_key = $1`,
      [key],
    );
    return result.rows[0];
  }

  /**
   * Keeps the state row present (it lists known buckets) and the configured limit authoritative
   * whenever no provider window is live: the limit is written back and a stale `remaining` is
   * cleared, so config changes take effect and reported use cannot linger.
   */
  async #syncState(
    client: PgClient,
    spec: BucketSpec,
    state: StateRow | undefined,
    ev: Evaluation,
    now: Date,
  ): Promise<void> {
    if (!state) {
      await client.query(
        `INSERT INTO app.quota_state (bucket_key, limit_per_window, window_seconds, updated_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT (bucket_key) DO NOTHING`,
        [spec.key, spec.limit, spec.windowSeconds, now],
      );
    } else if (
      !ev.live &&
      (state.remaining !== null ||
        state.limit_per_window !== spec.limit ||
        state.window_seconds !== spec.windowSeconds)
    ) {
      await client.query(
        `UPDATE app.quota_state SET limit_per_window = $2, window_seconds = $3, remaining = NULL
         WHERE bucket_key = $1`,
        [spec.key, spec.limit, spec.windowSeconds],
      );
    }
  }

  /**
   * Counts use. The local sliding count always applies. While a provider report is live, use is
   * at least `limit - remaining` plus events at or after the observation point (a floor, so
   * feedback can only make the service more conservative). For a declared fixed window whose
   * reset has passed, only events since the reset count.
   */
  async #evaluate(
    client: PgClient,
    spec: Pick<BucketSpec, 'key' | 'limit' | 'windowSeconds'>,
    state: StateRow | undefined,
    now: Date,
  ): Promise<Evaluation> {
    const companion = await this.#loadState(client, `${spec.key}${FEEDBACK_SUFFIX}`);
    const live = state?.reset_at != null && state.reset_at > now;
    const reportedLive = live && state?.remaining != null;
    const limit = live && state ? state.limit_per_window : spec.limit;
    const windowSeconds = live && state ? state.window_seconds : spec.windowSeconds;
    const windowStart = addSeconds(now, -windowSeconds);
    const fixedExpired =
      companion?.limit_per_window === 1 && state?.reset_at != null && state.reset_at <= now;
    const countFrom =
      fixedExpired && state?.reset_at ? laterOf(windowStart, state.reset_at) : windowStart;
    const observed = laterOf(windowStart, companion?.reset_at ?? state?.updated_at ?? windowStart);
    const counts = await client.query<{ bg: string; ia: string; from_n: string; obs_n: string }>(
      `SELECT count(*) FILTER (WHERE pool = 'background' AND at >= $3) AS bg,
              count(*) FILTER (WHERE pool = 'interactive' AND at >= $3) AS ia,
              count(*) FILTER (WHERE at >= $3) AS from_n,
              count(*) FILTER (WHERE at >= $4) AS obs_n
       FROM app.quota_event WHERE bucket_key = $1 AND at >= $2`,
      [spec.key, windowStart, countFrom, observed],
    );
    const row = counts.rows[0];
    const bg = Number(row?.bg ?? 0);
    const ia = Number(row?.ia ?? 0);
    let used = fixedExpired ? Number(row?.from_n ?? 0) : bg + ia;
    if (reportedLive && state) {
      const base = Math.max(0, limit - (state.remaining ?? 0));
      used = Math.max(used, base + Number(row?.obs_n ?? 0));
    }
    const clamp = companion?.blocked_until ?? null;
    return {
      limit,
      windowSeconds,
      live,
      reportedLive,
      resetAt: state?.reset_at ?? null,
      blockedUntil: state?.blocked_until ?? null,
      clampedUntil: clamp && clamp > now ? clamp : null,
      remaining: state?.remaining ?? null,
      used,
      usedBackground: bg,
      usedInteractive: ia,
      countFrom,
    };
  }

  /** When enough of the window has passed for the request to fit (JOB-044). */
  async #retryAt(
    client: PgClient,
    spec: MergedSpec,
    ev: Evaluation,
    ceiling: number,
    now: Date,
  ): Promise<Date> {
    if (ev.reportedLive && ev.resetAt) return ev.resetAt;
    const fallback = addSeconds(now, ev.windowSeconds);
    if (spec.units > ceiling) return fallback;
    const needed = ev.used + spec.units - ceiling;
    const row = await client.query<{ at: Date }>(
      `SELECT at FROM app.quota_event WHERE bucket_key = $1 AND at >= $2
       ORDER BY at ASC, id ASC OFFSET $3 LIMIT 1`,
      [spec.key, ev.countFrom, needed - 1],
    );
    const at = row.rows[0]?.at;
    return at ? addSeconds(at, ev.windowSeconds) : fallback;
  }

  #publish(key: string, ev: Evaluation, pool: QuotaPool, granted: number): void {
    if (!this.#metrics) return;
    this.#metrics.setQuotaLimit(key, ev.limit);
    this.#metrics.setQuotaUsed(
      key,
      'background',
      ev.usedBackground + (pool === 'background' ? granted : 0),
    );
    this.#metrics.setQuotaUsed(
      key,
      'interactive',
      ev.usedInteractive + (pool === 'interactive' ? granted : 0),
    );
  }
}
