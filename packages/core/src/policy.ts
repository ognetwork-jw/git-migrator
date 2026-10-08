/**
 * Fidelity effects (ADP-040) and Route policies (FAC-005).
 *
 * Every lossy decision carries a policy key. A key in the Route's `acceptLossy` produces no task
 * and one `lossy_accepted` Expected Difference per (facet, path pattern); an unaccepted one
 * produces one `<facet>.accept-lossy` pre task per policy key. Decisions: docs/adr/0059-readiness-and-policy-resolution.md.
 */
import { isFieldPath, patternForPath } from './field-path.ts';
import type { Fidelity, FieldDecision, Finding, PolicyKey } from './types.ts';

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

export interface RoutePolicies {
  acceptLossy: PolicyKey[];
  webhookAllowlistEnabled: boolean;
  identityMatch: { autoConfirmEmail: boolean };
}

/** FAC-005 defaults (the two keys are the spec's default `acceptLossy`; deployments override). */
export const DEFAULT_ROUTE_POLICIES: Readonly<RoutePolicies> = Object.freeze({
  acceptLossy: ['branch-rules.advisory-enforced', 'environments.category-dropped'],
  webhookAllowlistEnabled: true,
  identityMatch: Object.freeze({ autoConfirmEmail: true }),
});

const KEBAB = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';
const POLICY_KEY_RE = new RegExp(`^(${KEBAB})\\.(${KEBAB})$`);

export function isPolicyKey(value: unknown): value is PolicyKey {
  return typeof value === 'string' && POLICY_KEY_RE.test(value);
}

/** The facet part of a policy key, or `undefined` if it is not one. */
export function policyKeyFacet(key: string): string | undefined {
  return POLICY_KEY_RE.exec(key)?.[1];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validates untrusted policy config and fills defaults: an absent field takes its default, an
 * explicit `acceptLossy: []` is respected. `acceptLossy` is deduplicated and sorted. Unknown
 * fields are rejected so that a typo cannot silently disable a policy.
 */
export function resolveRoutePolicies(input: unknown = {}): RoutePolicies {
  if (!isRecord(input)) throw new PolicyError('route policies must be an object');
  for (const k of Object.keys(input)) {
    if (!['acceptLossy', 'webhookAllowlistEnabled', 'identityMatch'].includes(k)) {
      throw new PolicyError(`unknown route policy "${k}"`);
    }
  }
  let acceptLossy: string[] = [...DEFAULT_ROUTE_POLICIES.acceptLossy];
  if (input.acceptLossy !== undefined) {
    if (!Array.isArray(input.acceptLossy)) throw new PolicyError('acceptLossy must be an array');
    for (const key of input.acceptLossy) {
      if (!isPolicyKey(key)) throw new PolicyError(`invalid policy key ${JSON.stringify(key)}`);
    }
    acceptLossy = input.acceptLossy as string[];
  }
  let webhookAllowlistEnabled = DEFAULT_ROUTE_POLICIES.webhookAllowlistEnabled;
  if (input.webhookAllowlistEnabled !== undefined) {
    if (typeof input.webhookAllowlistEnabled !== 'boolean') {
      throw new PolicyError('webhookAllowlistEnabled must be a boolean');
    }
    webhookAllowlistEnabled = input.webhookAllowlistEnabled;
  }
  let autoConfirmEmail = DEFAULT_ROUTE_POLICIES.identityMatch.autoConfirmEmail;
  if (input.identityMatch !== undefined) {
    const im = input.identityMatch;
    if (!isRecord(im) || Object.keys(im).some((k) => k !== 'autoConfirmEmail')) {
      throw new PolicyError('identityMatch must be { autoConfirmEmail }');
    }
    if (im.autoConfirmEmail !== undefined) {
      if (typeof im.autoConfirmEmail !== 'boolean') {
        throw new PolicyError('autoConfirmEmail must be a boolean');
      }
      autoConfirmEmail = im.autoConfirmEmail;
    }
  }
  return {
    acceptLossy: [...new Set(acceptLossy)].sort(),
    webhookAllowlistEnabled,
    identityMatch: { autoConfirmEmail },
  };
}

/** What a fidelity means for the plan (ADP-040). */
export type FidelityEffect = 'none' | 'accept-lossy' | 'facet-defined';

/**
 * `exact` and `translated`: nothing. `lossy`: `<facet>.accept-lossy` pre task unless a policy
 * accepts it. `unsupported` and `unreadable`: a finding the Facet itself defines (core cannot know
 * its code or phase); for `unreadable`, parity compares presence or name only.
 */
export function fidelityEffect(fidelity: Fidelity): FidelityEffect {
  switch (fidelity) {
    case 'exact':
    case 'translated':
      return 'none';
    case 'lossy':
      return 'accept-lossy';
    case 'unsupported':
    case 'unreadable':
      return 'facet-defined';
  }
}

/** `lossy_accepted` Expected Difference to record once per Route (path is a pattern). */
export interface LossyAcceptedDifference {
  readonly facetKey: string;
  readonly path: string;
  readonly reason: 'lossy_accepted';
  readonly note: PolicyKey;
}

export interface LossyResolution {
  /** Same order as the input, with `accepted` set from the policies. */
  readonly decisions: FieldDecision[];
  /** One `<facet>.accept-lossy` pre task per unaccepted policy key, sorted by key. */
  readonly acceptTasks: Finding[];
  /** Deduplicated by (facet, path), in input order. */
  readonly lossyAccepted: LossyAcceptedDifference[];
}

/**
 * Applies FAC-005 to one facet's decisions. `accepted` is recomputed from `policies`; only an
 * existing `'migration'` acceptance (a done accept task) is preserved. A lossy decision without a
 * policy key of this facet, or with a malformed path, is a bug in the facet and throws.
 */
export function applyLossyPolicies(
  facetKey: string,
  decisions: readonly FieldDecision[],
  policies: RoutePolicies,
): LossyResolution {
  const accepted = new Set(policies.acceptLossy);
  const out: FieldDecision[] = [];
  const pending = new Map<PolicyKey, Set<string>>();
  const lossyAccepted = new Map<string, LossyAcceptedDifference>();

  for (const d of decisions) {
    if (d.fidelity !== 'lossy') {
      out.push(d);
      continue;
    }
    const key = d.policyKey;
    if (key === undefined || !isPolicyKey(key)) {
      throw new PolicyError(`lossy decision at ${JSON.stringify(d.path)} has no valid policy key`);
    }
    if (policyKeyFacet(key) !== facetKey) {
      throw new PolicyError(`policy key ${key} does not belong to facet ${facetKey}`);
    }
    if (!isFieldPath(d.path) || d.path === '') {
      throw new PolicyError(`lossy decision has an invalid path ${JSON.stringify(d.path)}`);
    }
    // The canonical spelling escapes any literal `*`, so the path can never act as a wildcard
    // pattern when it is stored as an Expected Difference.
    const path = patternForPath(d.path);
    if (d.accepted === 'migration') {
      out.push({ ...d, path });
    } else if (accepted.has(key)) {
      out.push({ ...d, path, accepted: 'policy' });
      const id = `${facetKey}\u0000${path}`;
      if (!lossyAccepted.has(id)) {
        lossyAccepted.set(id, { facetKey, path, reason: 'lossy_accepted', note: key });
      }
    } else {
      out.push({ ...d, path, accepted: false });
      const paths = pending.get(key) ?? new Set<string>();
      paths.add(path);
      pending.set(key, paths);
    }
  }

  const acceptTasks: Finding[] = [...pending.keys()].sort().map((policyKey) => ({
    code: `${facetKey}.accept-lossy`,
    paths: [...(pending.get(policyKey) as Set<string>)].sort(),
    params: { policyKey },
  }));
  return { decisions: out, acceptTasks, lossyAccepted: [...lossyAccepted.values()] };
}
