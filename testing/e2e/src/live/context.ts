import { type Config, ConfigError, loadConfig } from '@git-migrator/config';
import { RefusedError } from './target.ts';

/**
 * What the live spec needs to know about its two providers, whichever stack it runs against. In
 * the `live` mode it comes from the configuration file and secretspec; in the `fakes` mode the
 * global setup builds it from the running fakes.
 */
export interface FixtureExpectations {
  /** Bitbucket project key and repository slug of the fixture (docs/e2e-setup.md). */
  readonly projectKey: string;
  readonly slug: string;
  readonly description: string;
  readonly website: string;
  readonly branches: readonly string[];
  readonly tags: readonly string[];
  readonly deployKeyTitle: string;
  readonly variable: { readonly name: string; readonly value: string };
  /** The planned target repository name `{project}-{repository}` (NAM-001). */
  readonly targetName: string;
}

export interface E2eContext {
  readonly target: 'fakes' | 'live';
  readonly fixture: FixtureExpectations;
  readonly bitbucket: {
    readonly baseUrl: string;
    /** Id of the source Endpoint in the app's configuration. */
    readonly endpointId: string;
    readonly workspace: string;
    readonly accountId: string;
    readonly email: string;
    readonly apiToken: string;
  };
  readonly github: {
    readonly baseUrl: string;
    readonly org: string;
    readonly appId: number;
    readonly installationId: number;
    readonly privateKey: string;
  };
  /**
   * Precondition checks (by id) that the provider fakes cannot answer. Honoured in the `fakes`
   * mode only; the `live` mode ignores it.
   */
  readonly skipChecks?: readonly string[] | undefined;
  /** The seeded Actor the spec signs in as. */
  readonly operatorEmail: string;
}

/** The fixture of docs/e2e-setup.md. */
export const LIVE_FIXTURE: FixtureExpectations = {
  projectKey: 'E2E',
  slug: 'e2e-auto-ok',
  description: 'git-migrator e2e fixture',
  website: 'https://example.com/e2e',
  branches: ['main', 'develop', 'feature/one'],
  tags: ['v1.0.0', 'v1.0.1'],
  deployKeyTitle: 'e2e-key',
  variable: { name: 'E2E_VAR', value: 'hello' },
  targetName: 'e2e-e2e-auto-ok',
};

export const OPERATOR_EMAIL = 'operator@test.local';

type Env = Readonly<Record<string, string | undefined>>;

interface Credential {
  readonly accountId: string;
  readonly email: string;
  readonly apiToken: string;
}

function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);
}

function parseCredentials(raw: string | undefined, problems: string[]): Credential | undefined {
  if (!raw) {
    problems.push(
      'BITBUCKET_CREDENTIALS is not set. Run `secretspec set BITBUCKET_CREDENTIALS --profile e2e` (docs/e2e-setup.md, section 3).',
    );
    return undefined;
  }
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    problems.push(
      'BITBUCKET_CREDENTIALS is not valid JSON. Expected [{"id","accountId","email","apiToken"}].',
    );
    return undefined;
  }
  const first = Array.isArray(list) ? (list[0] as Record<string, unknown> | undefined) : undefined;
  const text = (key: string) => (typeof first?.[key] === 'string' ? (first[key] as string) : '');
  if (!text('accountId') || !text('email') || !text('apiToken')) {
    problems.push(
      'BITBUCKET_CREDENTIALS needs a first entry with accountId, email and apiToken (docs/e2e-setup.md, section 1).',
    );
    return undefined;
  }
  return { accountId: text('accountId'), email: text('email'), apiToken: text('apiToken') };
}

/**
 * Builds the live context from `GM_CONFIG_FILE` and the secrets in the environment, and refuses
 * (fails closed) when the configuration does not look like real, dedicated test accounts.
 * @throws RefusedError listing every problem found.
 */
export function liveContext(
  env: Env,
  load: (env: Env) => Config = (e) => loadConfig({ env: e }),
): E2eContext {
  const problems: string[] = [];
  let config: Config | undefined;
  try {
    config = load(env);
  } catch (error) {
    if (error instanceof ConfigError) problems.push(error.message);
    else throw error;
  }
  const credential = parseCredentials(env.BITBUCKET_CREDENTIALS, problems);
  const privateKey = env.GITHUB_APP_PRIVATE_KEY ?? '';
  if (!privateKey.includes('PRIVATE KEY')) {
    problems.push(
      'GITHUB_APP_PRIVATE_KEY is not set or is not a PEM private key. Run `secretspec set GITHUB_APP_PRIVATE_KEY --profile e2e`.',
    );
  }
  if (!env.GM_TEST_USER_PASSWORD) {
    problems.push(
      'GM_TEST_USER_PASSWORD is not set. Run `secretspec set GM_TEST_USER_PASSWORD --profile e2e`.',
    );
  }
  if (!config) throw new RefusedError(problems);

  if (config.environment !== 'e2e') {
    problems.push(`the configuration sets environment "${config.environment}"; it must be "e2e".`);
  }
  if (!config.auth.testSignIn.enabled) {
    problems.push(
      'the configuration must set auth.testSignIn.enabled: true (the live e2e signs in through the test form).',
    );
  }
  const bitbuckets = config.endpoints.filter((endpoint) => endpoint.provider === 'bitbucket-cloud');
  const githubs = config.endpoints.filter((endpoint) => endpoint.provider === 'github');
  const bitbucket = bitbuckets[0];
  const github = githubs[0];
  if (bitbuckets.length !== 1 || githubs.length !== 1 || config.endpoints.length !== 2) {
    problems.push(
      'the configuration must have exactly one bitbucket-cloud and one github endpoint, and no other.',
    );
  }
  if (bitbucket && github) {
    const route = config.routes[0];
    if (
      config.routes.length !== 1 ||
      route?.source !== bitbucket.id ||
      route?.target !== github.id
    ) {
      problems.push(
        `the configuration must have exactly one Route, from ${bitbucket.id} to ${github.id}.`,
      );
    } else if (github.provider === 'github' && route.targetNamespace !== github.options.org) {
      problems.push(
        `the Route's targetNamespace is ${route.targetNamespace}, but the github endpoint's org is ${github.options.org}: the test would migrate into another organization.`,
      );
    }
  }
  for (const endpoint of [bitbucket, github]) {
    if (endpoint && isLoopback(endpoint.baseUrl)) {
      problems.push(
        `endpoint ${endpoint.id} points at ${endpoint.baseUrl}, a local address. The live e2e needs the real provider; use GM_E2E_TARGET=fakes for the fakes.`,
      );
    }
  }
  for (const [name, value] of [
    ['endpoints[].options.appId', github?.provider === 'github' ? github.options.appId : 1],
    [
      'endpoints[].options.installationId',
      github?.provider === 'github' ? github.options.installationId : 1,
    ],
  ] as const) {
    if (value <= 0) problems.push(`the configuration still has ${name}: 0; set the real ID.`);
  }
  const placeholders = [
    bitbucket?.provider === 'bitbucket-cloud' ? bitbucket.options.workspace : '',
    github?.provider === 'github' ? github.options.org : '',
    config.routes[0]?.targetNamespace ?? '',
  ].filter((value) => value.startsWith('<') || value.startsWith('CHANGE-ME'));
  if (placeholders.length > 0) {
    problems.push(`the configuration still holds placeholder values (${placeholders.join(', ')}).`);
  }
  if (
    bitbucket?.provider !== 'bitbucket-cloud' ||
    github?.provider !== 'github' ||
    !credential ||
    problems.length > 0
  ) {
    throw new RefusedError(problems);
  }
  return {
    target: 'live',
    fixture: LIVE_FIXTURE,
    bitbucket: {
      baseUrl: bitbucket.baseUrl,
      endpointId: bitbucket.id,
      workspace: bitbucket.options.workspace,
      accountId: credential.accountId,
      email: credential.email,
      apiToken: credential.apiToken,
    },
    github: {
      baseUrl: github.baseUrl,
      org: github.options.org,
      appId: github.options.appId,
      installationId: github.options.installationId,
      privateKey,
    },
    operatorEmail: OPERATOR_EMAIL,
  };
}
