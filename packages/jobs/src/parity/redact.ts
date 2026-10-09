/**
 * What a ParityResult stores of a value (LIF-060, ADR-0395). The canonical documents hold no
 * secret values (unreadable fields are compared by presence, FAC-SEC-001, FAC-WEB-002), so this is
 * defence in depth: the diff endpoint of T-062 redacts by key again when it reads a row, and a
 * secret that reached a stored diff would stay in the database for ever. Pure.
 */
import { redactWebhookUrl } from '@git-migrator/canonical';
import { isSensitiveKey, REDACTED, redactString } from '@git-migrator/observability';

/** Facets whose documents hold names only: a key name is not a secret there (FAC-SEC-001). */
const NAMES_ONLY: ReadonlySet<string> = new Set(['secrets', 'org-secrets']);
const VALUE_KEYS = /^(value|values|encrypted_?value|secret|token|password|plaintext)$/i;
/** Facets whose `url` fields may carry credentials in the path or query (FAC-WEB-002). */
const WEBHOOK_FACETS: ReadonlySet<string> = new Set(['webhooks', 'org-webhooks']);
const MAX_DEPTH = 32;

const keySensitive = (facetKey: string, key: string): boolean =>
  NAMES_ONLY.has(facetKey) ? VALUE_KEYS.test(key) : isSensitiveKey(key);

/**
 * `value` with strings below a sensitive key replaced and every other string scrubbed; booleans,
 * numbers and `null` stay, so a `hasSecret: true` still diffs. A `{name|key, value}` pair with a
 * sensitive name hides its value. Webhook URLs reduce to `<origin>/…`.
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
 * A value at a field path (one side of a diff). Sensitive when any segment of the path is a
 * sensitive key or a bracket selector (`[name=Authorization]`) names one.
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
