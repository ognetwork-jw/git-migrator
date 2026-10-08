import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseSync } from 'oxc-parser';
import { describe, expect, it } from 'vitest';
import messages from '../messages/en.json' with { type: 'json' };

const APP_DIR = join(import.meta.dirname, '..');
/** Props whose string value a person reads or a screen reader announces. */
const TEXT_PROPS = new Set(['title', 'aria-label', 'placeholder', 'alt', 'label', 'subTitle']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes are walked generically
type Node = { type: string; [key: string]: any };

/** Visits every node, parents before children. */
function walk(node: unknown, visit: (n: Node) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
  } else if (node && typeof node === 'object') {
    const n = node as Node;
    if (typeof n.type === 'string') visit(n);
    for (const [key, child] of Object.entries(n)) {
      if (key !== 'type' && key !== 'start' && key !== 'end') walk(child, visit);
    }
  }
}

/** Literal words in JSX: text between tags, and string values of the text props. */
function inlineText(path: string): string[] {
  const parsed = parseSync(path, readFileSync(path, 'utf8'));
  expect(parsed.errors, `${path} parses`).toEqual([]);
  const found: string[] = [];
  walk(parsed.program, (node) => {
    if (node.type === 'JSXText' && /[A-Za-z]{2,}/.test(String(node.value))) {
      found.push(String(node.value).trim());
    }
    if (
      node.type === 'JSXAttribute' &&
      TEXT_PROPS.has(String(node.name?.name)) &&
      node.value?.type === 'Literal' &&
      /[A-Za-z]{2,}/.test(String(node.value.value))
    ) {
      found.push(String(node.value.value));
    }
  });
  return found;
}

describe('user-facing strings', () => {
  it('[UI-001] components contain no inline text; it all comes from messages/en.json', () => {
    const offenders = [join(APP_DIR, 'app'), join(APP_DIR, 'src')]
      .flatMap(sourceFiles)
      .map((file) => ({ file: relative(APP_DIR, file), text: inlineText(file) }))
      .filter((entry) => entry.text.length > 0);
    expect(offenders).toEqual([]);
  });

  it('[UI-001] the catalog has no empty text', () => {
    const empty: string[] = [];
    const visit = (value: unknown, path: string) => {
      if (typeof value === 'string') {
        if (value.trim() === '') empty.push(path);
      } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
      }
    };
    visit(messages, 'messages');
    expect(empty).toEqual([]);
  });
});
