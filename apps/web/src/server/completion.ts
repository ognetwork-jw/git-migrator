import { createBuiltinRegistry } from '@git-migrator/registry';

let cached: readonly string[] | undefined;

/** The key `resolutionTaskKeys` uses for a task: its Facet and Finding code. */
export const taskCompletionKey = (facetKey: string, code: string): string => `${facetKey} ${code}`;

/**
 * The tasks a person cannot mark done because changing the data resolves them (completion mode
 * `resolution`, LIF-006), as `taskCompletionKey`s. The server refuses `done` for them; the page
 * gets this list from the same registry, so it offers only what the server accepts.
 */
export function resolutionTaskKeys(): readonly string[] {
  if (cached === undefined) {
    const registry = createBuiltinRegistry();
    const keys: string[] = [];
    for (const facetKey of registry.facets.keys()) {
      const codes = registry.facets.get(facetKey).findingCodes;
      for (const [code, spec] of Object.entries(codes)) {
        if (spec.completion === 'resolution') keys.push(taskCompletionKey(facetKey, code));
      }
    }
    cached = Object.freeze(keys.sort());
  }
  return cached;
}
