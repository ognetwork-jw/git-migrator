/**
 * Thin wrapper around oxc-parser (TypeScript 7 ships no JavaScript API) for the repository tools.
 * Parsing is fail-closed: any syntax error makes `ok` false and callers report it as a violation.
 */
import { parseSync } from 'oxc-parser';

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes are walked generically
export type Node = { type: string; start: number; end: number; [key: string]: any };

export interface Parsed {
  program: Node;
  comments: { type: string; value: string }[];
  ok: boolean;
}

export function parse(source: string, filename: string): Parsed {
  const result = parseSync(filename, source);
  return {
    program: result.program as unknown as Node,
    comments: result.comments as unknown as Parsed['comments'],
    ok: result.errors.length === 0,
  };
}

/** Visits every node (depth first, parents before children). */
export function walk(node: unknown, visit: (n: Node) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
  } else if (node && typeof node === 'object') {
    const n = node as Node;
    if (typeof n.type === 'string') visit(n);
    for (const key of Object.keys(n)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      walk(n[key], visit);
    }
  }
}

/** String value of a string literal or of a template literal (static parts joined). */
export function stringValue(
  node: Node | undefined,
): { value: string; dynamic: boolean } | undefined {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string')
    return { value: node.value, dynamic: false };
  if (node.type === 'TemplateLiteral') {
    const quasis = node.quasis as { value: { cooked: string | null; raw: string } }[];
    const first = quasis[0]?.value;
    const dynamic = (node.expressions as unknown[]).length > 0;
    return {
      value: dynamic
        ? (first?.cooked ?? first?.raw ?? '')
        : quasis.map((q) => q.value.cooked ?? q.value.raw).join(''),
      dynamic,
    };
  }
  return undefined;
}
