/** @git-migrator/registry: build-time composition of adapters, facets and pair overrides (T-058). */
export const PACKAGE_NAME = '@git-migrator/registry';

export { createBuiltinRegistry } from './builtin.ts';
export {
  type CapabilityMatrix,
  computeCell,
  effectiveFieldSupport,
  fieldFidelity,
  type MatrixCell,
  type MatrixField,
  type MatrixRow,
  worstFidelity,
} from './matrix.ts';
export {
  type PipelinesDelivery,
  type PipelinesDeliveryInput,
  type PipelinesDeliveryResult,
  ProviderRegistry,
  type RegistryParts,
} from './registry.ts';
