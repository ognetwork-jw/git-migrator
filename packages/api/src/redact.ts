import { redactWebhookUrl } from '@git-migrator/canonical';
import { isSensitiveKey, REDACTED, redactString } from '@git-migrator/observability';

/** Facets whose data holds names only, never values: their key names are not secret (FAC-SEC-001). */
const NAMES_ONLY: ReadonlySet<string> = new Set(['secrets', 'org-secrets']);
/** In those Facets only these keys can hold a value; redacted as defence in depth. */
const VALUE_KEYS = /^(value|values|encrypted_?value|secret|token|password|plaintext)$/i;
/** Facets whose `url` fields may carry credentials in the path or query (FAC-WEB-002). */
const WEBHOOK_FACETS: ReadonlySet<string> = new Set(['webhooks', 'org-webhooks']);
const MAX_DEPTH = 32;

/** Whether a key marks the value below it as secret, for this Facet. */
function keySensitive(facetKey: string, key: string): boolean {
  return NAMES_ONLY.has(facetKey) ? VALUE_KEYS.test(key) : isSensitiveKey(key);
}

/**
 * A Facet value as the diff shows it (ADR-0331). The value of a sensitive key is replaced when it is
 * a string, and so is every string below such a key; booleans, numbers and `null` stay, so a
 * `hasSecret: true` still diffs. In a `{name|key, value}` pair a sensitive name makes the value
 * sensitive. Webhook URLs reduce to `<origin>/...`, and every other string goes through the log
 * scrubber (URL userinfo, token shapes, credential schemes). Pure; the input is not changed.
 */
export function redactFacetValue(
  facetKey: string,
  value: unknown,
  key = '',
  inherited = false,
  depth = 0,
): unknown {
  if (depth > MAX_DEPTH) return '[too deep]';
  const sensitive = inherited || keySensitive(facetKey, key);
  if (typeof value === 'string') {
    if (WEBHOOK_FACETS.has(facetKey) && key === 'url') return redactWebhookUrl(value);
    return sensitive ? REDACTED : redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactFacetValue(facetKey, item, key, sensitive, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    // A pair such as {name: "api_token", value: "..."}: the name decides for the value.
    const namedSecret = ['name', 'key'].some((k) => {
      const label = record[k];
      return typeof label === 'string' && keySensitive(facetKey, label);
    });
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      out[k] = redactFacetValue(
        facetKey,
        v,
        k,
        sensitive || (namedSecret && (k === 'value' || k === 'values')),
        depth + 1,
      );
    }
    return out;
  }
  return value;
}

/**
 * A value found at a field path of a Facet (a parity diff side). It is sensitive when ANY segment of
 * the path is a sensitive key, or when a bracket selector (`[name=Authorization]`) names one; bracket
 * contents are never taken as keys themselves.
 */
export function redactAtPath(facetKey: string, path: string, value: unknown): unknown {
  const selectors = [...path.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1] ?? '');
  const segments = path
    .replace(/\[[^\]]*\]/g, '')
    .split(/[/.]/)
    .filter(Boolean);
  const selectorValues = selectors.map((s) => s.slice(s.indexOf('=') + 1));
  const sensitive =
    segments.some((s) => keySensitive(facetKey, s)) ||
    selectorValues.some((s) => keySensitive(facetKey, s));
  return redactFacetValue(facetKey, value, segments[segments.length - 1] ?? '', sensitive);
}

/** Free text (notes, unreadable paths) through the log scrubber. */
export const redactText = (text: string): string => redactString(text);
