/**
 * Validation and matching for the webhook allowlist and the overlay editor (UI-031, UI-032). Pure:
 * the matching is the same structural rule the sync uses (FAC-WEB-002), so the tester answers what
 * the server will do.
 */
import { CANONICAL_FACETS, type FacetKey } from '@git-migrator/canonical';
import { type OverlayIssue, validateOverlayDocument } from '@git-migrator/facets/overlays';
import { MAX_MATCH_LENGTH, matchesPattern } from '@git-migrator/facets/webhooks-match';

export const MAX_PATTERN_LENGTH = MAX_MATCH_LENGTH;
export const MAX_URL_LENGTH = MAX_MATCH_LENGTH;
export const MAX_NOTE_LENGTH = 500;

export type PatternProblem = 'empty' | 'tooLong' | 'shape' | 'characters' | 'hostDoubleStar';

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const AMBIGUOUS = /[\\\u0000-\u001f\u007f]/;

/**
 * The problem with an allowlist pattern, as a key under `config.webhooks.problem`, or `undefined`.
 * A pattern is a URL in which `*` stands for part of a host label or path segment, so it must
 * parse once the wildcards are filled in. The sync never matches a URL with a backslash or a
 * control character, nor a pattern with `**` in the host (FAC-WEB-002), so those are refused here.
 */
export function patternProblem(pattern: string): PatternProblem | undefined {
  const value = pattern.trim();
  if (value === '') return 'empty';
  if (value.length > MAX_PATTERN_LENGTH) return 'tooLong';
  if (AMBIGUOUS.test(value)) return 'characters';
  if (/\s/.test(value)) return 'shape';
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1] ?? '';
  if (authority.includes('**')) return 'hostDoubleStar';
  try {
    const url = new URL(value.replaceAll('*', 'x'));
    return url.protocol === 'https:' || url.protocol === 'http:' ? undefined : 'shape';
  } catch {
    return 'shape';
  }
}

/** The patterns that match a hook URL, in the order given. Nothing is sent anywhere. */
export function matchingPatterns<T extends { readonly pattern: string }>(
  url: string,
  entries: readonly T[],
): T[] {
  if (url.trim() === '' || url.trim().length > MAX_URL_LENGTH) return [];
  return entries.filter((entry) => matchesPattern(url.trim(), entry.pattern));
}

/**
 * The overlay document as the editor reads it: a JSON object, nothing else. Overlays are partial
 * canonical documents (LIF-048); an array or a scalar cannot be merged onto one.
 */
export type OverlayParse =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly problem: 'notJson' | 'notObject' };

export function parseOverlayData(text: string): OverlayParse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'notJson' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, problem: 'notObject' };
  }
  return { ok: true, data: value as Record<string, unknown> };
}

/**
 * Problems of an overlay document for a Facet, found with the same check the server runs
 * (DOM-003): the Facet's schema in deep-partial strict form. Empty when valid or when the Facet is
 * unknown to this build (the server decides).
 */
export function overlayProblems(facetKey: string, data: unknown): OverlayIssue[] {
  const facet = (CANONICAL_FACETS as Record<string, { schema: unknown } | undefined>)[
    facetKey as FacetKey
  ];
  if (facet === undefined) return [];
  return validateOverlayDocument(facet.schema as { parse(data: unknown): unknown }, data);
}
