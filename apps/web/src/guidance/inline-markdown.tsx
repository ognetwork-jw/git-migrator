import type { ReactNode } from 'react';

/**
 * The inline Markdown that guidance messages use (UI-040): `code` spans, backslash escapes and the
 * `&#58;` / `&#46;` references that keep a URL in prose from becoming a link (guidance
 * `neutraliseAutolinks`). Nothing else is interpreted and no HTML is produced: the text is rendered
 * as React text, so a value from the source system can never become markup.
 */

const ENTITIES: Readonly<Record<string, string>> = { '&#58;': ':', '&#46;': '.' };
const ESCAPED = /\\([\\`*_[\]<>|~&])|(&#(?:58|46);)/g;

/** Resolves the escapes and character references of a run of text. */
export function unescapeMarkdown(text: string): string {
  return text.replace(ESCAPED, (_whole, escaped?: string, entity?: string) =>
    escaped !== undefined ? escaped : (ENTITIES[entity ?? ''] ?? ''),
  );
}

export type InlineToken =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string };

/** Splits a message into text and code tokens. An unterminated backtick stays literal text. */
export function tokenizeInline(source: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let text = '';
  let at = 0;
  while (at < source.length) {
    const char = source[at];
    if (char === '\\' && at + 1 < source.length) {
      // An escaped character (including a backtick) is never a code delimiter.
      text += source.slice(at, at + 2);
      at += 2;
      continue;
    }
    if (char === '`') {
      let end = at + 1;
      while (end < source.length && source[end] !== '`') end += source[end] === '\\' ? 2 : 1;
      if (end < source.length) {
        if (text !== '') tokens.push({ kind: 'text', text: unescapeMarkdown(text) });
        text = '';
        tokens.push({ kind: 'code', text: unescapeMarkdown(source.slice(at + 1, end)) });
        at = end + 1;
        continue;
      }
    }
    text += char;
    at += 1;
  }
  if (text !== '') tokens.push({ kind: 'text', text: unescapeMarkdown(text) });
  return tokens;
}

/** Renders a guidance message as text and `<code>` elements. */
export function InlineMarkdown({ text }: { readonly text: string }): ReactNode {
  return tokenizeInline(text).map((token, index) =>
    token.kind === 'code' ? (
      // The token list is derived from `text` and never reordered.
      // biome-ignore lint/suspicious/noArrayIndexKey: static derived list
      <code key={index} className="rounded px-1 font-mono text-[0.9em]">
        {token.text}
      </code>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: static derived list
      <span key={index}>{token.text}</span>
    ),
  );
}
