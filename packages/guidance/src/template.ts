/**
 * Guidance templating (UI-040).
 *
 * Placeholders are `{name}` or `{name:context}`. Contexts decide escaping:
 *   markdown (default) escapes Markdown control characters, for prose;
 *   shell              POSIX single-quotes a value unless it is a plain word, for copy snippets;
 *   raw                inserts the validated value unchanged, for URLs in copy snippets.
 *
 * Rendering never throws on bad input and never emits "undefined", "null" or "NaN". A missing,
 * invalid or unknown placeholder renders as `‹name›` and is reported in `problems`. Inserted values
 * are not scanned again, so a value that contains `{other}` is printed literally.
 */
import { PARAMS, type ParamKind, type ParamName, type ParamValues } from './params.ts';

export const CONTEXTS = ['markdown', 'shell', 'raw'] as const;
export type Context = (typeof CONTEXTS)[number];

export type ProblemReason =
  | 'missing'
  | 'invalid'
  | 'unknown-param'
  | 'unknown-context'
  | 'context-mismatch'
  | 'message-fallback';

export interface TemplateProblem {
  readonly param: string;
  readonly reason: ProblemReason;
}

export interface TemplateResult {
  readonly text: string;
  readonly problems: readonly TemplateProblem[];
}

/** A developer error in a template (not a bad runtime value). */
export class TemplateError extends Error {
  override readonly name = 'TemplateError';
}

export const MAX_TEXT_LENGTH = 1024;
export const MAX_LIST_LENGTH = 500;

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)(?::([A-Za-z]+))?\}/g;
const SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
const MARKDOWN_SPECIAL = /[\\`*_[\]<>|~&]/g;

/** Marker shown in place of a value that is missing, invalid or unknown. */
export function missingMarker(name: string): string {
  return `‹${name}›`;
}

/**
 * Characters that never belong in a guidance value: C0 and C1 controls, DEL, the Unicode line and
 * paragraph separators, and bidirectional embedding, override and isolate controls (which can make
 * a copied command read differently from how it runs).
 */
function hasForbiddenCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if (code === 0x2028 || code === 0x2029) return true;
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
  }
  return false;
}

function validText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.trim() === '' || value.length > MAX_TEXT_LENGTH || hasForbiddenCharacter(value)) {
    return undefined;
  }
  return value;
}

function validUrl(value: unknown): string | undefined {
  const text = validText(value);
  if (text === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  // Credentials in a URL would be copied into guidance; refuse them.
  if (url.username !== '' || url.password !== '') return undefined;
  return url.href;
}

function validInteger(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : undefined;
}

function validList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST_LENGTH)
    return undefined;
  const items: string[] = [];
  for (const item of value) {
    const text = validText(item);
    if (text === undefined) return undefined;
    items.push(text);
  }
  return items;
}

/** Validated items of a parameter, or undefined when it is missing or invalid. */
function validItems(kind: ParamKind, value: unknown): string[] | undefined {
  switch (kind) {
    case 'text':
      return optional(validText(value));
    case 'url':
      return optional(validUrl(value));
    case 'integer':
      return optional(validInteger(value));
    case 'list':
      return validList(value);
  }
}

function optional(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : [value];
}

export function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_SPECIAL, '\\$&');
}

/**
 * Stops a bare URL or `www.` host in prose from becoming a link: the separator is written as an HTML
 * character reference, which renders the same but is not autolinked.
 */
export function neutraliseAutolinks(text: string): string {
  // No word boundary: a scheme or host glued to a preceding word character is still neutralised.
  // Any URI scheme (RFC 3986 form), not only web schemes: ssh://, git://, file:///, and so on.
  return text
    .replace(/([A-Za-z][A-Za-z0-9+.-]*):\/\//g, '$1&#58;//')
    .replace(/www\./gi, 'www&#46;');
}

/** POSIX shell word: plain words stay bare, anything else is single-quoted. Leading "-" is refused earlier. */
export function quoteShell(text: string): string {
  if (SHELL_WORD.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function formatItems(items: readonly string[], context: Context): string {
  switch (context) {
    case 'markdown':
      return items.map((item) => neutraliseAutolinks(escapeMarkdown(item))).join(', ');
    case 'shell':
      return items.map(quoteShell).join(' ');
    case 'raw':
      // URLs are only ever inserted raw (see renderOnce); a single quote would end a shell word.
      return items.map((item) => item.replace(/'/g, '%27')).join(', ');
  }
}

function isContext(value: string): value is Context {
  return (CONTEXTS as readonly string[]).includes(value);
}

/** True when a value counts as supplied (not null, undefined, blank or an empty list). */
export function isSupplied(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function renderOnce(template: string, values: Readonly<Record<string, unknown>>): TemplateResult {
  const problems: TemplateProblem[] = [];
  const text = template.replace(PLACEHOLDER, (_whole, name: string, rawContext?: string) => {
    if (!Object.hasOwn(PARAMS, name)) {
      problems.push({ param: name, reason: 'unknown-param' });
      return missingMarker(name);
    }
    const context = rawContext ?? 'markdown';
    if (!isContext(context)) {
      problems.push({ param: name, reason: 'unknown-context' });
      return missingMarker(name);
    }
    const spec = PARAMS[name as ParamName];
    if (context === 'raw' && spec.kind !== 'url') {
      problems.push({ param: name, reason: 'context-mismatch' });
      return missingMarker(name);
    }
    const raw = values[name];
    if (!isSupplied(raw)) {
      problems.push({ param: name, reason: 'missing' });
      return missingMarker(name);
    }
    const items = validItems(spec.kind, raw);
    // A value that starts with "-" would be read as an option by the copied command.
    if (items === undefined || (context === 'shell' && items.some((i) => i.startsWith('-')))) {
      problems.push({ param: name, reason: 'invalid' });
      return missingMarker(name);
    }
    return formatItems(items, context);
  });
  return { text, problems };
}

/** Renders one template. Problems are reported, never thrown. */
export function renderTemplate(template: string, values: ParamValues): TemplateResult {
  return renderOnce(template, values);
}

/**
 * Renders a copy snippet. When the template names one list parameter with valid items, the
 * snippet is repeated once per item and the lines are joined with newlines (for example one
 * `gh secret set` line per secret name). Two list parameters in one snippet are a developer error.
 */
export function renderLines(template: string, values: ParamValues): TemplateResult {
  const record: Readonly<Record<string, unknown>> = values;
  const listNames = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? '';
    if (Object.hasOwn(PARAMS, name) && PARAMS[name as ParamName].kind === 'list') {
      listNames.add(name);
    }
  }
  if (listNames.size > 1) {
    throw new TemplateError(
      `copy template uses several list parameters: ${[...listNames].join(', ')}`,
    );
  }
  const [listName] = listNames;
  if (listName === undefined) return renderOnce(template, record);
  const items = validList(record[listName]);
  if (items === undefined) return renderOnce(template, record);
  const lines = items.map((item) => renderOnce(template, { ...record, [listName]: [item] }));
  return {
    text: lines.map((line) => line.text).join('\n'),
    problems: lines.flatMap((line) => line.problems),
  };
}

/** Every placeholder name a template uses, with its context (for catalog tests). */
export function placeholdersIn(template: string): { name: string; context: string | undefined }[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => ({ name: m[1] ?? '', context: m[2] }));
}
