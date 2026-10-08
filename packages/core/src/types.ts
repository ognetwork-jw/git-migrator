/** Provider-neutral shapes shared by the primitives (ADP-030, ADP-040). */
import type { FieldPath } from './field-path.ts';

export type Fidelity = 'exact' | 'translated' | 'lossy' | 'unsupported' | 'unreadable';

export const FIDELITIES: readonly Fidelity[] = [
  'exact',
  'translated',
  'lossy',
  'unsupported',
  'unreadable',
];

/** `<facet>.<name>`; a namespace separate from finding codes (FAC-005). */
export type PolicyKey = string;

export interface FieldDecision {
  readonly path: FieldPath;
  readonly fidelity: Fidelity;
  readonly policyKey?: PolicyKey;
  readonly accepted: 'policy' | 'migration' | false;
  readonly note?: string;
}

export interface Finding {
  readonly code: string;
  readonly paths: FieldPath[];
  readonly params: Record<string, unknown>;
  readonly verifiable?: boolean;
}

export interface FieldDiff {
  readonly path: FieldPath;
  readonly desired: unknown;
  readonly actual: unknown;
}
