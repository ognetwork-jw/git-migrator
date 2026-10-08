/** The workspace package name (ARC-011). */
export const PACKAGE_NAME = '@git-migrator/api';

export {
  API_TITLE,
  type ApiDeps,
  type AppType,
  createApiApp,
  isRetryableConflict,
  MAX_API_BODY_BYTES,
  safeErrorFields,
} from './app.ts';
export { createEventHub, type EventHub, type EventHubOptions } from './events.ts';
export {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  type PageQuery,
  PageQuerySchema,
  pageOf,
  toPage,
} from './pagination.ts';
export { bearerToken, type Principal, resolvePrincipal } from './principal.ts';
export {
  PROBLEM_BASE,
  PROBLEM_CONTENT_TYPE,
  PROBLEMS,
  type Problem,
  type ProblemCode,
  ProblemError,
  ProblemSchema,
  problemBody,
  problemResponse,
} from './problem.ts';
