import { readFileSync } from 'node:fs';
import OpenAPIResponseValidator from 'openapi-response-validator';

/**
 * Validates fake responses against GitHub's saved OpenAPI description
 * (`specs/github.openapi.json`, TST-011). Used by the fake's own tests, and reusable by fixture
 * tests (T-043).
 */

interface Operation {
  responses: Record<string, unknown>;
}
interface Spec {
  paths: Record<string, Record<string, Operation>>;
  components: unknown;
}

const SPEC_URL = new URL('../../specs/github.openapi.json', import.meta.url);

let spec: Spec | undefined;
const validators = new Map<string, OpenAPIResponseValidator>();

/**
 * The validator trips over `null` in documentation-only keywords (`examples`, `x-github-*`
 * extensions). Those carry no constraints, so they are dropped. Schema keywords are untouched.
 */
function stripDocs(value: unknown, inPropertyMap = false): unknown {
  if (Array.isArray(value)) return value.map((v) => stripDocs(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!inPropertyMap && (k === 'examples' || k === 'example' || k.startsWith('x-'))) continue;
      out[k] = stripDocs(v, k === 'properties' && !inPropertyMap);
    }
    return out;
  }
  return value;
}

function loadSpec(): Spec {
  spec ??= stripDocs(JSON.parse(readFileSync(SPEC_URL, 'utf8'))) as Spec;
  return spec;
}

/** Operation path templates of the saved description, e.g. `/repos/{owner}/{repo}/keys`. */
export function specPaths(): string[] {
  return Object.keys(loadSpec().paths);
}

export interface SpecCheck {
  /** Empty when the body conforms. */
  errors: string[];
}

/**
 * @param method lower-case HTTP method
 * @param template path template exactly as in the OpenAPI document
 * @param status HTTP status of the response
 * @param body parsed JSON body, or `undefined` for an empty response
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
  if (!op.responses[String(status)])
    return { errors: [`${method} ${template} does not document status ${status}`] };
  const key = `${method} ${template}`;
  let validator = validators.get(key);
  if (!validator) {
    // Response objects may be `$ref`s into components.responses: the validator wants them inline.
    const responses: Record<string, unknown> = {};
    for (const [code, resp] of Object.entries(op.responses)) {
      const ref = (resp as { $ref?: string }).$ref;
      const full = (
        ref
          ? (doc.components as { responses: Record<string, unknown> }).responses[
              ref.split('/').pop() as string
            ]
          : resp
      ) as { content?: Record<string, unknown> };
      // The validator picks the first media type; the fake serves `application/json` only.
      const json = full.content?.['application/json'];
      responses[code] = json ? { ...full, content: { 'application/json': json } } : full;
    }
    validator = new OpenAPIResponseValidator({
      responses: responses as never,
      components: doc.components as never,
    });
    validators.set(key, validator);
  }
  const result = validator.validateResponse(status, body);
  if (!result) return { errors: [] };
  return {
    errors: (result.errors ?? []).map(
      (e: { path?: string; message?: string }) => `${e.path ?? ''}: ${e.message ?? ''}`,
    ),
  };
}
