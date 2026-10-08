import { describe, expect, it } from 'vitest';
import { ConfigSchema } from './schema.ts';

type Issue = { path: PropertyKey[]; message: string };

const path = (issue: Issue) => issue.path.map(String).join('.');

function issuesFor(input: unknown): Issue[] {
  const result = ConfigSchema.safeParse(input);
  return result.success
    ? []
    : result.error.issues.map((issue) => ({ path: [...issue.path], message: issue.message }));
}

function expectIssue(input: unknown, at: string, text?: string): void {
  const found = issuesFor(input);
  const match = found.find(
    (issue) => path(issue) === at && (text === undefined || issue.message.includes(text)),
  );
  expect(match, `expected an issue at "${at}" in ${JSON.stringify(found)}`).toBeDefined();
}

const bitbucket = {
  id: 'bitbucket-main',
  provider: 'bitbucket-cloud',
  options: { workspace: 'acme' },
};

const github = {
  id: 'github-main',
  provider: 'github',
  options: { org: 'acme', appId: 12345, installationId: 67890 },
};

const route = {
  id: 'bitbucket-to-github',
  source: 'bitbucket-main',
  target: 'github-main',
  targetNamespace: 'acme',
};

/** The complete example from DEP-040, with the placeholders filled in. */
const dep040Example = {
  environment: 'production',
  publicUrl: 'https://git-migrator.example.com',
  auth: {
    entra: { tenantId: '00000000-0000-0000-0000-000000000000' },
    roleMappings: [
      { method: 'entra', claim: 'roles', value: 'GitMigrator.Admin', role: 'admin' },
      { method: 'entra', claim: 'roles', value: 'GitMigrator.Operator', role: 'operator' },
      { method: 'entra', claim: 'roles', value: 'GitMigrator.Viewer', role: 'viewer' },
    ],
    testSignIn: { enabled: false },
  },
  endpoints: [
    {
      id: 'bitbucket-main',
      provider: 'bitbucket-cloud',
      baseUrl: 'https://api.bitbucket.org',
      gitBaseUrl: 'https://bitbucket.org',
      options: { workspace: 'acme' },
      credentialsSecret: 'BITBUCKET_CREDENTIALS',
      quota: { overrides: {} },
      atlassianAdmin: { orgId: '', apiKeySecret: 'ATLASSIAN_ADMIN_API_KEY' },
    },
    {
      id: 'github-main',
      provider: 'github',
      baseUrl: 'https://api.github.com',
      gitBaseUrl: 'https://github.com',
      options: { org: 'acme', appId: 0, installationId: 0 },
      credentialsSecret: 'GITHUB_APP_PRIVATE_KEY',
    },
  ],
  routes: [
    {
      id: 'bitbucket-to-github',
      source: 'bitbucket-main',
      target: 'github-main',
      targetNamespace: 'acme',
      sourcePostAction: 'read-only',
      policies: {
        acceptLossy: ['branch-rules.advisory-enforced', 'environments.category-dropped'],
        webhookAllowlistEnabled: true,
        identityMatch: { autoConfirmEmail: true },
      },
      defaults: {
        mergeSettings: { allowed: ['merge-commit', 'squash', 'rebase'], deleteBranchOnMerge: true },
        naming: {
          steps: [
            { var: 'namespace', op: 'projectKey' },
            { var: 'namespace', op: 'lowercase' },
            { var: 'repository', op: 'slug' },
            { var: 'repository', op: 'kebab' },
          ],
          template: '{namespace}-{repository}',
        },
        teamNaming: {
          steps: [
            { var: 'group', op: 'slug' },
            { var: 'group', op: 'kebab' },
          ],
          template: '{group}',
        },
      },
    },
  ],
  git: { maxPushBytes: 1610612736, maxConcurrentLfsTransfers: 8 },
  sizeClass: { largeThresholdBytes: 5368709120 },
  quota: { safetyFactor: 0.95, backgroundShare: 0.9 },
  github: { maxConcurrentRequests: 10 },
  schedules: {
    inventory: '0 */6 * * *',
    analysisFeeder: '* * * * *',
    analysisStaleAfter: '7d',
    runRequiresAnalysisWithin: '24h',
    drift: '17 3 * * *',
    endpointParity: '47 3 * * *',
    prune: '*/10 * * * *',
    runReaper: '* * * * *',
    scratchCleanup: '35 * * * *',
    driftReadsSource: false,
  },
  postgres: {
    host: 'pg.example.internal',
    port: 5432,
    database: 'git_migrator',
    user: 'git_migrator',
    sslmode: 'require',
    auth: 'password',
    pool: { app: 10 },
  },
  worker: {
    standard: { concurrency: { runs: 4, analysis: 8, inventory: 2, parity: 4 } },
    large: { concurrency: { runs: 1 } },
  },
  observability: { logLevel: 'info', otlpEndpoint: '', serviceName: 'git-migrator' },
  metrics: { port: 9464 },
  secretspec: { profile: 'production' },
};

describe('runtime configuration schema (DEP-040)', () => {
  it('[DEP-040] an empty document uses every default of the schema', () => {
    const config = ConfigSchema.parse({});
    expect(config).toEqual({
      environment: 'development',
      publicUrl: 'http://localhost:3000',
      auth: {
        entra: { tenantId: '' },
        roleMappings: [],
        testSignIn: { enabled: false },
      },
      endpoints: [],
      routes: [],
      git: { maxPushBytes: 1_610_612_736, maxConcurrentLfsTransfers: 8 },
      sizeClass: { largeThresholdBytes: 5_368_709_120 },
      quota: { safetyFactor: 0.95, backgroundShare: 0.9 },
      github: { maxConcurrentRequests: 10 },
      schedules: {
        inventory: '0 */6 * * *',
        analysisFeeder: '* * * * *',
        analysisStaleAfter: 604_800_000,
        runRequiresAnalysisWithin: 86_400_000,
        drift: '17 3 * * *',
        endpointParity: '47 3 * * *',
        prune: '*/10 * * * *',
        runReaper: '* * * * *',
        scratchCleanup: '35 * * * *',
        driftReadsSource: false,
      },
      postgres: {
        host: 'localhost',
        port: 5432,
        database: 'git_migrator',
        user: 'git_migrator',
        sslmode: 'require',
        auth: 'password',
        pool: { app: 10 },
      },
      worker: {
        standard: { concurrency: { runs: 4, analysis: 8, inventory: 2, parity: 4 } },
        large: { concurrency: { runs: 1 } },
      },
      observability: { logLevel: 'info', otlpEndpoint: '', serviceName: 'git-migrator' },
      metrics: { port: 9464 },
      secretspec: { profile: 'production' },
    });
  });

  it('[DEP-040] accepts the complete example document of the spec', () => {
    expect(issuesFor(dep040Example)).toEqual([]);
    const config = ConfigSchema.parse(dep040Example);
    expect(config.routes[0]?.defaults.naming.template).toBe('{namespace}-{repository}');
    expect(config.schedules.analysisStaleAfter).toBe(7 * 86_400_000);
  });

  it('[DEP-040] fills per-provider endpoint URLs and secret names when they are omitted', () => {
    const config = ConfigSchema.parse({ endpoints: [bitbucket, github] });
    const [bb, gh] = config.endpoints;
    expect(bb).toMatchObject({
      baseUrl: 'https://api.bitbucket.org',
      gitBaseUrl: 'https://bitbucket.org',
      credentialsSecret: 'BITBUCKET_CREDENTIALS',
      quota: { overrides: {} },
    });
    expect(bb).not.toHaveProperty('atlassianAdmin');
    expect(gh).toMatchObject({
      baseUrl: 'https://api.github.com',
      gitBaseUrl: 'https://github.com',
      credentialsSecret: 'GITHUB_APP_PRIVATE_KEY',
    });
  });

  it('[DEP-040] rejects unknown keys at every level so typos are not ignored', () => {
    expectIssue({ enviroment: 'production' }, '');
    expectIssue({ git: { maxPushByte: 1 } }, 'git');
    expectIssue({ endpoints: [{ ...github, extra: true }] }, 'endpoints.0');
    expectIssue({ routes: [{ ...route, policies: { acceptLossyy: [] } }] }, 'routes.0.policies');
  });

  it('[DEP-040] environment and publicUrl are validated', () => {
    expectIssue({ environment: 'staging' }, 'environment', 'must be one of');
    expectIssue({ publicUrl: 'git-migrator.example.com' }, 'publicUrl', 'http or https');
    expectIssue({ publicUrl: 'ftp://example.com' }, 'publicUrl', 'http or https');
    expect(issuesFor({ publicUrl: 'http://localhost:3000' })).toEqual([]);
  });

  it('[DEP-040] endpoint ids must be unique slugs', () => {
    expectIssue({ endpoints: [{ ...github, id: 'Bad_Id' }] }, 'endpoints.0.id', 'lowercase');
    expectIssue({ endpoints: [{ ...github, id: '' }] }, 'endpoints.0.id', 'must not be empty');
    expectIssue({ endpoints: [github, { ...github }] }, 'endpoints.1.id', 'already used');
  });

  it('[DEP-040] the provider selects the options schema', () => {
    expectIssue({ endpoints: [{ ...bitbucket, provider: 'gitlab' }] }, 'endpoints.0.provider');
    expectIssue({ endpoints: [{ ...bitbucket, options: {} }] }, 'endpoints.0.options.workspace');
    expectIssue(
      { endpoints: [{ ...bitbucket, options: { workspace: 'acme', org: 'x' } }] },
      'endpoints.0.options',
    );
    expectIssue(
      { endpoints: [{ ...github, options: { org: 'acme' } }] },
      'endpoints.0.options.appId',
    );
    expectIssue(
      { endpoints: [{ ...github, options: { org: '', appId: 1, installationId: 2 } }] },
      'endpoints.0.options.org',
    );
  });

  it('[DEP-040] appId and installationId are non-negative whole numbers (0 is the chart placeholder)', () => {
    expectIssue(
      { endpoints: [{ ...github, options: { ...github.options, appId: -1 } }] },
      'endpoints.0.options.appId',
      'not be negative',
    );
    expectIssue(
      { endpoints: [{ ...github, options: { ...github.options, installationId: 1.5 } }] },
      'endpoints.0.options.installationId',
      'whole number',
    );
    expectIssue(
      { endpoints: [{ ...github, options: { ...github.options, appId: '12' } }] },
      'endpoints.0.options.appId',
      'must be a number',
    );
    expect(
      issuesFor({
        endpoints: [{ ...github, options: { ...github.options, appId: 0, installationId: 0 } }],
      }),
    ).toEqual([]);
  });

  it('[DEP-040] secret names are UPPER_SNAKE_CASE secretspec keys', () => {
    expectIssue(
      { endpoints: [{ ...github, credentialsSecret: 'github-key' }] },
      'endpoints.0.credentialsSecret',
      'UPPER_SNAKE_CASE',
    );
    expectIssue(
      { endpoints: [{ ...bitbucket, atlassianAdmin: { orgId: 'o', apiKeySecret: 'lower' } }] },
      'endpoints.0.atlassianAdmin.apiKeySecret',
    );
  });

  it('[DEP-040] atlassianAdmin is optional and only takes an org id and a secret name', () => {
    const ok = ConfigSchema.parse({
      endpoints: [{ ...bitbucket, atlassianAdmin: { orgId: 'org-1' } }],
    });
    expect(ok.endpoints[0]).toMatchObject({
      atlassianAdmin: { orgId: 'org-1', apiKeySecret: 'ATLASSIAN_ADMIN_API_KEY' },
    });
    expectIssue(
      { endpoints: [{ ...bitbucket, atlassianAdmin: { apiKeySecret: 'X' } }] },
      'endpoints.0.atlassianAdmin.orgId',
    );
  });

  it('[JOB-043] quota overrides map resource group names to positive whole numbers', () => {
    const config = ConfigSchema.parse({
      endpoints: [{ ...bitbucket, quota: { overrides: { 'repository-data': 900 } } }],
    });
    expect(config.endpoints[0]).toMatchObject({ quota: { overrides: { 'repository-data': 900 } } });
    expectIssue(
      { endpoints: [{ ...bitbucket, quota: { overrides: { 'repository-data': 0 } } }] },
      'endpoints.0.quota.overrides.repository-data',
      'greater than 0',
    );
    expectIssue(
      { endpoints: [{ ...bitbucket, quota: { overrides: { 'Raw Files': 5 } } }] },
      'endpoints.0.quota.overrides.Raw Files',
    );
  });

  it('[DEP-040] routes reference endpoints that exist and differ', () => {
    expectIssue(
      { endpoints: [bitbucket], routes: [route] },
      'routes.0.target',
      'no endpoint with id "github-main"',
    );
    expectIssue(
      { endpoints: [bitbucket], routes: [{ ...route, source: 'missing' }] },
      'routes.0.source',
    );
    expectIssue(
      { endpoints: [bitbucket, github], routes: [{ ...route, target: 'bitbucket-main' }] },
      'routes.0.target',
      'must be different',
    );
    expectIssue(
      { endpoints: [bitbucket, github], routes: [route, { ...route }] },
      'routes.1.id',
      'already used',
    );
  });

  it('[DEP-040] sourcePostAction defaults to read-only and accepts none', () => {
    const config = ConfigSchema.parse({ endpoints: [bitbucket, github], routes: [route] });
    expect(config.routes[0]?.sourcePostAction).toBe('read-only');
    expect(
      issuesFor({
        endpoints: [bitbucket, github],
        routes: [{ ...route, sourcePostAction: 'none' }],
      }),
    ).toEqual([]);
    expectIssue(
      { endpoints: [bitbucket, github], routes: [{ ...route, sourcePostAction: 'delete' }] },
      'routes.0.sourcePostAction',
      'read-only or none',
    );
  });

  it('[FAC-005] route policies default as in the spec', () => {
    const config = ConfigSchema.parse({ endpoints: [bitbucket, github], routes: [route] });
    expect(config.routes[0]?.policies).toEqual({
      acceptLossy: ['branch-rules.advisory-enforced', 'environments.category-dropped'],
      webhookAllowlistEnabled: true,
      identityMatch: { autoConfirmEmail: true },
    });
  });

  it('[FAC-005] acceptLossy takes unique policy keys of the form facet.name', () => {
    const withPolicy = (acceptLossy: unknown) => ({
      endpoints: [bitbucket, github],
      routes: [{ ...route, policies: { acceptLossy } }],
    });
    expect(issuesFor(withPolicy(['branch-rules.advisory-enforced']))).toEqual([]);
    expectIssue(withPolicy(['branch-rules']), 'routes.0.policies.acceptLossy.0', 'policy key');
    expectIssue(withPolicy(['Branch.rules']), 'routes.0.policies.acceptLossy.0', 'policy key');
    expectIssue(withPolicy(['a.b', 'a.b']), 'routes.0.policies.acceptLossy', 'twice');
  });

  it('[FAC-005] boolean policy flags must be booleans', () => {
    expectIssue(
      {
        endpoints: [bitbucket, github],
        routes: [{ ...route, policies: { webhookAllowlistEnabled: 'yes' } }],
      },
      'routes.0.policies.webhookAllowlistEnabled',
      'true or false',
    );
    expectIssue(
      {
        endpoints: [bitbucket, github],
        routes: [{ ...route, policies: { identityMatch: { autoConfirmEmail: 1 } } }],
      },
      'routes.0.policies.identityMatch.autoConfirmEmail',
    );
  });

  it('[FAC-MRG-001] merge settings default to all strategies and delete-branch-on-merge', () => {
    const config = ConfigSchema.parse({ endpoints: [bitbucket, github], routes: [route] });
    expect(config.routes[0]?.defaults.mergeSettings).toEqual({
      allowed: ['merge-commit', 'squash', 'rebase'],
      deleteBranchOnMerge: true,
    });
  });

  it('[FAC-MRG-001] merge strategies are a non-empty list of distinct known strategies', () => {
    const withAllowed = (allowed: unknown) => ({
      endpoints: [bitbucket, github],
      routes: [{ ...route, defaults: { mergeSettings: { allowed } } }],
    });
    expectIssue(withAllowed([]), 'routes.0.defaults.mergeSettings.allowed', 'at least one');
    expectIssue(
      withAllowed(['fast-forward']),
      'routes.0.defaults.mergeSettings.allowed.0',
      'merge-commit, squash or rebase',
    );
    expectIssue(
      withAllowed(['squash', 'squash']),
      'routes.0.defaults.mergeSettings.allowed',
      'twice',
    );
  });

  it('[LIF-030] the default naming pipelines of the spec are used when none is given', () => {
    const config = ConfigSchema.parse({ endpoints: [bitbucket, github], routes: [route] });
    const defaults = config.routes[0]?.defaults;
    expect(defaults?.naming).toEqual({
      steps: [
        { var: 'namespace', op: 'projectKey' },
        { var: 'namespace', op: 'lowercase' },
        { var: 'repository', op: 'slug' },
        { var: 'repository', op: 'kebab' },
      ],
      template: '{namespace}-{repository}',
    });
    expect(defaults?.teamNaming).toEqual({
      steps: [
        { var: 'group', op: 'slug' },
        { var: 'group', op: 'kebab' },
      ],
      template: '{group}',
    });
  });

  it('[LIF-030] a naming step must initialize its variable before another step uses it', () => {
    const naming = (steps: unknown[], template = '{repository}') => ({
      endpoints: [bitbucket, github],
      routes: [{ ...route, defaults: { naming: { steps, template } } }],
    });
    expectIssue(
      naming([
        { var: 'repository', op: 'kebab' },
        { var: 'repository', op: 'slug' },
      ]),
      'routes.0.defaults.naming.steps.0.var',
      'used before',
    );
    expectIssue(
      naming(
        [
          { var: 'repository', op: 'slug' },
          { var: 'namespace', op: 'lowercase' },
        ],
        '{repository}',
      ),
      'routes.0.defaults.naming.steps.1.var',
      'used before',
    );
    expect(
      issuesFor(
        naming([
          { var: 'repository', op: 'slug' },
          { var: 'repository', op: 'kebab' },
        ]),
      ),
    ).toEqual([]);
  });

  it('[LIF-030] the template may only use variables that a step initializes', () => {
    const naming = (template: string) => ({
      endpoints: [bitbucket, github],
      routes: [
        {
          ...route,
          defaults: { naming: { steps: [{ var: 'repository', op: 'slug' }], template } },
        },
      ],
    });
    expectIssue(
      naming('{namespace}-{repository}'),
      'routes.0.defaults.naming.template',
      'which no step initializes',
    );
    expect(issuesFor(naming('{repository}-v2'))).toEqual([]);
  });

  it('[LIF-030] naming operations are restricted to the spec operations', () => {
    const naming = (step: unknown) => ({
      endpoints: [bitbucket, github],
      routes: [
        {
          ...route,
          defaults: {
            naming: { steps: [{ var: 'repository', op: 'slug' }, step], template: '{repository}' },
          },
        },
      ],
    });
    expectIssue(
      naming({ var: 'repository', op: 'upper' }),
      'routes.0.defaults.naming.steps.1.op',
      'op of',
    );
    expectIssue(
      naming({ var: 'repository', op: 'truncate', arg: 0 }),
      'routes.0.defaults.naming.steps.1.arg',
      'greater than 0',
    );
    expectIssue(
      naming({ var: 'repository', op: 'truncate' }),
      'routes.0.defaults.naming.steps.1.arg',
    );
    expectIssue(
      naming({ var: 'repository', op: 'replace', pattern: '([', with: '-' }),
      'routes.0.defaults.naming.steps.1.pattern',
      'regular expression',
    );
    expectIssue(
      naming({ var: 'repository', op: 'lowercase', arg: 3 }),
      'routes.0.defaults.naming.steps.1',
    );
    expect(issuesFor(naming({ var: 'repository', op: 'truncate', arg: 20 }))).toEqual([]);
    expect(
      issuesFor(naming({ var: 'repository', op: 'replace', pattern: '_+', with: '-' })),
    ).toEqual([]);
  });

  it('[LIF-030] a naming pipeline needs at least one step and a template', () => {
    const naming = (value: unknown) => ({
      endpoints: [bitbucket, github],
      routes: [{ ...route, defaults: { naming: value } }],
    });
    expectIssue(
      naming({ steps: [], template: 'x' }),
      'routes.0.defaults.naming.steps',
      'at least one step',
    );
    expectIssue(
      naming({ steps: [{ var: 'repository', op: 'slug' }], template: '' }),
      'routes.0.defaults.naming.template',
      'must not be empty',
    );
  });

  it('[DEP-040] git limits default to the spec values and must be positive', () => {
    expect(ConfigSchema.parse({}).git).toEqual({
      maxPushBytes: 1_610_612_736,
      maxConcurrentLfsTransfers: 8,
    });
    expectIssue({ git: { maxPushBytes: 0 } }, 'git.maxPushBytes', 'greater than 0');
    expectIssue(
      { git: { maxConcurrentLfsTransfers: 2.5 } },
      'git.maxConcurrentLfsTransfers',
      'whole number',
    );
  });

  it('[DEP-040] size class and GitHub limits default and must be positive', () => {
    expect(ConfigSchema.parse({}).sizeClass.largeThresholdBytes).toBe(5_368_709_120);
    expect(ConfigSchema.parse({}).github.maxConcurrentRequests).toBe(10);
    expectIssue({ sizeClass: { largeThresholdBytes: -1 } }, 'sizeClass.largeThresholdBytes');
    expectIssue({ github: { maxConcurrentRequests: 0 } }, 'github.maxConcurrentRequests');
  });

  it('[JOB-041] quota factors are numbers in (0, 1]', () => {
    expect(ConfigSchema.parse({ quota: { safetyFactor: 1, backgroundShare: 0.5 } }).quota).toEqual({
      safetyFactor: 1,
      backgroundShare: 0.5,
    });
    for (const key of ['safetyFactor', 'backgroundShare'] as const) {
      expectIssue({ quota: { [key]: 0 } }, `quota.${key}`, 'at most 1');
      expectIssue({ quota: { [key]: 1.01 } }, `quota.${key}`, 'at most 1');
      expectIssue({ quota: { [key]: '0.5' } }, `quota.${key}`, 'must be a number');
    }
  });

  it('[JOB-050] schedules are cron expressions, durations are parsed to milliseconds', () => {
    const config = ConfigSchema.parse({
      schedules: { analysisStaleAfter: '36h', runRequiresAnalysisWithin: '15m' },
    });
    expect(config.schedules.analysisStaleAfter).toBe(129_600_000);
    expect(config.schedules.runRequiresAnalysisWithin).toBe(900_000);
    expectIssue({ schedules: { drift: 'daily' } }, 'schedules.drift', 'cron expression');
    expectIssue({ schedules: { prune: '*/61 * * * *' } }, 'schedules.prune', 'cron expression');
    expectIssue(
      { schedules: { analysisStaleAfter: '7 days' } },
      'schedules.analysisStaleAfter',
      'duration',
    );
    expectIssue(
      { schedules: { runRequiresAnalysisWithin: 24 } },
      'schedules.runRequiresAnalysisWithin',
      'must be a string',
    );
    expectIssue(
      { schedules: { driftReadsSource: 'false' } },
      'schedules.driftReadsSource',
      'true or false',
    );
  });

  it('[DEP-040] postgres values are validated and the password is not part of the file', () => {
    expect(ConfigSchema.parse({}).postgres.pool).toEqual({ app: 10 });
    expectIssue({ postgres: { sslmode: 'optional' } }, 'postgres.sslmode', 'must be one of');
    expectIssue({ postgres: { auth: 'token' } }, 'postgres.auth', 'password or entra');
    expectIssue({ postgres: { port: 70000 } }, 'postgres.port', 'between 1 and 65535');
    expectIssue({ postgres: { host: '' } }, 'postgres.host', 'must not be empty');
    expectIssue({ postgres: { pool: { app: 0 } } }, 'postgres.pool.app', 'greater than 0');
    expectIssue({ postgres: { password: 'x' } }, 'postgres', 'Unrecognized key');
  });

  it('[DEP-040] worker concurrency per role is a positive whole number', () => {
    expectIssue(
      { worker: { standard: { concurrency: { runs: 0 } } } },
      'worker.standard.concurrency.runs',
      'greater than 0',
    );
    expectIssue(
      { worker: { large: { concurrency: { analysis: 2 } } } },
      'worker.large.concurrency',
      'Unrecognized key',
    );
    expect(
      ConfigSchema.parse({ worker: { large: { concurrency: { runs: 3 } } } }).worker.large
        .concurrency,
    ).toEqual({ runs: 3 });
  });

  it('[DEP-050] observability values: log level, optional OTLP endpoint URL and service name', () => {
    expectIssue(
      { observability: { logLevel: 'verbose' } },
      'observability.logLevel',
      'must be one of',
    );
    expectIssue(
      { observability: { otlpEndpoint: 'collector:4318' } },
      'observability.otlpEndpoint',
      'http or https',
    );
    expectIssue({ observability: { serviceName: '' } }, 'observability.serviceName');
    expect(
      ConfigSchema.parse({ observability: { otlpEndpoint: 'http://otel:4318' } }).observability
        .otlpEndpoint,
    ).toBe('http://otel:4318');
  });

  it('[DEP-050] the metrics port defaults to 9464 and must be a TCP port', () => {
    expect(ConfigSchema.parse({}).metrics.port).toBe(9464);
    expectIssue({ metrics: { port: 0 } }, 'metrics.port', 'between 1 and 65535');
    expectIssue({ metrics: { port: 1.5 } }, 'metrics.port', 'whole number');
  });

  it('[DEP-040] the secretspec profile defaults to production and must not be empty', () => {
    expect(ConfigSchema.parse({}).secretspec.profile).toBe('production');
    expectIssue({ secretspec: { profile: '' } }, 'secretspec.profile', 'must not be empty');
  });

  it('[AUTH-010] role mappings name a method, claim, value and one of the three roles', () => {
    const mapping = { method: 'entra', claim: 'roles', value: 'GitMigrator.Admin', role: 'admin' };
    expect(ConfigSchema.parse({ auth: { roleMappings: [mapping] } }).auth.roleMappings).toEqual([
      mapping,
    ]);
    expectIssue(
      { auth: { roleMappings: [{ ...mapping, role: 'owner' }] } },
      'auth.roleMappings.0.role',
      'admin, operator or viewer',
    );
    expectIssue(
      { auth: { roleMappings: [{ ...mapping, method: 'Entra' }] } },
      'auth.roleMappings.0.method',
      'sign-in method',
    );
    expectIssue(
      { auth: { roleMappings: [{ ...mapping, value: '' }] } },
      'auth.roleMappings.0.value',
      'must not be empty',
    );
  });

  it('[AUTH-012] test sign-in is rejected in production', () => {
    expectIssue(
      {
        environment: 'production',
        publicUrl: 'https://x.example',
        auth: { entra: { tenantId: 't' }, testSignIn: { enabled: true } },
      },
      'auth.testSignIn.enabled',
      'production',
    );
    expect(issuesFor({ environment: 'test', auth: { testSignIn: { enabled: true } } })).toEqual([]);
  });

  it('[ARC-030] production requires an https public URL and an Entra tenant', () => {
    expectIssue(
      {
        environment: 'production',
        publicUrl: 'http://git-migrator.example.com',
        auth: { entra: { tenantId: 't' } },
      },
      'publicUrl',
      'https',
    );
    expectIssue(
      { environment: 'production', publicUrl: 'https://git-migrator.example.com' },
      'auth.entra.tenantId',
      'required',
    );
    expect(issuesFor({ environment: 'development', publicUrl: 'http://localhost:3000' })).toEqual(
      [],
    );
  });
});
