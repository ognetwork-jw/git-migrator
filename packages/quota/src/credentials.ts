import type { QuotaPool } from './bucket.ts';
import type { BucketSpec, QuotaService } from './ledger.ts';

/** One credential of an Endpoint and the buckets a job would charge if it used it (JOB-042). */
export interface CredentialCandidate<T> {
  readonly credential: T;
  readonly buckets: readonly BucketSpec[];
}

/**
 * Picks the credential whose buckets have the most free capacity for `pool` (JOB-042). A candidate's
 * capacity is the smallest free capacity among its buckets, because a request is granted only if
 * all of them grant. Credentials that share an account share buckets and so tie. Blocked
 * candidates lose to any unblocked one; when all are blocked the one that unblocks first wins.
 * A candidate with no buckets is a caller bug and throws (it would otherwise look infinitely free).
 * The caller then uses the chosen credential for the whole job.
 */
export async function selectCredential<T>(
  quota: QuotaService,
  candidates: readonly CredentialCandidate<T>[],
  pool: QuotaPool,
): Promise<{ credential: T; free: number } | undefined> {
  let best: { credential: T; free: number; blockedUntil: Date | null } | undefined;
  for (const candidate of candidates) {
    if (candidate.buckets.length === 0) {
      throw new Error('A credential candidate needs at least one bucket');
    }
    let free = Number.POSITIVE_INFINITY;
    let blockedUntil: Date | null = null;
    for (const spec of candidate.buckets) {
      const capacity = await quota.freeCapacity(spec, pool);
      free = Math.min(free, capacity.free);
      if (capacity.blockedUntil && (!blockedUntil || capacity.blockedUntil > blockedUntil)) {
        blockedUntil = capacity.blockedUntil;
      }
    }
    const entry = { credential: candidate.credential, free, blockedUntil };
    if (!best || isBetter(entry, best)) best = entry;
  }
  return best && { credential: best.credential, free: best.free };
}

function isBetter(
  a: { free: number; blockedUntil: Date | null },
  b: { free: number; blockedUntil: Date | null },
): boolean {
  if (a.blockedUntil && b.blockedUntil) return a.blockedUntil < b.blockedUntil;
  if (a.blockedUntil) return false;
  if (b.blockedUntil) return true;
  return a.free > b.free;
}
