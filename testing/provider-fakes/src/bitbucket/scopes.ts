/**
 * API token scopes required per operation, copied from `x-atlassian-oauth2-scopes` of the saved
 * OpenAPI document (a test cross-checks every entry against it). Scopes do not imply each other
 * (`write:` does not grant `read:`), and when several are listed all are required.
 * Keys are `METHOD /openapi/path/template` without the `/2.0` server base.
 */
export const REQUIRED_SCOPES: Readonly<Record<string, readonly string[]>> = {
  'GET /user': ['read:user:bitbucket'],
  'GET /workspaces/{workspace}/projects': ['read:project:bitbucket'],
  'GET /workspaces/{workspace}/members': ['read:workspace:bitbucket'],
  'GET /workspaces/{workspace}/permissions': ['read:workspace:bitbucket'],
  'GET /workspaces/{workspace}/hooks': ['read:webhook:bitbucket'],
  'GET /workspaces/{workspace}/pipelines-config/variables': ['read:pipeline:bitbucket'],
  'GET /workspaces/{workspace}/permissions/repositories/{repo_slug}': ['read:repository:bitbucket'],
  'GET /workspaces/{workspace}/projects/{project_key}/permissions-config/users': [
    'read:project:bitbucket',
  ],
  'GET /workspaces/{workspace}/projects/{project_key}/permissions-config/groups': [
    'read:project:bitbucket',
  ],
  'GET /workspaces/{workspace}/projects/{project_key}/deploy-keys': ['admin:project:bitbucket'],
  'GET /workspaces/{workspace}/projects/{project_key}/branching-model/settings': [
    'admin:project:bitbucket',
  ],
  'GET /repositories/{workspace}': ['read:repository:bitbucket'],
  'GET /repositories/{workspace}/{repo_slug}': ['read:repository:bitbucket'],
  'PUT /repositories/{workspace}/{repo_slug}': ['admin:repository:bitbucket'],
  'GET /repositories/{workspace}/{repo_slug}/permissions-config/users': [
    'read:repository:bitbucket',
  ],
  'GET /repositories/{workspace}/{repo_slug}/permissions-config/groups': [
    'read:repository:bitbucket',
  ],
  'GET /repositories/{workspace}/{repo_slug}/branch-restrictions': ['admin:repository:bitbucket'],
  'POST /repositories/{workspace}/{repo_slug}/branch-restrictions': ['admin:repository:bitbucket'],
  'GET /repositories/{workspace}/{repo_slug}/branch-restrictions/{id}': [
    'admin:repository:bitbucket',
  ],
  'DELETE /repositories/{workspace}/{repo_slug}/branch-restrictions/{id}': [
    'admin:repository:bitbucket',
  ],
  'GET /repositories/{workspace}/{repo_slug}/effective-branching-model': [
    'read:repository:bitbucket',
  ],
  'GET /repositories/{workspace}/{repo_slug}/effective-default-reviewers': [
    'read:pullrequest:bitbucket',
  ],
  'GET /repositories/{workspace}/{repo_slug}/refs/branches': ['read:repository:bitbucket'],
  'GET /repositories/{workspace}/{repo_slug}/refs/branches/{name}': ['read:repository:bitbucket'],
  'GET /repositories/{workspace}/{repo_slug}/branching-model/settings': [
    'admin:repository:bitbucket',
  ],
  'GET /repositories/{workspace}/{repo_slug}/hooks': ['read:webhook:bitbucket'],
  'GET /repositories/{workspace}/{repo_slug}/deploy-keys': ['admin:repository:bitbucket'],
  'GET /repositories/{workspace}/{repo_slug}/pipelines_config': ['admin:repository:bitbucket'],
  'GET /repositories/{workspace}/{repo_slug}/pipelines_config/variables': [
    'read:pipeline:bitbucket',
  ],
  'GET /repositories/{workspace}/{repo_slug}/environments': ['read:pipeline:bitbucket'],
  'GET /repositories/{workspace}/{repo_slug}/deployments_config/environments/{environment_uuid}/variables':
    ['read:pipeline:bitbucket'],
  'GET /repositories/{workspace}/{repo_slug}/pullrequests': ['read:pullrequest:bitbucket'],
  'GET /repositories/{workspace}/{repo_slug}/downloads': ['read:repository:bitbucket'],
  'GET /repositories/{workspace}/{repo_slug}/src/{commit}/{path}': ['read:repository:bitbucket'],
  // Not in the OpenAPI document: the issue endpoints (assumed, provider doc) and the src root.
  'GET /repositories/{workspace}/{repo_slug}/issues': ['read:issue:bitbucket'],
  'GET /repositories/{workspace}/{repo_slug}/src/{commit}': ['read:repository:bitbucket'],
};

/** Entries of the table that the OpenAPI document cannot confirm. */
export const SCOPES_NOT_IN_SPEC: readonly string[] = [
  'GET /repositories/{workspace}/{repo_slug}/issues',
  'GET /repositories/{workspace}/{repo_slug}/src/{commit}',
];

const PARAMS: Record<string, string> = {
  ':ws': '{workspace}',
  ':slug': '{repo_slug}',
  ':key': '{project_key}',
  ':name': '{name}',
  ':id': '{id}',
  ':env': '{environment_uuid}',
  ':commit': '{commit}',
};

/** Turns a Hono route pattern (`/2.0/repositories/:ws/:slug`) into the OpenAPI template. */
export function toTemplate(honoPath: string): string {
  const base = honoPath.replace(/^\/2\.0/, '').replace(/\/\*$/, '/{path}');
  return base.replace(/:[a-z]+/g, (m) => PARAMS[m] ?? m);
}

export function requiredScopes(method: string, honoPath: string): readonly string[] {
  return REQUIRED_SCOPES[`${method.toUpperCase()} ${toTemplate(honoPath)}`] ?? [];
}
