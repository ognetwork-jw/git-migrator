/**
 * Facet registry (ADP-030, ADP-032).
 *
 * Registration validates a definition in isolation (naming, finding codes, policy keys, collection
 * declarations); `ordered()` validates the set (every dependency registered, no cycles, no endpoint
 * facet depending on a repository facet) and returns a deterministic dependency order: Kahn's
 * algorithm, ties broken by key. Pair overrides replace `translate` for one
 * (source, target, facet) triple. Decisions: docs/adr/0080-facet-engine-contract.md.
 */
import { CollectionSpecError, normalizeDocument } from './collections.ts';
import type { FacetDefinition, FacetKey, PairOverride, ProviderPair } from './facet-types.ts';
import { isPolicyKey, policyKeyFacet } from './policy.ts';

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

const KEBAB = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';
const FACET_KEY_RE = new RegExp(`^${KEBAB}$`);
const CODE_RE = new RegExp(`^(${KEBAB})\\.(${KEBAB})$`);

export function isFacetKey(value: unknown): value is FacetKey {
  return typeof value === 'string' && FACET_KEY_RE.test(value);
}

/** `<facet>.accept-lossy`, the pre task for unaccepted lossy decisions (ADP-040). */
export function acceptLossyCode(facetKey: FacetKey): string {
  return `${facetKey}.accept-lossy`;
}

function validateDefinition(def: FacetDefinition<unknown>): void {
  const where = `facet ${JSON.stringify(def.key)}`;
  if (!isFacetKey(def.key)) throw new RegistryError(`${where}: key must be kebab-case`);
  if (def.scope !== 'repository' && def.scope !== 'endpoint') {
    throw new RegistryError(`${where}: scope must be repository or endpoint`);
  }
  if (!Number.isInteger(def.schemaVersion) || def.schemaVersion < 1) {
    throw new RegistryError(`${where}: schemaVersion must be a positive integer`);
  }
  if (def.compareMode !== 'full' && def.compareMode !== 'none') {
    throw new RegistryError(`${where}: compareMode must be full or none`);
  }
  if (typeof def.inScope !== 'boolean') throw new RegistryError(`${where}: inScope is required`);
  for (const fn of ['normalize', 'translate', 'compare'] as const) {
    if (typeof def[fn] !== 'function')
      throw new RegistryError(`${where}: ${fn} must be a function`);
  }
  if (typeof def.schema?.parse !== 'function') {
    throw new RegistryError(`${where}: schema must have a parse function`);
  }
  for (const dep of def.dependsOn) {
    if (!isFacetKey(dep)) throw new RegistryError(`${where}: invalid dependency ${dep}`);
    if (dep === def.key) throw new RegistryError(`${where}: depends on itself`);
  }
  if (new Set(def.dependsOn).size !== def.dependsOn.length) {
    throw new RegistryError(`${where}: duplicate dependency`);
  }
  // ADP-021: surfaces bad collection/set declarations at registration, not at first use.
  try {
    normalizeDocument({}, { collections: def.collections, sets: def.sets ?? [] });
  } catch (e) {
    if (e instanceof CollectionSpecError) throw new RegistryError(`${where}: ${e.message}`);
    throw e;
  }

  const codes = Object.entries(def.findingCodes);
  for (const [code, spec] of codes) {
    const m = CODE_RE.exec(code);
    if (m === null || m[1] !== def.key) {
      throw new RegistryError(
        `${where}: finding code ${JSON.stringify(code)} must be ${def.key}.<name>`,
      );
    }
    if (!['blocker', 'pre', 'post', 'warning'].includes(spec.kind)) {
      throw new RegistryError(`${where}: finding code ${code} has an invalid kind`);
    }
    if (spec.completion !== undefined) {
      if (spec.kind !== 'pre' && spec.kind !== 'post') {
        throw new RegistryError(`${where}: ${code} is not a task, so it has no completion mode`);
      }
      if (!['manual', 'accept', 'resolution', 'parity'].includes(spec.completion)) {
        throw new RegistryError(`${where}: ${code} has an invalid completion mode`);
      }
      if (spec.completion === 'parity' && def.isTaskSatisfied === undefined) {
        throw new RegistryError(`${where}: ${code} has completion parity but no isTaskSatisfied`);
      }
    }
    if (spec.completion === 'accept' && code !== acceptLossyCode(def.key)) {
      throw new RegistryError(
        `${where}: only ${acceptLossyCode(def.key)} may have completion accept`,
      );
    }
  }
  for (const key of def.policyKeys) {
    if (!isPolicyKey(key) || policyKeyFacet(key) !== def.key) {
      throw new RegistryError(
        `${where}: policy key ${JSON.stringify(key)} must be ${def.key}.<name>`,
      );
    }
    if (def.findingCodes[key] !== undefined) {
      throw new RegistryError(`${where}: ${key} is both a policy key and a finding code`);
    }
  }
  if (new Set(def.policyKeys).size !== def.policyKeys.length) {
    throw new RegistryError(`${where}: duplicate policy key`);
  }
  const accept = def.findingCodes[acceptLossyCode(def.key)];
  if (accept !== undefined && (accept.kind !== 'pre' || accept.completion !== 'accept')) {
    throw new RegistryError(
      `${where}: ${acceptLossyCode(def.key)} must be a pre task with completion accept`,
    );
  }
  if (def.policyKeys.length > 0 && accept === undefined) {
    throw new RegistryError(
      `${where}: declares policy keys, so it must declare ${acceptLossyCode(def.key)}`,
    );
  }
}

export class FacetRegistry {
  readonly #facets = new Map<FacetKey, FacetDefinition<unknown>>();
  readonly #overrides = new Map<string, PairOverride<unknown>>();

  /** Registers a definition; throws `RegistryError` for an invalid or duplicate one. */
  register<T>(def: FacetDefinition<T>): this {
    validateDefinition(def as FacetDefinition<unknown>);
    if (this.#facets.has(def.key))
      throw new RegistryError(`facet ${def.key} is already registered`);
    this.#facets.set(def.key, def as FacetDefinition<unknown>);
    return this;
  }

  /** ADP-032: replaces the default `translate` for the pair. At most one per triple. */
  registerOverride<T>(override: PairOverride<T>): this {
    if (!this.#facets.has(override.facet)) {
      throw new RegistryError(`override for unregistered facet ${JSON.stringify(override.facet)}`);
    }
    for (const side of [override.source, override.target]) {
      if (typeof side !== 'string' || side === '') {
        throw new RegistryError('override source and target must be non-empty strings');
      }
    }
    if (typeof override.translate !== 'function') {
      throw new RegistryError('override translate must be a function');
    }
    const id = overrideId(override, override.facet);
    if (this.#overrides.has(id)) {
      throw new RegistryError(
        `override for ${override.source} -> ${override.target} on ${override.facet} already registered`,
      );
    }
    this.#overrides.set(id, override as PairOverride<unknown>);
    return this;
  }

  has(key: FacetKey): boolean {
    return this.#facets.has(key);
  }

  get(key: FacetKey): FacetDefinition<unknown> {
    const def = this.#facets.get(key);
    if (def === undefined) throw new RegistryError(`unknown facet ${JSON.stringify(key)}`);
    return def;
  }

  /** The override for the pair and facet, if any. */
  override(pair: ProviderPair, facet: FacetKey): PairOverride<unknown> | undefined {
    return this.#overrides.get(overrideId(pair, facet));
  }

  /** Registered overrides, sorted for stable output. */
  overrides(): PairOverride<unknown>[] {
    return [...this.#overrides.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, o]) => o);
  }

  /** Keys in registration-independent order (sorted). */
  keys(): FacetKey[] {
    return [...this.#facets.keys()].sort();
  }

  /** Which facet owns a policy key, from the registered definitions. */
  policyOwner(policyKey: string): FacetKey | undefined {
    const facet = policyKeyFacet(policyKey);
    if (facet === undefined) return undefined;
    return this.#facets.get(facet)?.policyKeys.includes(policyKey) ? facet : undefined;
  }

  /**
   * The keys that no registered facet declares, sorted: a typo in a Route's `acceptLossy` would
   * otherwise silently accept nothing (FAC-005).
   */
  unknownPolicyKeys(keys: readonly string[]): string[] {
    return [...new Set(keys.filter((k) => this.policyOwner(k) === undefined))].sort();
  }

  /**
   * Dependency order (dependencies first), deterministic: among facets that are ready at the same
   * time the smallest key goes first. Throws on a missing dependency, a cycle, or an endpoint
   * facet depending on a repository facet.
   */
  ordered(): FacetDefinition<unknown>[] {
    const indegree = new Map<FacetKey, number>();
    const dependents = new Map<FacetKey, FacetKey[]>();
    for (const def of this.#facets.values()) {
      indegree.set(def.key, def.dependsOn.length);
      for (const dep of def.dependsOn) {
        const target = this.#facets.get(dep);
        if (target === undefined) {
          throw new RegistryError(`facet ${def.key} depends on unregistered facet ${dep}`);
        }
        if (def.scope === 'endpoint' && target.scope === 'repository') {
          throw new RegistryError(
            `endpoint facet ${def.key} cannot depend on repository facet ${dep}`,
          );
        }
        dependents.set(dep, [...(dependents.get(dep) ?? []), def.key]);
      }
    }
    const ready = [...indegree]
      .filter(([, n]) => n === 0)
      .map(([k]) => k)
      .sort();
    const out: FacetDefinition<unknown>[] = [];
    while (ready.length > 0) {
      const key = ready.shift() as FacetKey;
      out.push(this.get(key));
      for (const next of dependents.get(key) ?? []) {
        const n = (indegree.get(next) as number) - 1;
        indegree.set(next, n);
        if (n === 0) {
          ready.push(next);
          ready.sort();
        }
      }
    }
    if (out.length !== this.#facets.size) {
      const stuck = [...indegree]
        .filter(([, n]) => n > 0)
        .map(([k]) => k)
        .sort();
      throw new RegistryError(`dependency cycle among facets: ${stuck.join(', ')}`);
    }
    return out;
  }
}

function overrideId(pair: ProviderPair, facet: FacetKey): string {
  return JSON.stringify([pair.source, pair.target, facet]);
}
