/**
 * The identity matching cascade (AUTH-050 step 2) and the Group Mapping flow. Pure: no I/O, so it
 * is unit-tested exhaustively; `inventory.ts` applies the results.
 */

/** The fields of an Identity the cascade looks at. */
export interface MatchIdentity {
  readonly id: string;
  readonly login: string | null;
  readonly displayName: string | null;
  readonly email: string | null;
}

export type MatchMethod = 'email' | 'login' | 'name';

/** What the cascade decides for one source Identity. */
export type MatchOutcome =
  | {
      readonly status: 'confirmed' | 'suggested';
      readonly method: MatchMethod;
      readonly confidence: number;
      readonly targetIdentityId: string;
    }
  | { readonly status: 'unmapped' };

export const LOGIN_CONFIDENCE = 0.9;
export const NAME_CONFIDENCE = 0.7;
/** Exact email equality is as certain as the provider's email data. */
export const EMAIL_CONFIDENCE = 1;

const lower = (value: string | null): string | null => {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
};

/** NFKD, lowercase, alphanumerics only (AUTH-050 step 2.3). `null` when nothing is left. */
export function normalizeDisplayName(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value
    .normalize('NFKD')
    .toLowerCase()
    // NFKD splits accents into combining marks, which are neither letters nor digits and go too.
    .replace(/[^\p{L}\p{N}]/gu, '');
  return normalized === '' ? null : normalized;
}

/** Targets grouped by the keys the cascade looks up, built once per Route. */
export interface TargetIndex {
  readonly byEmail: ReadonlyMap<string, readonly MatchIdentity[]>;
  readonly byLogin: ReadonlyMap<string, readonly MatchIdentity[]>;
  readonly byName: ReadonlyMap<string, readonly MatchIdentity[]>;
  readonly normalize: (value: string | null) => string | null;
}

function push(map: Map<string, MatchIdentity[]>, key: string | null, value: MatchIdentity): void {
  if (key === null) return;
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Indexes the target Identities by email, login and normalized display name, normalizing each
 * target once. A lookup is then O(1), so a Route costs O(sources + targets) instead of their
 * product. `normalize` is injectable so a test can count the work.
 */
export function indexTargets(
  targets: readonly MatchIdentity[],
  normalize: (value: string | null) => string | null = normalizeDisplayName,
): TargetIndex {
  const byEmail = new Map<string, MatchIdentity[]>();
  const byLogin = new Map<string, MatchIdentity[]>();
  const byName = new Map<string, MatchIdentity[]>();
  for (const target of targets) {
    push(byEmail, lower(target.email), target);
    push(byLogin, lower(target.login), target);
    push(byName, normalize(target.displayName), target);
  }
  return { byEmail, byLogin, byName, normalize };
}

const onlyOne = (hits: readonly MatchIdentity[] | undefined): MatchIdentity | undefined =>
  hits?.length === 1 ? hits[0] : undefined;

/**
 * The cascade for one source Identity against the target Identities (AUTH-050 step 2):
 * 1. exact case-insensitive email, `confirmed` when `autoConfirmEmail`, else `suggested`;
 * 2. exact case-insensitive login, `suggested` at 0.9;
 * 3. normalized display name with exactly one candidate, `suggested` at 0.7;
 * 4. otherwise `unmapped`.
 * A step that finds several candidates is ambiguous and falls through to the next one. Pass a
 * `TargetIndex` (from `indexTargets`) when matching many sources against the same targets.
 */
export function matchIdentity(
  source: MatchIdentity,
  targets: readonly MatchIdentity[] | TargetIndex,
  options: { readonly autoConfirmEmail: boolean },
): MatchOutcome {
  const index = Array.isArray(targets) ? indexTargets(targets) : (targets as TargetIndex);
  const email = lower(source.email);
  const byEmail = email === null ? undefined : onlyOne(index.byEmail.get(email));
  if (byEmail) {
    return {
      status: options.autoConfirmEmail ? 'confirmed' : 'suggested',
      method: 'email',
      confidence: EMAIL_CONFIDENCE,
      targetIdentityId: byEmail.id,
    };
  }
  const login = lower(source.login);
  const byLogin = login === null ? undefined : onlyOne(index.byLogin.get(login));
  if (byLogin) {
    return {
      status: 'suggested',
      method: 'login',
      confidence: LOGIN_CONFIDENCE,
      targetIdentityId: byLogin.id,
    };
  }
  const name = index.normalize(source.displayName);
  const byName = name === null ? undefined : onlyOne(index.byName.get(name));
  if (byName) {
    return {
      status: 'suggested',
      method: 'name',
      confidence: NAME_CONFIDENCE,
      targetIdentityId: byName.id,
    };
  }
  return { status: 'unmapped' };
}

/**
 * Many sources can share one email (a person with two accounts). An automatic confirmation must
 * be one-to-one: when several outcomes confirm the same target, or the target is already taken by
 * a decided mapping, they are demoted to `suggested` for an operator to settle.
 */
export function demoteDuplicateConfirmations(
  outcomes: readonly MatchOutcome[],
  takenTargets: ReadonlySet<string> = new Set(),
): MatchOutcome[] {
  const counts = new Map<string, number>();
  for (const o of outcomes) {
    if (o.status === 'confirmed')
      counts.set(o.targetIdentityId, (counts.get(o.targetIdentityId) ?? 0) + 1);
  }
  return outcomes.map((o) =>
    o.status === 'confirmed' &&
    ((counts.get(o.targetIdentityId) ?? 0) > 1 || takenTargets.has(o.targetIdentityId))
      ? { ...o, status: 'suggested' as const }
      : o,
  );
}

/** Statuses the cascade may rewrite. Decisions are never overwritten (AUTH-050 step 2). */
export const REMATCHABLE_STATUSES: ReadonlySet<string> = new Set(['unmapped', 'suggested']);

/** The stored fields of a mapping that the cascade compares to detect a change. */
export interface MappingFields {
  readonly status: string;
  readonly targetIdentityId: string | null;
  readonly method: string | null;
  readonly confidence: number | null;
}

export function outcomeFields(outcome: MatchOutcome): MappingFields {
  return outcome.status === 'unmapped'
    ? { status: 'unmapped', targetIdentityId: null, method: null, confidence: null }
    : {
        status: outcome.status,
        targetIdentityId: outcome.targetIdentityId,
        method: outcome.method,
        confidence: outcome.confidence,
      };
}

export const sameMapping = (a: MappingFields, b: MappingFields): boolean =>
  a.status === b.status &&
  a.targetIdentityId === b.targetIdentityId &&
  a.method === b.method &&
  a.confidence === b.confidence;

/**
 * Group Mapping flow (AUTH-050, last paragraph): a target team with the same slug (compared
 * case-insensitively) is `suggested`; otherwise the team is planned
 * for creation and the mapping stays `unmapped` with its planned slug.
 */
export function matchGroup(
  sourceSlug: string,
  targets: readonly { readonly id: string; readonly slug: string }[],
):
  | { readonly status: 'suggested'; readonly targetGroupId: string }
  | { readonly status: 'unmapped'; readonly targetGroupId: null } {
  const key = sourceSlug.toLowerCase();
  const hit = targets.find((t) => t.slug.toLowerCase() === key);
  return hit
    ? { status: 'suggested', targetGroupId: hit.id }
    : { status: 'unmapped', targetGroupId: null };
}
