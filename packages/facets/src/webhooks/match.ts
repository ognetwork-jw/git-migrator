/**
 * The structural webhook URL match (FAC-WEB-002, ADR-0141). Pure and dependency free, so a client
 * can import it through `@git-migrator/facets/webhooks-match` without the Facet modules.
 *
 * The path glob is matched in time linear in `pattern length x path length` (ADR-0366): there is
 * no regular expression and no backtracking, so a hostile pattern cannot stall a sync or a
 * browser tab.
 */

/** Longest allowlist pattern and hook URL the matcher looks at; longer inputs never match. */
export const MAX_MATCH_LENGTH = 2048;

/** Characters that make a raw URL ambiguous between parsers: backslash, whitespace, controls. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const AMBIGUOUS_URL = /[\\\s\u0000-\u001f\u007f]/;

function parseUrl(value: string): URL | undefined {
  if (value.length > MAX_MATCH_LENGTH || AMBIGUOUS_URL.test(value)) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

type GlobToken = { readonly kind: 'char'; readonly ch: string } | { readonly kind: '*' | '**' };

/** Tokens of a path glob; a run of stars containing `**` is one `**` (collapsed). */
function tokenizeGlob(glob: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob.charAt(i);
    if (ch !== '*') {
      tokens.push({ kind: 'char', ch });
      continue;
    }
    let run = 1;
    while (glob.charAt(i + 1) === '*') {
      run += 1;
      i += 1;
    }
    const previous = tokens[tokens.length - 1];
    const kind = run >= 2 ? '**' : '*';
    if (previous?.kind === '**') continue;
    if (kind === '**' && previous?.kind === '*') tokens[tokens.length - 1] = { kind: '**' };
    else if (kind === '*' && previous?.kind === '*') continue;
    else tokens.push({ kind });
  }
  return tokens;
}

/**
 * Path glob: `*` stays inside a segment, `**` crosses segments, everything else is literal. A
 * dynamic program over the pattern tokens with one row of booleans: `O(tokens x text)` steps.
 */
export function pathGlobMatches(glob: string, text: string): boolean {
  if (glob.length > MAX_MATCH_LENGTH || text.length > MAX_MATCH_LENGTH) return false;
  const tokens = tokenizeGlob(glob);
  let row = new Array<boolean>(text.length + 1).fill(false);
  row[0] = true;
  for (const token of tokens) {
    const next = new Array<boolean>(text.length + 1).fill(false);
    if (token.kind === 'char') {
      for (let j = 1; j <= text.length; j += 1) {
        next[j] = row[j - 1] === true && text.charAt(j - 1) === token.ch;
      }
    } else {
      next[0] = row[0] === true;
      for (let j = 1; j <= text.length; j += 1) {
        const extends1 =
          next[j - 1] === true && (token.kind === '**' || text.charAt(j - 1) !== '/');
        next[j] = row[j] === true || extends1;
      }
    }
    row = next;
  }
  return row[text.length] === true;
}

/** Host glob: a label of `*` matches exactly one label. `**` is not valid in a host. */
function hostGlobToRegExp(glob: string): RegExp | undefined {
  if (glob.includes('**')) return undefined;
  const labels = glob.split('.').map((label) =>
    label
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\-]/g, '\\$&'))
      .join('[^.]+'),
  );
  return new RegExp(`^${labels.join('\\.')}$`);
}

/**
 * Structural match of a hook URL against one allowlist pattern (FAC-WEB-002, ADR-0141). Both are
 * parsed as URLs: the scheme must be equal, the port equal once defaults are removed, the host
 * equal case-insensitively (`*` is one label), and the path must match the glob. The query and the
 * fragment are ignored. A hook URL with a backslash, whitespace or a control character, one longer
 * than 2048 characters, or one that does not parse, never matches (fail closed).
 */
export function matchesPattern(url: string, pattern: string): boolean {
  const target = parseUrl(url);
  const rule = parseUrl(pattern);
  if (target === undefined || rule === undefined) return false;
  if (target.protocol !== rule.protocol || target.port !== rule.port) return false;
  const host = hostGlobToRegExp(rule.hostname);
  if (host === undefined || !host.test(target.hostname)) return false;
  return pathGlobMatches(rule.pathname, target.pathname);
}

export function matchesAllowlist(url: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesPattern(url, p));
}
