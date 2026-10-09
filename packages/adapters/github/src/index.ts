/** @git-migrator/adapter-github: the GitHub provider adapter (T-033) and its pair overrides (T-057). */
export const PACKAGE_NAME = '@git-migrator/adapter-github';

export * from './adapter.ts';
export * from './auth.ts';
export * from './capabilities.ts';
export * from './change-requests.ts';
export * from './config.ts';
export { LIMITS as githubLimits } from './connection.ts';
export { parseCodeowners, renderCodeowners } from './facets/access.ts';
export { fromGithubEvents, GITHUB_EVENTS, toGithubEvents } from './facets/hooks.ts';
export { createClassifier, createInterpreter, endpointLabel, TOKEN_SHAPES } from './http.ts';
export * from './pair-overrides/bitbucket-cloud-pipelines/delivery.ts';
export * from './pair-overrides/bitbucket-cloud-pipelines/index.ts';
