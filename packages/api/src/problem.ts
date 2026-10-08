import { z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';

/** RFC 9457 `type` URIs are `https://git-migrator.invalid/problems/<code>` (API-011). */
export const PROBLEM_BASE = 'https://git-migrator.invalid/problems/';
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * Every problem the API answers with. `title` and `detail` are machine-facing: stable English text
 * for automation and logs, not strings a person reads in the UI. The UI renders the text under
 * `problem.<code>` in `apps/web/messages/en.json` for the `code` (a test pins one key per code).
 */
export const PROBLEMS = {
  bad_request: { status: 400, title: 'Malformed request' },
  unauthenticated: { status: 401, title: 'Authentication required' },
  forbidden: { status: 403, title: 'Insufficient role' },
  origin_not_allowed: { status: 403, title: 'Request origin not allowed' },
  not_found: { status: 404, title: 'Not found' },
  conflict: { status: 409, title: 'Conflict' },
  last_admin: { status: 409, title: 'The last administrator cannot be removed' },
  payload_too_large: { status: 413, title: 'Request body too large' },
  unsupported_media_type: { status: 415, title: 'Unsupported media type' },
  validation_failed: { status: 422, title: 'Validation failed' },
  too_many_streams: { status: 429, title: 'Too many open event streams' },
  not_ready: { status: 503, title: 'Not ready' },
  busy: { status: 503, title: 'Busy, try again shortly' },
  internal_error: { status: 500, title: 'Internal server error' },
} as const;

export type ProblemCode = keyof typeof PROBLEMS;

/** An RFC 9457 problem document, plus the machine-readable `code`. */
export const ProblemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    code: z.string(),
    detail: z.string().optional(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .openapi('Problem');

export type Problem = z.infer<typeof ProblemSchema>;

export interface ProblemOptions {
  readonly detail?: string;
  readonly errors?: readonly { path: string; message: string }[];
  readonly headers?: Readonly<Record<string, string>>;
}

export function problemBody(code: ProblemCode, options: ProblemOptions = {}): Problem {
  const { status, title } = PROBLEMS[code];
  return {
    type: `${PROBLEM_BASE}${code}`,
    title,
    status,
    code,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.errors === undefined ? {} : { errors: [...options.errors] }),
  };
}

/** A `application/problem+json` response (API-011). */
export function problemResponse(code: ProblemCode, options: ProblemOptions = {}): Response {
  return new Response(JSON.stringify(problemBody(code, options)), {
    status: PROBLEMS[code].status,
    headers: { 'content-type': PROBLEM_CONTENT_TYPE, ...options.headers },
  });
}

/** Thrown by handlers to end the request with a problem; the app's `onError` sends it. */
export class ProblemError extends HTTPException {
  constructor(code: ProblemCode, options: ProblemOptions = {}) {
    super(PROBLEMS[code].status, { res: problemResponse(code, options) });
  }
}

/** The problem for a bare HTTP status, for responses that did not come from a handler (API-011). */
export function problemCodeForStatus(status: number): ProblemCode {
  switch (status) {
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'payload_too_large';
    case 415:
      return 'unsupported_media_type';
    case 422:
      return 'validation_failed';
    case 429:
      return 'too_many_streams';
    case 503:
      return 'not_ready';
    default:
      return status >= 500 ? 'internal_error' : 'bad_request';
  }
}
