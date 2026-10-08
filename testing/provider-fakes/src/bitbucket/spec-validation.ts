import { readFileSync } from 'node:fs';
import OpenAPIResponseValidator from 'openapi-response-validator';

/**
 * Validates fake responses against Atlassian's saved OpenAPI document
 * (`specs/bitbucket-cloud.openapi.json`, TST-010). Used by the fake's own tests, and reusable by
 * fixture tests (T-043).
 */

interface Operation {
  responses: Record<string, unknown>;
}
interface Spec {
  paths: Record<string, Record<string, Operation>>;
  components: unknown;
}

const SPEC_URL = new URL('../../specs/bitbucket-cloud.openapi.json', import.meta.url);

let spec: Spec | undefined;
const validators = new Map<string, OpenAPIResponseValidator>();

function loadSpec(): Spec {
  spec ??= JSON.parse(readFileSync(SPEC_URL, 'utf8')) as Spec;
  return spec;
}

/**
 * Fields the provider doc says are absent from the schema (the fake serves them anyway), keyed by
 * the operation path template. Removed before validation, nothing else is excused.
 */
export const FIELDS_NOT_IN_SCHEMA: Record<string, string[]> = {
  '/repositories/{workspace}/{repo_slug}/branching-model/settings': ['default_branch_deletion'],
  '/workspaces/{workspace}/projects/{project_key}/branching-model/settings': [
    'default_branch_deletion',
  ],
};

/**
 * `repository.mainbranch` is `null` for an empty repository ("missing or null", provider doc,
 * Analysis call budget) but the schema only allows an object. Null values of these keys are
 * removed before validation.
 */
export const NULLABLE_NOT_IN_SCHEMA = ['mainbranch'];

function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null && NULLABLE_NOT_IN_SCHEMA.includes(k)) continue;
      out[k] = dropNulls(v);
    }
    return out;
  }
  return value;
}

export interface SpecCheck {
  /** Empty when the body conforms. */
  errors: string[];
}

/**
 * @param method lower-case HTTP method
 * @param template path template exactly as in the OpenAPI document, without the `/2.0` server base
 */
export function validateAgainstSpec(
  method: string,
  template: string,
  status: number,
  body: unknown,
): SpecCheck {
  const doc = loadSpec();
  const op = doc.paths[template]?.[method.toLowerCase()];
  if (!op) return { errors: [`no operation ${method} ${template} in the OpenAPI document`] };
  const key = `${method} ${template}`;
  let validator = validators.get(key);
  if (!validator) {
    validator = new OpenAPIResponseValidator({
      responses: op.responses as never,
      components: doc.components as never,
    });
    validators.set(key, validator);
  }
  let payload = dropNulls(body);
  const strip = FIELDS_NOT_IN_SCHEMA[template];
  if (strip && payload && typeof payload === 'object') {
    payload = { ...(payload as Record<string, unknown>) };
    for (const f of strip) delete (payload as Record<string, unknown>)[f];
  }
  const result = validator.validateResponse(status, payload);
  if (!result) return { errors: [] };
  return {
    errors: (result.errors ?? []).map(
      (e: { path?: string; message?: string }) => `${e.path ?? ''}: ${e.message ?? ''}`,
    ),
  };
}
