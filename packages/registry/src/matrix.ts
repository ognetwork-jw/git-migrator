/**
 * The capability matrix (API-020 `GET /capability-matrix`): for every Facet and every ordered pair
 * of registered adapters, the worst fidelity the declared static capabilities allow.
 *
 * Static capabilities only. `FacetRead.capabilities` (facts known at read time, ADP-011) overlay
 * the static ones later, per repository: the analysis (T-061) calls `effectiveFieldSupport` with
 * the static `FacetCapability.fields` and the read's `capabilities`, then `fieldFidelity` on the
 * merged result. The matrix itself never overlays; it answers "what can this pair do at best".
 *
 * `translated` (a lossless semantic mapping) is chosen by `translate`, not by capabilities, so the
 * matrix reports at most the ceiling the capabilities prove: `exact`, `lossy`, `unreadable` or
 * `unsupported`.
 */
import type { FacetCapability, FacetKey, Fidelity, FieldSupport } from '@git-migrator/core';

export interface MatrixField {
  readonly path: string;
  readonly source: FieldSupport;
  readonly target: FieldSupport;
  readonly fidelity: Fidelity;
}

export interface MatrixCell {
  readonly source: string;
  readonly target: string;
  /** Worst fidelity over `fields`; `unsupported` when a side lacks the Facet, `unreadable` when the source cannot read it. */
  readonly fidelity: Fidelity;
  /** The source adapter can read the Facet. */
  readonly read: boolean;
  /** The target adapter has a driver `apply` for the Facet. `false` means tasks or other delivery only. */
  readonly write: boolean;
  /** A pair override replaces `translate` for this cell (ADP-032). */
  readonly override: boolean;
  readonly fields: readonly MatrixField[];
}

export interface MatrixRow {
  readonly facet: FacetKey;
  readonly scope: 'repository' | 'endpoint';
  readonly inScope: boolean;
  readonly cells: readonly MatrixCell[];
}

export interface CapabilityMatrix {
  /**
   * Every cell is a static worst-case ceiling for the pair (ADR-0260): it is built from declared
   * capabilities only, never says `translated`, and a per-repository analysis can be worse.
   */
  readonly ceiling: 'static';
  /** Adapter types, sorted. */
  readonly adapters: readonly string[];
  /** One row per Facet in dependency order. */
  readonly rows: readonly MatrixRow[];
}

const SUPPORTED: FieldSupport = { kind: 'supported' };

/** Severity order, best first. */
const ORDER: readonly Fidelity[] = ['exact', 'translated', 'lossy', 'unreadable', 'unsupported'];

export function worstFidelity(values: readonly Fidelity[]): Fidelity {
  let worst = 0;
  for (const v of values) worst = Math.max(worst, ORDER.indexOf(v));
  return ORDER[worst] as Fidelity;
}

/** How bad a declaration is, for the monotone merge. */
const SUPPORT_RANK: Record<FieldSupport['kind'], number> = {
  supported: 0,
  constrained: 1,
  unreadable: 2,
  readOnly: 2,
  unsupported: 3,
};

/**
 * Static fields with the read-time facts laid over them (ADR-0231 section 3). The merge is
 * monotone: a dynamic entry replaces the static one only when it is at least as bad, so a read
 * can add a limit but never lift one the adapter declares. Neither argument is mutated. Call it
 * once per side (source and target); the two results then go to `fieldFidelity` per path.
 */
export function effectiveFieldSupport(
  staticFields: FacetCapability['fields'],
  dynamic?: FacetCapability['fields'],
): FacetCapability['fields'] {
  const merged: Record<string, FieldSupport> = { ...staticFields };
  for (const [path, support] of Object.entries(dynamic ?? {})) {
    const current = merged[path];
    if (current === undefined || SUPPORT_RANK[support.kind] >= SUPPORT_RANK[current.kind]) {
      merged[path] = support;
    }
  }
  return merged;
}

/** Fidelity of one field from the source's and the target's declared support. */
export function fieldFidelity(source: FieldSupport, target: FieldSupport): Fidelity {
  if (source.kind === 'unsupported' || target.kind === 'unsupported') return 'unsupported';
  // A target that can be read but not written cannot hold the value.
  if (target.kind === 'readOnly') return 'unsupported';
  if (source.kind === 'unreadable') return 'unreadable';
  if (source.kind === 'constrained' || target.kind === 'constrained') return 'lossy';
  return 'exact';
}

/** One cell of the matrix from the two sides' capabilities for the Facet (undefined = not declared). */
export function computeCell(
  source: { type: string; caps: FacetCapability | undefined },
  target: { type: string; caps: FacetCapability | undefined },
  override: boolean,
): MatrixCell {
  const read = source.caps?.read === true;
  const write = target.caps?.write === true;
  const base = { source: source.type, target: target.type, read, write, override };
  if (source.caps === undefined || target.caps === undefined) {
    return { ...base, fidelity: 'unsupported', fields: [] };
  }
  const paths = [
    ...new Set([...Object.keys(source.caps.fields), ...Object.keys(target.caps.fields)]),
  ].sort();
  const fields = paths.map((path): MatrixField => {
    const s = source.caps?.fields[path] ?? SUPPORTED;
    const t = target.caps?.fields[path] ?? SUPPORTED;
    return { path, source: s, target: t, fidelity: fieldFidelity(s, t) };
  });
  const all = fields.map((f) => f.fidelity);
  const fidelity = worstFidelity(read ? all : ['unreadable', ...all]);
  return { ...base, fidelity, fields };
}
