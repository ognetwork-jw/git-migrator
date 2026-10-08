import { problemCodeOf } from './actor.ts';

/** A failed API call: the RFC 9457 `code` (API-011) and the per-item `errors`, if any. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly errors: readonly { readonly path: string; readonly message: string }[];

  constructor(
    status: number,
    code: string,
    errors: readonly { path: string; message: string }[] = [],
  ) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
}

export interface ApiRequestInit {
  readonly method?: 'GET' | 'POST';
  readonly json?: unknown;
  /** A text body (for example CSV) with its media type. */
  readonly text?: { readonly body: string; readonly type: string };
  readonly fetchImpl?: typeof fetch;
}

async function readErrors(response: Response): Promise<ApiError['errors']> {
  try {
    const body: unknown = await response.clone().json();
    const errors = (body as { errors?: unknown } | null)?.errors;
    if (!Array.isArray(errors)) return [];
    return errors.flatMap((e: unknown) => {
      const { path, message } = (e ?? {}) as { path?: unknown; message?: unknown };
      return typeof path === 'string' && typeof message === 'string' ? [{ path, message }] : [];
    });
  } catch {
    return [];
  }
}

/**
 * Calls `/api/v1` (same origin, session cookie) and returns the parsed JSON. A failure throws an
 * `ApiError` carrying the problem `code`, which views render from `problem.<code>`.
 */
export async function apiRequest<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const fetchImpl = init.fetchImpl ?? fetch;
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string | undefined;
  if (init.text) {
    headers['content-type'] = init.text.type;
    body = init.text.body;
  } else if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  let response: Response;
  try {
    response = await fetchImpl(path, {
      method: init.method ?? 'GET',
      headers,
      ...(body === undefined ? {} : { body }),
    });
  } catch {
    throw new ApiError(0, 'not_ready');
  }
  if (!response.ok) {
    // `readErrors` clones the response, so the body is still there for `problemCodeOf`.
    const errors = await readErrors(response);
    throw new ApiError(response.status, await problemCodeOf(response), errors);
  }
  return (await response.json()) as T;
}
