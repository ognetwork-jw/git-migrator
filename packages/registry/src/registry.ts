/**
 * Build-time composition (ARC-010): Facet definitions, provider adapters and pair overrides in one
 * object. Pure data plus the core `FacetRegistry`; nothing here does I/O.
 */
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderLimits,
} from '@git-migrator/adapter-sdk';
import type { FacetKey as CanonicalFacetKey } from '@git-migrator/canonical';
import {
  type FacetCapability,
  type FacetDefinition,
  type FacetKey,
  FacetRegistry,
  type PairOverride,
  RegistryError,
} from '@git-migrator/core';
import { type OverlayIssue, validateOverlayDocument } from '@git-migrator/facets/overlays';
import { type CapabilityMatrix, computeCell, type MatrixRow } from './matrix.ts';

export interface RegistryParts {
  readonly facets: readonly FacetDefinition<never>[];
  readonly adapters: readonly ProviderAdapter[];
  readonly overrides?: readonly PairOverride<never>[];
  /** Static provider limits by adapter type, for answers that need no connection (naming preview). */
  readonly limits?: Readonly<Record<string, ProviderLimits>>;
}

/** A detect-only Facet is never written (FAC-EXT-001), so the target's declarations do not matter. */
const DETECT_ONLY_TARGET: FacetCapability = { read: false, write: false, fields: {} };

/** The read-only side of the Facet registry: lookups only, so validation at construction holds. */
export type FacetView = Pick<
  FacetRegistry,
  | 'has'
  | 'get'
  | 'override'
  | 'overrides'
  | 'keys'
  | 'policyOwner'
  | 'unknownPolicyKeys'
  | 'ordered'
>;

export class ProviderRegistry {
  readonly facets: FacetView;
  readonly #facets = new FacetRegistry();
  readonly #adapters = new Map<string, ProviderAdapter>();
  /** Capabilities copied at construction, so a later change to an adapter object cannot alter the matrix. */
  readonly #capabilities = new Map<string, ProviderCapabilities>();
  readonly #limits = new Map<string, ProviderLimits>();

  constructor(parts: RegistryParts) {
    const reg = this.#facets;
    this.facets = Object.freeze({
      has: (k) => reg.has(k),
      get: (k) => reg.get(k),
      override: (p, f) => reg.override(p, f),
      overrides: () => reg.overrides(),
      keys: () => reg.keys(),
      policyOwner: (k) => reg.policyOwner(k),
      unknownPolicyKeys: (k) => reg.unknownPolicyKeys(k),
      ordered: () => reg.ordered(),
    } satisfies FacetView);
    for (const def of parts.facets) this.#facets.register(def as FacetDefinition<unknown>);
    for (const adapter of parts.adapters) {
      if (this.#adapters.has(adapter.type)) {
        throw new RegistryError(`adapter ${adapter.type} is already registered`);
      }
      for (const key of Object.keys(adapter.capabilities.facets)) {
        if (!this.#facets.has(key as FacetKey)) {
          throw new RegistryError(
            `adapter ${adapter.type} declares capabilities for unregistered facet ${key}`,
          );
        }
      }
      this.#adapters.set(adapter.type, adapter);
      this.#capabilities.set(adapter.type, structuredClone(adapter.capabilities));
    }
    for (const [type, limits] of Object.entries(parts.limits ?? {})) {
      if (!this.#adapters.has(type)) {
        throw new RegistryError(`limits given for unregistered adapter ${type}`);
      }
      this.#limits.set(type, structuredClone(limits));
    }
    for (const override of parts.overrides ?? []) {
      for (const side of [override.source, override.target]) {
        if (!this.#adapters.has(side)) {
          throw new RegistryError(`override references unregistered adapter ${side}`);
        }
      }
      if (override.source === override.target) {
        throw new RegistryError(`override for ${override.facet} has the same source and target`);
      }
      const declared = (type: string) =>
        this.#capabilities.get(type)?.facets[override.facet as CanonicalFacetKey] !== undefined;
      if (!declared(override.source) && !declared(override.target)) {
        throw new RegistryError(
          `override for ${override.facet}: neither ${override.source} nor ${override.target} declares it`,
        );
      }
      this.#facets.registerOverride(override as PairOverride<unknown>);
    }
    // Fail at composition time on a missing dependency or a cycle.
    this.#facets.ordered();
  }

  /** Adapter types, sorted. */
  adapterTypes(): string[] {
    return [...this.#adapters.keys()].sort();
  }

  hasAdapter(type: string): boolean {
    return this.#adapters.has(type);
  }

  adapter(type: string): ProviderAdapter {
    const adapter = this.#adapters.get(type);
    if (adapter === undefined) throw new RegistryError(`unknown adapter ${JSON.stringify(type)}`);
    return adapter;
  }

  /** The capabilities as declared when the adapter was registered. */
  capabilities(type: string): ProviderCapabilities {
    return this.#caps(type);
  }

  #caps(type: string): ProviderCapabilities {
    this.adapter(type);
    return this.#capabilities.get(type) as ProviderCapabilities;
  }

  /**
   * The static repository-name limits of an adapter, or `undefined` when none are registered. The
   * connection's own `limits` decide at analysis time; this is for answers that need no connection.
   */
  repositoryNameLimits(type: string): ProviderLimits['repositoryName'] | undefined {
    return this.#limits.get(type)?.repositoryName;
  }

  /**
   * The problems of an Overlay document for Facet `facetKey` (DOM-001, UI-032): the Facet's schema
   * in deep-partial strict form. `undefined` when no such Facet is registered.
   */
  validateOverlay(facetKey: string, data: unknown): OverlayIssue[] | undefined {
    if (!this.#facets.has(facetKey as FacetKey)) return undefined;
    return validateOverlayDocument(this.#facets.get(facetKey as FacetKey).schema, data);
  }

  /** The translate override for the pair and Facet, if any (ADP-032). */
  override(source: string, target: string, facet: FacetKey): PairOverride<unknown> | undefined {
    return this.#facets.override({ source, target }, facet);
  }

  /** API-020 capability matrix: every Facet times every ordered pair of distinct adapters. */
  capabilityMatrix(): CapabilityMatrix {
    const types = this.adapterTypes();
    const rows = this.#facets.ordered().map((def): MatrixRow => {
      const cells = types.flatMap((source) =>
        types
          .filter((target) => target !== source)
          .map((target) =>
            computeCell(
              {
                type: source,
                caps: this.#caps(source).facets[def.key as CanonicalFacetKey],
              },
              {
                type: target,
                caps: def.inScope
                  ? this.#caps(target).facets[def.key as CanonicalFacetKey]
                  : DETECT_ONLY_TARGET,
              },
              this.override(source, target, def.key) !== undefined,
            ),
          ),
      );
      return { facet: def.key, scope: def.scope, inScope: def.inScope, cells };
    });
    return { ceiling: 'static', adapters: types, rows };
  }
}
