import { z } from 'zod';
import { isCron } from './cron.ts';
import { parseDuration } from './duration.ts';

/**
 * The runtime configuration schema of DEP-040 (non-secret values only; secrets come from secretspec).
 * Every object is strict, so an unknown or misspelled key is an error rather than silently ignored.
 * Defaults are applied at every level, so `{}` is a valid configuration that uses all defaults.
 * Durations are parsed to milliseconds. See docs/adr/0051-config-schema-decisions.md.
 */

export const ENVIRONMENTS = ['development', 'test', 'e2e', 'production'] as const;
export const ROLES = ['admin', 'operator', 'viewer'] as const;
export const MERGE_STRATEGIES = ['merge-commit', 'squash', 'rebase'] as const;
export const SOURCE_POST_ACTIONS = ['read-only', 'none'] as const;
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export const SSL_MODES = [
  'disable',
  'allow',
  'prefer',
  'require',
  'verify-ca',
  'verify-full',
] as const;

/** Default policy keys accepted route-wide (FAC-005, Q53 option a). */
export const DEFAULT_ACCEPT_LOSSY = [
  'branch-rules.advisory-enforced',
  'environments.category-dropped',
] as const;

const message = (text: string) => ({ error: text });

const nonEmpty = z.string(message('must be a string')).min(1, message('must not be empty'));
const positiveInt = z
  .number(message('must be a number'))
  .int(message('must be a whole number'))
  .positive(message('must be greater than 0'));
const nonNegativeInt = z
  .number(message('must be a number'))
  .int(message('must be a whole number'))
  .nonnegative(message('must not be negative'));
const tcpPort = z
  .number(message('must be a number'))
  .int(message('must be a whole number'))
  .min(1, message('must be between 1 and 65535'))
  .max(65535, message('must be between 1 and 65535'));
const slug = nonEmpty.regex(
  /^[a-z0-9][a-z0-9-]*$/,
  message('must be lowercase letters, digits and hyphens'),
);
const secretKey = nonEmpty.regex(
  /^[A-Z][A-Z0-9_]*$/,
  message('must be a secretspec key in UPPER_SNAKE_CASE, for example GITHUB_APP_PRIVATE_KEY'),
);
const policyKey = nonEmpty.regex(
  /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/,
  message(
    'must be a policy key of the form <facet>.<name>, for example branch-rules.advisory-enforced',
  ),
);
/** An http(s) URL with no userinfo and no query or fragment: secrets never belong in a URL setting. */
const httpUrl = z
  .url({ protocol: /^https?$/, error: 'must be an http or https URL' })
  .refine((value) => {
    // A value that is not a URL is already reported by the check above; do not report it twice.
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return true;
    }
    return url.username === '' && url.password === '' && url.search === '' && url.hash === '';
  }, message('must not contain a username, password, query string or fragment'));
const optionalHttpUrl = z
  .string(message('must be a string'))
  .trim()
  .refine(
    (value) => value === '' || httpUrl.safeParse(value).success,
    message('must be an http or https URL, or empty'),
  );

const cronSchedule = (fallback: string) =>
  z
    .string(message('must be a string'))
    .refine(isCron, message('must be a five-field cron expression, for example "17 3 * * *"'))
    .prefault(fallback);

const durationSchedule = (fallback: string) =>
  z
    .string(message('must be a string'))
    .refine(
      (value) => parseDuration(value) !== undefined,
      message('must be a duration such as 15m, 24h or 7d'),
    )
    .transform((value) => parseDuration(value) as number)
    .prefault(fallback);

/** True when `pattern` compiles as a JavaScript regular expression. */
function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern, 'u');
    return true;
  } catch {
    return false;
  }
}

const INIT_OPS: ReadonlySet<string> = new Set(['projectKey', 'slug', 'name']);
const NAMING_VARIABLES = ['namespace', 'repository', 'group'] as const;
const variableName = z
  .string(message('must be a string'))
  .regex(/^[a-z][a-zA-Z0-9]*$/, message('must be a variable name such as namespace'));

const initStep = (op: 'projectKey' | 'slug' | 'name') =>
  z.strictObject({
    var: z.enum(NAMING_VARIABLES, message(`must be one of ${NAMING_VARIABLES.join(', ')}`)),
    op: z.literal(op),
  });

const namingStep = z.discriminatedUnion(
  'op',
  [
    initStep('projectKey'),
    initStep('slug'),
    initStep('name'),
    z.strictObject({ var: variableName, op: z.literal('lowercase') }),
    z.strictObject({ var: variableName, op: z.literal('kebab') }),
    z.strictObject({ var: variableName, op: z.literal('truncate'), arg: positiveInt }),
    z.strictObject({
      var: variableName,
      op: z.literal('replace'),
      pattern: nonEmpty.refine(compiles, message('must be a valid regular expression')),
      with: z.string(message('must be a string')),
    }),
  ],
  message(
    'must be a naming step with an op of projectKey, slug, name, lowercase, kebab, truncate or replace',
  ),
);

/**
 * A naming pipeline (06-migration-lifecycle, "Naming"). Every variable a step or the template uses
 * must be initialized by an earlier step, so a rule cannot refer to an empty variable.
 */
const namingPipeline = z
  .strictObject({
    steps: z
      .array(namingStep, message('must be a list of naming steps'))
      .min(1, message('must have at least one step')),
    template: nonEmpty,
  })
  .superRefine((pipeline, ctx) => {
    const initialized = new Set<string>();
    pipeline.steps.forEach((step, index) => {
      if (INIT_OPS.has(step.op)) {
        initialized.add(step.var);
        return;
      }
      if (!initialized.has(step.var)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index, 'var'],
          message: `variable "${step.var}" is used before a step initializes it`,
        });
      }
    });
    for (const match of pipeline.template.matchAll(/\{([^{}]*)\}/g)) {
      const name = match[1] ?? '';
      if (!initialized.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['template'],
          message: `template uses {${name}}, which no step initializes`,
        });
      }
    }
  });

const DEFAULT_NAMING = {
  steps: [
    { var: 'namespace', op: 'projectKey' },
    { var: 'namespace', op: 'lowercase' },
    { var: 'repository', op: 'slug' },
    { var: 'repository', op: 'kebab' },
  ],
  template: '{namespace}-{repository}',
} satisfies z.input<typeof namingPipeline>;

const DEFAULT_TEAM_NAMING = {
  steps: [
    { var: 'group', op: 'slug' },
    { var: 'group', op: 'kebab' },
  ],
  template: '{group}',
} satisfies z.input<typeof namingPipeline>;

const uniqueStrings = (values: readonly string[]) => new Set(values).size === values.length;

const quotaSchema = z
  .strictObject({
    overrides: z
      .record(
        z
          .string()
          .regex(
            /^[a-z][a-z0-9-]*$/,
            message('must be a resource group name such as repository-data'),
          ),
        positiveInt,
        message('must map resource group names to positive whole numbers'),
      )
      .prefault({}),
  })
  .prefault({});

const bitbucketEndpoint = z.strictObject({
  id: slug,
  provider: z.literal('bitbucket-cloud'),
  baseUrl: httpUrl.prefault('https://api.bitbucket.org'),
  gitBaseUrl: httpUrl.prefault('https://bitbucket.org'),
  options: z.strictObject({ workspace: nonEmpty }),
  credentialsSecret: secretKey.prefault('BITBUCKET_CREDENTIALS'),
  quota: quotaSchema,
  atlassianAdmin: z
    .strictObject({
      orgId: z.string(message('must be a string')),
      apiKeySecret: secretKey.prefault('ATLASSIAN_ADMIN_API_KEY'),
    })
    .optional(),
});

const githubEndpoint = z.strictObject({
  id: slug,
  provider: z.literal('github'),
  baseUrl: httpUrl.prefault('https://api.github.com'),
  gitBaseUrl: httpUrl.prefault('https://github.com'),
  options: z.strictObject({
    org: nonEmpty,
    appId: nonNegativeInt,
    installationId: nonNegativeInt,
  }),
  credentialsSecret: secretKey.prefault('GITHUB_APP_PRIVATE_KEY'),
  quota: quotaSchema,
});

const endpointSchema = z.discriminatedUnion(
  'provider',
  [bitbucketEndpoint, githubEndpoint],
  message('must be bitbucket-cloud or github'),
);

const routeSchema = z.strictObject({
  id: slug,
  source: slug,
  target: slug,
  targetNamespace: nonEmpty,
  sourcePostAction: z
    .enum(SOURCE_POST_ACTIONS, message('must be read-only or none'))
    .prefault('read-only'),
  policies: z
    .strictObject({
      acceptLossy: z
        .array(policyKey, message('must be a list of policy keys'))
        .refine(uniqueStrings, message('must not list a policy key twice'))
        .prefault([...DEFAULT_ACCEPT_LOSSY]),
      webhookAllowlistEnabled: z.boolean(message('must be true or false')).prefault(true),
      identityMatch: z
        .strictObject({
          autoConfirmEmail: z.boolean(message('must be true or false')).prefault(true),
        })
        .prefault({}),
    })
    .prefault({}),
  defaults: z
    .strictObject({
      mergeSettings: z
        .strictObject({
          allowed: z
            .array(z.enum(MERGE_STRATEGIES, message('must be merge-commit, squash or rebase')))
            .min(1, message('must allow at least one strategy'))
            .refine(uniqueStrings, message('must not list a strategy twice'))
            .prefault([...MERGE_STRATEGIES]),
          deleteBranchOnMerge: z.boolean(message('must be true or false')).prefault(true),
        })
        .prefault({}),
      naming: namingPipeline.prefault(DEFAULT_NAMING),
      teamNaming: namingPipeline.prefault(DEFAULT_TEAM_NAMING),
    })
    .prefault({}),
});

const roleMappingSchema = z.strictObject({
  method: z
    .string(message('must be a string'))
    .regex(/^[a-z][a-z0-9-]*$/, message('must be a sign-in method name such as entra')),
  claim: nonEmpty,
  value: nonEmpty,
  role: z.enum(ROLES, message('must be admin, operator or viewer')),
});

export const ConfigSchema = z
  .strictObject({
    environment: z
      .enum(ENVIRONMENTS, message(`must be one of ${ENVIRONMENTS.join(', ')}`))
      .prefault('development'),
    publicUrl: httpUrl.prefault('http://localhost:3000'),
    auth: z
      .strictObject({
        entra: z
          .strictObject({
            // The `tid` claim of an Entra token is a GUID, so the tenant must be one (AUTH-002).
            // It is trimmed and lowercased first; empty means unset.
            tenantId: z
              .string(message('must be a string'))
              .trim()
              .toLowerCase()
              .regex(
                /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/,
                message(
                  'must be the tenant GUID, for example 00000000-0000-0000-0000-000000000000',
                ),
              )
              .prefault(''),
          })
          .prefault({}),
        roleMappings: z
          .array(roleMappingSchema, message('must be a list of role mappings'))
          .prefault([]),
        testSignIn: z
          .strictObject({ enabled: z.boolean(message('must be true or false')).prefault(false) })
          .prefault({}),
      })
      .prefault({}),
    endpoints: z.array(endpointSchema, message('must be a list of endpoints')).prefault([]),
    routes: z.array(routeSchema, message('must be a list of routes')).prefault([]),
    git: z
      .strictObject({
        maxPushBytes: positiveInt.prefault(1_610_612_736),
        maxConcurrentLfsTransfers: positiveInt.prefault(8),
      })
      .prefault({}),
    sizeClass: z
      .strictObject({ largeThresholdBytes: positiveInt.prefault(5_368_709_120) })
      .prefault({}),
    quota: z
      .strictObject({
        safetyFactor: z
          .number(message('must be a number'))
          .gt(0, message('must be greater than 0 and at most 1'))
          .lte(1, message('must be greater than 0 and at most 1'))
          .prefault(0.95),
        backgroundShare: z
          .number(message('must be a number'))
          .gt(0, message('must be greater than 0 and at most 1'))
          .lte(1, message('must be greater than 0 and at most 1'))
          .prefault(0.9),
      })
      .prefault({}),
    github: z.strictObject({ maxConcurrentRequests: positiveInt.prefault(10) }).prefault({}),
    schedules: z
      .strictObject({
        inventory: cronSchedule('0 */6 * * *'),
        analysisFeeder: cronSchedule('* * * * *'),
        analysisStaleAfter: durationSchedule('7d'),
        runRequiresAnalysisWithin: durationSchedule('24h'),
        drift: cronSchedule('17 3 * * *'),
        endpointParity: cronSchedule('47 3 * * *'),
        prune: cronSchedule('*/10 * * * *'),
        runReaper: cronSchedule('* * * * *'),
        scratchCleanup: cronSchedule('35 * * * *'),
        driftReadsSource: z.boolean(message('must be true or false')).prefault(false),
      })
      .prefault({}),
    postgres: z
      .strictObject({
        host: nonEmpty.prefault('localhost'),
        port: tcpPort.prefault(5432),
        database: nonEmpty.prefault('git_migrator'),
        user: nonEmpty.prefault('git_migrator'),
        sslmode: z
          .enum(SSL_MODES, message(`must be one of ${SSL_MODES.join(', ')}`))
          .prefault('require'),
        auth: z
          .enum(['password', 'entra'], message('must be password or entra'))
          .prefault('password'),
        pool: z.strictObject({ app: positiveInt.prefault(10) }).prefault({}),
      })
      .prefault({}),
    worker: z
      .strictObject({
        standard: z
          .strictObject({
            concurrency: z
              .strictObject({
                runs: positiveInt.prefault(4),
                analysis: positiveInt.prefault(8),
                inventory: positiveInt.prefault(2),
                parity: positiveInt.prefault(4),
              })
              .prefault({}),
          })
          .prefault({}),
        large: z
          .strictObject({
            concurrency: z.strictObject({ runs: positiveInt.prefault(1) }).prefault({}),
          })
          .prefault({}),
      })
      .prefault({}),
    observability: z
      .strictObject({
        logLevel: z
          .enum(LOG_LEVELS, message(`must be one of ${LOG_LEVELS.join(', ')}`))
          .prefault('info'),
        otlpEndpoint: optionalHttpUrl.prefault(''),
        serviceName: nonEmpty.prefault('git-migrator'),
      })
      .prefault({}),
    metrics: z.strictObject({ port: tcpPort.prefault(9464) }).prefault({}),
    secretspec: z.strictObject({ profile: nonEmpty.prefault('production') }).prefault({}),
  })
  .superRefine((config, ctx) => {
    const endpointIds = new Set<string>();
    config.endpoints.forEach((endpoint, index) => {
      if (endpointIds.has(endpoint.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['endpoints', index, 'id'],
          message: `endpoint id "${endpoint.id}" is already used`,
        });
      }
      endpointIds.add(endpoint.id);
    });

    const routeIds = new Set<string>();
    config.routes.forEach((route, index) => {
      if (routeIds.has(route.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', index, 'id'],
          message: `route id "${route.id}" is already used`,
        });
      }
      routeIds.add(route.id);
      for (const field of ['source', 'target'] as const) {
        if (!endpointIds.has(route[field])) {
          ctx.addIssue({
            code: 'custom',
            path: ['routes', index, field],
            message: `no endpoint with id "${route[field]}" is defined under endpoints`,
          });
        }
      }
      if (route.source === route.target) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', index, 'target'],
          message: 'source and target must be different endpoints',
        });
      }
    });

    if (config.environment === 'production') {
      if (!config.publicUrl.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['publicUrl'],
          message: 'must use https when environment is production',
        });
      }
      if (config.auth.entra.tenantId === '') {
        ctx.addIssue({
          code: 'custom',
          path: ['auth', 'entra', 'tenantId'],
          message: 'is required when environment is production',
        });
      }
      if (config.auth.testSignIn.enabled) {
        ctx.addIssue({
          code: 'custom',
          path: ['auth', 'testSignIn', 'enabled'],
          message: 'must be false when environment is production (AUTH-012)',
        });
      }
    }
  });

/** The validated, defaulted configuration. Durations are milliseconds. */
export type Config = z.output<typeof ConfigSchema>;
/** The configuration as written in YAML or environment overrides, before defaults. */
export type ConfigInput = z.input<typeof ConfigSchema>;
export type Endpoint = Config['endpoints'][number];
export type Route = Config['routes'][number];
