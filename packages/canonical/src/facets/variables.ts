/**
 * variables (FAC-VAR) and secrets (FAC-SEC). The spec keys both by `scope + name`, which a
 * single-field collection key cannot express; ADR-0086 adds the derived `key` field.
 */
import { z } from 'zod';
import { cleanText, declareFacet, nonEmpty } from '../common.ts';

/** `"repository"` or `"environment:<name>"`. */
export type VariableScope = string;
const scopeSchema = cleanText.regex(/^(repository|environment:.+)$/, {
  message: 'scope must be "repository" or "environment:<name>"',
});
/** Names never contain "/", so `scope/name` is unambiguous (split at the last "/"). */
const nameSchema = cleanText.refine((n) => !n.includes('/'), {
  message: 'name must not contain "/"',
});

/** The collection key of a variable or secret: `<scope>/<name>`. */
export function scopedKey(scope: VariableScope, name: string): string {
  return `${scope}/${name}`;
}

export type Variable = { key: string; scope: VariableScope; name: string; value: string };
export type Variables = { variables: Variable[] }; // key: key (= scope + name)
export type Secret = { key: string; scope: VariableScope; name: string };
export type Secrets = { secrets: Secret[] }; // key: key (= scope + name)

const keyMatches = (v: { key: string; scope: string; name: string }) =>
  v.key === scopedKey(v.scope, v.name);
const keyMessage = { message: 'key must equal "<scope>/<name>"', path: ['key'] };

export const variablesSchema: z.ZodType<Variables> = z.strictObject({
  variables: z.array(
    z
      .strictObject({ key: nonEmpty, scope: scopeSchema, name: nameSchema, value: z.string() })
      .refine(keyMatches, keyMessage),
  ),
});

export const secretsSchema: z.ZodType<Secrets> = z.strictObject({
  secrets: z.array(
    z
      .strictObject({ key: nonEmpty, scope: scopeSchema, name: nameSchema })
      .refine(keyMatches, keyMessage),
  ),
});

export const variablesFacet = declareFacet({
  key: 'variables',
  scope: 'repository',
  schema: variablesSchema,
  collections: [{ path: '/variables', key: 'key' }],
});

export const secretsFacet = declareFacet({
  key: 'secrets',
  scope: 'repository',
  schema: secretsSchema,
  collections: [{ path: '/secrets', key: 'key' }],
});
