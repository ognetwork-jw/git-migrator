/** FAC-002: every Finding code a Facet emits must have guidance. */
import { GUIDANCE } from './entries.ts';

/** Thrown when a Facet emits Finding codes that have no guidance. */
export class GuidanceCoverageError extends Error {
  override readonly name = 'GuidanceCoverageError';
  constructor(readonly missing: readonly string[]) {
    super(`Finding codes without guidance (FAC-002): ${missing.join(', ')}`);
  }
}

/** The codes in `codes` that have no guidance entry, sorted and de-duplicated. */
export function findMissingGuidance(codes: Iterable<string>): string[] {
  const missing = new Set<string>();
  for (const code of codes) {
    if (!Object.hasOwn(GUIDANCE, code)) missing.add(code);
  }
  return [...missing].sort();
}

/** Throws GuidanceCoverageError listing every code without guidance. Call it with emitted codes. */
export function assertGuidanceCoverage(codes: Iterable<string>): void {
  const missing = findMissingGuidance(codes);
  if (missing.length > 0) throw new GuidanceCoverageError(missing);
}
