/**
 * Building blocks shared by the facet schemas: principals, the declaration shape of a facet and
 * the facet keys. See docs/adr/0085-principal-entries.md for why principal lists are wrapped.
 */
import type { CollectionKeySpec, DocumentSchema } from '@git-migrator/core';
import { z } from 'zod';

/** Every built-in facet key (docs/spec/05-facets.md, "Facet index"). */
export const FACET_KEYS = [
  'git-refs',
  'repository-settings',
  'merge-settings',
  'access-control',
  'branch-rules',
  'webhooks',
  'deploy-keys',
  'variables',
  'secrets',
  'environments',
  'pipelines',
  'code-ownership',
  'change-requests',
  'extras',
  'members',
  'teams',
  'org-variables',
  'org-secrets',
  'org-webhooks',
] as const;

export type FacetKey = (typeof FACET_KEYS)[number];
export type FacetScope = 'repository' | 'endpoint';

/** A non-empty string; used wherever the string is a key or an identifier. */
export const nonEmpty = z.string().min(1);

/** `{ kind, id }`; `id` is the Provider-stable ID (in translated documents: the target ID). */
export type PrincipalRef = { kind: 'identity' | 'group'; id: string };
export const principalRefSchema: z.ZodType<PrincipalRef> = z.strictObject({
  kind: z.enum(['identity', 'group']),
  id: nonEmpty,
});

/**
 * One element of a `PrincipalRef[]` field. The keyed-collection mechanism (ADP-020/021) addresses
 * an element by a field of the element, and the spec's path form is `[principal=kind:id]`, so a
 * list of principals is a keyed collection of `{ principal }` with key `principal`.
 */
export type PrincipalEntry = { principal: PrincipalRef };
export const principalEntrySchema: z.ZodType<PrincipalEntry> = z.strictObject({
  principal: principalRefSchema,
});

/** True when `s` has no control characters and no leading or trailing whitespace. */
export function isCleanText(s: string): boolean {
  if (s !== s.trim()) return false;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return false;
  }
  return true;
}
/** A non-empty string without control characters or surrounding whitespace. */
export const cleanText = nonEmpty.refine(isCleanText, {
  message: 'must not contain control characters or leading/trailing whitespace',
});

export const nonNegativeInt = z.number().int().min(0);

/** What a facet declares about its canonical schema (FAC-001, ADP-021). */
export interface CanonicalFacet<T = unknown> {
  readonly key: FacetKey;
  readonly scope: FacetScope;
  /** Version of the canonical schema. Bumped on any change that alters a stored document's shape. */
  readonly schemaVersion: number;
  readonly schema: z.ZodType<T>;
  /** Keyed collections: path of plain names from the root, and the element's key field. */
  readonly collections: readonly CollectionKeySpec[];
  /** Paths of arrays of primitives, compared as sorted sets. */
  readonly sets: readonly string[];
  /** `collections` and `sets` in the shape `normalizeDocument` takes. */
  readonly documentSchema: DocumentSchema;
}

export function declareFacet<T>(spec: {
  key: FacetKey;
  scope: FacetScope;
  schema: z.ZodType<T>;
  /** Defaults to 1. */
  schemaVersion?: number;
  collections?: readonly CollectionKeySpec[];
  sets?: readonly string[];
}): CanonicalFacet<T> {
  const collections = Object.freeze(
    [...(spec.collections ?? [])].map((c) => Object.freeze({ ...c })),
  );
  const sets = Object.freeze([...(spec.sets ?? [])]);
  return Object.freeze({
    key: spec.key,
    scope: spec.scope,
    schemaVersion: spec.schemaVersion ?? 1,
    schema: spec.schema,
    collections,
    sets,
    documentSchema: Object.freeze({ collections, sets }),
  });
}

/** Collection declaration of a `PrincipalRef[]` field at `path`. */
export function principalCollection(path: string): CollectionKeySpec {
  return { path, key: 'principal' };
}
