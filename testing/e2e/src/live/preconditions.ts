import type { E2eContext } from './context.ts';
import { asArray, asRecord, type BitbucketApi, type GithubApi } from './ports.ts';

/**
 * TST-031: what must be true before the live test acts, each failure with a message that says what
 * to fix. Every check only reads. A check that cannot get an answer fails (fail closed); nothing
 * is assumed from silence.
 */

export class PreconditionsError extends Error {
  readonly failures: readonly string[];

  constructor(failures: readonly string[]) {
    super(
      `${failures.length} precondition${failures.length === 1 ? '' : 's'} of the live e2e not met (docs/e2e-setup.md):\n${failures.map((failure) => `  - ${failure}`).join('\n')}`,
    );
    this.name = 'PreconditionsError';
    this.failures = failures;
  }
}

export interface PreconditionPorts {
  readonly bitbucket: BitbucketApi;
  readonly github: GithubApi;
}

type Check = (ctx: E2eContext, ports: PreconditionPorts) => Promise<string[]>;

/** The permission level order of the App manifest (docs/providers/github.md). */
const LEVEL = { read: 1, write: 2, admin: 3 } as const;

/** Repository and organization permissions the App needs (docs/providers/github.md#required-app-permissions). */
export const REQUIRED_APP_PERMISSIONS: Readonly<Record<string, 'read' | 'write'>> = {
  administration: 'write',
  contents: 'write',
  workflows: 'write',
  pull_requests: 'write',
  secrets: 'write',
  actions_variables: 'write',
  environments: 'write',
  repository_hooks: 'write',
  actions: 'read',
  metadata: 'read',
  members: 'write',
  organization_plan: 'read',
  organization_secrets: 'write',
  organization_actions_variables: 'write',
  organization_hooks: 'write',
};

export const repoPath = (ctx: E2eContext) =>
  `/2.0/repositories/${encodeURIComponent(ctx.bitbucket.workspace)}/${encodeURIComponent(ctx.fixture.slug)}`;

export function names(page: unknown): string[] {
  return asArray(asRecord(page).values).map((value) => String(asRecord(value).name ?? ''));
}

const unreadable = (status: number, what: string) =>
  `Cannot read ${what} (HTTP ${status}). Check the API token scopes in docs/providers/bitbucket-cloud.md#authentication.`;

const checkBitbucketAccount: Check = async (ctx, { bitbucket }) => {
  const me = await bitbucket.request('GET', '/2.0/user');
  if (me.status !== 200) {
    return [
      `Bitbucket rejected the API token of ${ctx.bitbucket.email} (HTTP ${me.status}). Create a user-scoped API token with the scopes in docs/providers/bitbucket-cloud.md#authentication.`,
    ];
  }
  const accountId = String(asRecord(me.json).account_id ?? '');
  if (accountId !== ctx.bitbucket.accountId) {
    return [
      `The API token belongs to Bitbucket account ${accountId || '(unknown)'}, but BITBUCKET_CREDENTIALS says accountId ${ctx.bitbucket.accountId}. Fix the accountId.`,
    ];
  }
  const permissions = await bitbucket.request(
    'GET',
    `/2.0/workspaces/${encodeURIComponent(ctx.bitbucket.workspace)}/permissions?pagelen=100`,
  );
  if (permissions.status === 404) {
    return [
      `Bitbucket workspace ${ctx.bitbucket.workspace} not found (or the token cannot see it).`,
    ];
  }
  if (permissions.status !== 200) {
    return [
      unreadable(permissions.status, `the permissions of workspace ${ctx.bitbucket.workspace}`),
    ];
  }
  const own = asArray(asRecord(permissions.json).values).find(
    (value) => asRecord(asRecord(value).user).account_id === ctx.bitbucket.accountId,
  );
  if (asRecord(own).permission !== 'owner') {
    return [
      `Bitbucket account ${ctx.bitbucket.email} is not an admin of workspace ${ctx.bitbucket.workspace}. Use a workspace admin's API token.`,
    ];
  }
  return [];
};

const checkBitbucketRepository: Check = async (ctx, { bitbucket }) => {
  const { fixture } = ctx;
  const found = await bitbucket.request('GET', repoPath(ctx));
  if (found.status === 404) {
    return [`Bitbucket repository ${fixture.slug} not found in project ${fixture.projectKey}`];
  }
  if (found.status !== 200) return [unreadable(found.status, `repository ${fixture.slug}`)];
  const repo = asRecord(found.json);
  const out: string[] = [];
  const project = String(asRecord(repo.project).key ?? '');
  if (project !== fixture.projectKey) {
    out.push(
      `Bitbucket repository ${fixture.slug} is in project ${project}, not ${fixture.projectKey}`,
    );
  }
  if (repo.is_private !== true) out.push(`Bitbucket repository ${fixture.slug} must be private`);
  const description = String(repo.description ?? '');
  if (description.startsWith('[MIGRATED')) {
    out.push(
      `Bitbucket repository ${fixture.slug} still carries a [MIGRATED] description prefix from an earlier run. Run \`pnpm e2e:live:reset\`.`,
    );
  } else if (description !== fixture.description) {
    out.push(
      `Bitbucket repository ${fixture.slug} must have the description "${fixture.description}" (it has "${description}")`,
    );
  }
  if (String(repo.website ?? '') !== fixture.website) {
    out.push(`Bitbucket repository ${fixture.slug} must have the website ${fixture.website}`);
  }
  if (repo.fork_policy !== 'no_public_forks') {
    out.push(
      `Bitbucket repository ${fixture.slug} must allow only private forks (fork_policy is ${String(repo.fork_policy)})`,
    );
  }
  if (asRecord(repo.mainbranch).name !== 'main') {
    out.push(`Bitbucket repository ${fixture.slug} must have main as its default branch`);
  }
  return out;
};

const refsCheck =
  (kind: 'branches' | 'tags'): Check =>
  async (ctx, { bitbucket }) => {
    const expected = kind === 'branches' ? ctx.fixture.branches : ctx.fixture.tags;
    const answer = await bitbucket.request('GET', `${repoPath(ctx)}/refs/${kind}?pagelen=100`);
    if (answer.status !== 200) {
      return [unreadable(answer.status, `the ${kind} of ${ctx.fixture.slug}`)];
    }
    const present = new Set(names(answer.json));
    return expected
      .filter((name) => !present.has(name))
      .map(
        (name) =>
          `Bitbucket repository ${ctx.fixture.slug} has no ${kind === 'branches' ? 'branch' : 'tag'} ${name}`,
      );
  };

const checkBitbucketLfs: Check = async (ctx, { bitbucket }) => {
  const out: string[] = [];
  const attributes = await bitbucket.request('GET', `${repoPath(ctx)}/src/main/.gitattributes`);
  if (attributes.status !== 200) {
    out.push(
      `Bitbucket repository ${ctx.fixture.slug} has no .gitattributes on main (it must track *.bin with LFS)`,
    );
  }
  const sample = await bitbucket.request(
    'GET',
    `${repoPath(ctx)}/src/main/assets/sample.bin?format=meta`,
  );
  if (sample.status !== 200) {
    out.push(
      `Bitbucket repository ${ctx.fixture.slug} has no assets/sample.bin on main (about 1 MB, tracked by LFS)`,
    );
  }
  return out;
};

const checkBitbucketSettings: Check = async (ctx, { bitbucket }) => {
  const out: string[] = [];
  const slug = ctx.fixture.slug;
  const restrictions = await bitbucket.request(
    'GET',
    `${repoPath(ctx)}/branch-restrictions?pagelen=100`,
  );
  if (restrictions.status !== 200) {
    out.push(unreadable(restrictions.status, `the branch restrictions of ${slug}`));
  } else {
    const rows = asArray(asRecord(restrictions.json).values).map(asRecord);
    for (const kind of ['force', 'delete']) {
      if (!rows.some((row) => row.kind === kind && row.pattern === 'main')) {
        const label =
          kind === 'force' ? 'Prevent rewriting history' : 'Prevent deleting this branch';
        out.push(`Bitbucket repository ${slug} needs a "${label}" restriction on main`);
      }
    }
    if (rows.some((row) => row.kind === 'push' && row.pattern === '*')) {
      out.push(
        `Bitbucket repository ${slug} already has a push restriction on * from an earlier run. Run \`pnpm e2e:live:reset\`.`,
      );
    }
    if (rows.some((row) => asArray(row.users).length > 0 || asArray(row.groups).length > 0)) {
      out.push(
        `Bitbucket repository ${slug} has branch restrictions with user or group lists; the fixture has none`,
      );
    }
  }
  const keys = await bitbucket.request('GET', `${repoPath(ctx)}/deploy-keys?pagelen=100`);
  if (keys.status !== 200) out.push(unreadable(keys.status, `the access keys of ${slug}`));
  else if (
    !asArray(asRecord(keys.json).values).some(
      (key) => asRecord(key).label === ctx.fixture.deployKeyTitle,
    )
  ) {
    out.push(
      `Bitbucket repository ${slug} needs an access key titled ${ctx.fixture.deployKeyTitle}`,
    );
  }
  const variables = await bitbucket.request(
    'GET',
    `${repoPath(ctx)}/pipelines_config/variables?pagelen=100`,
  );
  if (variables.status !== 200) {
    out.push(unreadable(variables.status, `the Pipelines variables of ${slug}`));
  } else {
    const rows = asArray(asRecord(variables.json).values).map(asRecord);
    const { name, value } = ctx.fixture.variable;
    if (!rows.some((row) => row.key === name && row.secured !== true && row.value === value)) {
      out.push(`Bitbucket repository ${slug} needs the unsecured variable ${name}=${value}`);
    }
    if (rows.some((row) => row.secured === true)) {
      out.push(`Bitbucket repository ${slug} must have no secured variables`);
    }
  }
  const pipelines = await bitbucket.request(
    'GET',
    `${repoPath(ctx)}/src/main/bitbucket-pipelines.yml?format=meta`,
  );
  if (pipelines.status === 200)
    out.push(`Bitbucket repository ${slug} must have no bitbucket-pipelines.yml`);
  else if (pipelines.status !== 404) {
    out.push(unreadable(pipelines.status, `bitbucket-pipelines.yml of ${slug}`));
  }
  for (const [what, path] of [
    ['webhooks', '/hooks?pagelen=1'],
    ['open pull requests', '/pullrequests?state=OPEN&pagelen=1'],
    ['explicit user permissions', '/permissions-config/users?pagelen=1'],
    ['explicit group permissions', '/permissions-config/groups?pagelen=1'],
  ] as const) {
    const answer = await bitbucket.request('GET', `${repoPath(ctx)}${path}`);
    if (answer.status !== 200) out.push(unreadable(answer.status, `the ${what} of ${slug}`));
    else if (asArray(asRecord(answer.json).values).length > 0) {
      out.push(`Bitbucket repository ${slug} must have no ${what}`);
    }
  }
  return out;
};

const checkGithubApp: Check = async (ctx, { github }) => {
  // The installation on the organization, read with the App's JWT.
  const installation = await github.asApp('GET /orgs/{org}/installation', { org: ctx.github.org });
  if (installation.status === 401) {
    return [
      `GitHub rejected the App JWT for App ${ctx.github.appId}: check the App ID and GITHUB_APP_PRIVATE_KEY.`,
    ];
  }
  if (installation.status === 404) {
    return [
      `GitHub App ${ctx.github.appId} is not installed on organization ${ctx.github.org}: install it with access to All repositories.`,
    ];
  }
  if (installation.status !== 200) {
    return [
      `Cannot read the installation of GitHub App ${ctx.github.appId} on ${ctx.github.org} (HTTP ${installation.status}).`,
    ];
  }
  const data = asRecord(installation.json);
  const out: string[] = [];
  if (Number(data.id) !== ctx.github.installationId) {
    out.push(
      `The installation on ${ctx.github.org} has ID ${String(data.id)}, not ${ctx.github.installationId}: fix installationId in the configuration.`,
    );
  }
  if (Number(data.app_id) !== ctx.github.appId) {
    out.push(
      `The installation on ${ctx.github.org} belongs to App ${String(data.app_id)}, not ${ctx.github.appId}: fix appId in the configuration.`,
    );
  }
  if (data.suspended_at)
    out.push(`GitHub App installation ${ctx.github.installationId} is suspended`);
  if (data.repository_selection !== 'all') {
    out.push(
      `GitHub App must be installed with access to All repositories (it has "${String(data.repository_selection)}")`,
    );
  }
  const granted = asRecord(data.permissions);
  for (const [permission, level] of Object.entries(REQUIRED_APP_PERMISSIONS)) {
    const have = LEVEL[String(granted[permission]) as keyof typeof LEVEL] ?? 0;
    if (have < LEVEL[level]) out.push(`GitHub App lacks permission ${permission}:${level}`);
  }
  return out;
};

const checkGithubOrg: Check = async (ctx, { github }) => {
  const org = await github.asInstallation('GET /orgs/{org}', { org: ctx.github.org });
  if (org.status === 404) {
    return [`GitHub organization ${ctx.github.org} not found (or the App is not installed on it)`];
  }
  if (org.status !== 200) {
    return [`Cannot read GitHub organization ${ctx.github.org} (HTTP ${org.status})`];
  }
  const out: string[] = [];
  const plan = asRecord(asRecord(org.json).plan);
  if (plan.name !== undefined && String(plan.name) !== 'team') {
    out.push(
      `GitHub organization ${ctx.github.org} is on the "${String(plan.name)}" plan; the live e2e expects Team`,
    );
  }
  const planned = `${ctx.github.org}/${ctx.fixture.targetName}`;
  const target = await github.asInstallation('GET /repos/{owner}/{repo}', {
    owner: ctx.github.org,
    repo: ctx.fixture.targetName,
  });
  if (target.status === 200) {
    out.push(
      `GitHub repository ${planned} already exists. Run \`pnpm e2e:live:reset\` to delete it.`,
    );
  } else if (target.status !== 404) {
    out.push(`Cannot check whether GitHub repository ${planned} exists (HTTP ${target.status})`);
  }
  return out;
};

/** The checks by id. `E2eContext.skipChecks` (dry mode only) names them. */
export const CHECKS: ReadonlyArray<{ readonly id: string; readonly run: Check }> = [
  { id: 'bitbucket-account', run: checkBitbucketAccount },
  { id: 'bitbucket-repository', run: checkBitbucketRepository },
  { id: 'bitbucket-branches', run: refsCheck('branches') },
  { id: 'bitbucket-tags', run: refsCheck('tags') },
  { id: 'bitbucket-lfs', run: checkBitbucketLfs },
  { id: 'bitbucket-settings', run: checkBitbucketSettings },
  { id: 'github-app', run: checkGithubApp },
  { id: 'github-org', run: checkGithubOrg },
];

/**
 * Runs every check and collects the failures, so one run names all of them.
 * @throws PreconditionsError when any check fails or cannot get an answer.
 */
export async function assertPreconditions(
  ctx: E2eContext,
  ports: PreconditionPorts,
): Promise<void> {
  const failures: string[] = [];
  // Only the dry mode may skip a check, for what the fakes do not implement. The live mode never
  // does (fail closed), even if the context lists some.
  const skipped = new Set(ctx.target === 'fakes' ? (ctx.skipChecks ?? []) : []);
  for (const { id, run } of CHECKS) {
    if (skipped.has(id)) continue;
    try {
      failures.push(...(await run(ctx, ports)));
    } catch (error) {
      failures.push(
        `A check could not run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures.length > 0) throw new PreconditionsError(failures);
}
