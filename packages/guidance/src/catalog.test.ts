import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GUIDANCE } from './entries.ts';
import enMessages from './messages/en.json' with { type: 'json' };
import { PARAM_NAMES, PARAMS } from './params.ts';
import { CONTEXTS, placeholdersIn } from './template.ts';

const catalog: Record<string, string> = enMessages;

function referencedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const entry of Object.values(GUIDANCE)) {
    keys.add(entry.title);
    keys.add(entry.summary);
    if (entry.verification !== undefined) keys.add(entry.verification);
    for (const step of entry.steps) keys.add(step.text);
  }
  return keys;
}

describe('guidance message catalog (UI-040)', () => {
  it('[UI-040] every message key used by a guidance entry exists in messages/en.json', () => {
    const missing = [...referencedKeys()].filter((key) => !Object.hasOwn(catalog, key));
    expect(missing).toEqual([]);
  });

  it('[UI-040] every key in messages/en.json is used by some guidance entry', () => {
    const used = referencedKeys();
    const orphans = Object.keys(catalog).filter((key) => !used.has(key));
    expect(orphans).toEqual([]);
  });

  it('[UI-040] every message is non-empty, trimmed and has only well-formed placeholders', () => {
    for (const [key, value] of Object.entries(catalog)) {
      expect(value, key).toBe(value.trim());
      expect(value.length, key).toBeGreaterThan(0);
      for (const { name, context } of placeholdersIn(value)) {
        expect(Object.hasOwn(PARAMS, name), `${key} uses unknown parameter ${name}`).toBe(true);
        if (context !== undefined) {
          expect(
            (CONTEXTS as readonly string[]).includes(context),
            `${key} uses context ${context}`,
          ).toBe(true);
        }
      }
    }
  });

  it('[UI-040] every copy snippet uses declared parameters and at most one list', () => {
    for (const [code, entry] of Object.entries(GUIDANCE)) {
      for (const step of entry.steps) {
        if (step.copy === undefined) continue;
        const names = placeholdersIn(step.copy).map((p) => p.name);
        for (const name of names) {
          expect(Object.hasOwn(PARAMS, name), `${code} copy uses unknown parameter ${name}`).toBe(
            true,
          );
        }
        const lists = new Set(
          names.filter((n) => PARAMS[n as keyof typeof PARAMS].kind === 'list'),
        );
        expect(lists.size, `${code} copy has several list parameters`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('[UI-040] step and summary placeholders name declared parameters', () => {
    for (const [code, entry] of Object.entries(GUIDANCE)) {
      for (const key of [entry.title, entry.summary, entry.verification].filter(
        (k): k is string => k !== undefined,
      )) {
        for (const { name } of placeholdersIn(catalog[key] ?? '')) {
          expect(Object.hasOwn(PARAMS, name), `${code} ${key}: ${name}`).toBe(true);
        }
      }
    }
  });

  it('[UI-040] every declared parameter is used by guidance (no dead parameters)', () => {
    const used = new Set<string>();
    for (const value of Object.values(catalog))
      for (const p of placeholdersIn(value)) used.add(p.name);
    for (const entry of Object.values(GUIDANCE)) {
      for (const step of entry.steps) {
        for (const p of placeholdersIn(step.copy ?? '')) used.add(p.name);
        if (step.when !== undefined) used.add(step.when);
        if (step.unless !== undefined) used.add(step.unless);
      }
    }
    expect(PARAM_NAMES.filter((name) => !used.has(name))).toEqual([]);
  });

  it('[UI-040] the catalog file is the one next-intl will import (src/messages/en.json)', () => {
    const raw = readFileSync(new URL('./messages/en.json', import.meta.url), 'utf8');
    expect(JSON.parse(raw)).toEqual(catalog);
  });
});

describe('raw context is for URL parameters only (ADR-0092)', () => {
  it('[UI-040] every raw placeholder in the catalog and in copy snippets names a url parameter', () => {
    const placeholders = [
      ...Object.values(catalog).flatMap((value) => placeholdersIn(value)),
      ...Object.values(GUIDANCE).flatMap((entry) =>
        entry.steps.flatMap((s) => placeholdersIn(s.copy ?? '')),
      ),
    ];
    for (const { name, context } of placeholders) {
      if (context !== 'raw') continue;
      expect(PARAMS[name as keyof typeof PARAMS].kind, name).toBe('url');
    }
  });

  it('[UI-040] copy snippets never use the raw context (they must be shell-quoted)', () => {
    for (const [code, entry] of Object.entries(GUIDANCE)) {
      for (const step of entry.steps) {
        for (const { name, context } of placeholdersIn(step.copy ?? '')) {
          expect(context, `${code} copy uses raw for ${name}`).not.toBe('raw');
        }
      }
    }
  });
});
