import { App, Octokit } from 'octokit';

/** An HTTP answer. `json` is `undefined` when the body is empty or not JSON. */
export interface ApiResult {
  readonly status: number;
  readonly json: unknown;
}

/** Bitbucket Cloud REST, authenticated as the e2e account. Paths start with `/2.0/`. */
export interface BitbucketApi {
  request(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<ApiResult>;
}

/** GitHub REST as the App (JWT) or as its installation. A route looks like `GET /repos/{owner}/{repo}`. */
export interface GithubApi {
  asApp(route: string, params?: Record<string, unknown>): Promise<ApiResult>;
  asInstallation(route: string, params?: Record<string, unknown>): Promise<ApiResult>;
}

export interface BitbucketCredentials {
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
}

/** Basic auth with an API token (docs/providers/bitbucket-cloud.md). Errors never carry the token. */
export function createBitbucketApi(
  credentials: BitbucketCredentials,
  fetchImpl: typeof fetch = fetch,
): BitbucketApi {
  const authorization = `Basic ${Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString('base64')}`;
  const base = credentials.baseUrl.replace(/\/+$/, '');
  return {
    async request(method, path, body) {
      let response: Response;
      try {
        response = await fetchImpl(`${base}${path}`, {
          method,
          headers: {
            authorization,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${method} ${path} on ${base} failed: ${reason}`);
      }
      const text = await response.text();
      let json: unknown;
      try {
        json = text === '' ? undefined : JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: response.status, json };
    },
  };
}

export interface GithubCredentials {
  readonly baseUrl: string;
  readonly appId: number;
  readonly installationId: number;
  readonly privateKey: string;
}

/** App authentication through Octokit; errors become results, so callers can test for 404. */
export function createGithubApi(credentials: GithubCredentials): GithubApi {
  const app = new App({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    Octokit: Octokit.defaults({ baseUrl: credentials.baseUrl, userAgent: 'git-migrator-e2e' }),
  });
  const run = async (
    send: () => Promise<{ status: number; data: unknown }>,
  ): Promise<ApiResult> => {
    try {
      const { status, data } = await send();
      return { status, json: data };
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (typeof status === 'number') return { status, json: undefined };
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`the GitHub request failed: ${reason}`);
    }
  };
  return {
    asApp: (route, params) => run(() => app.octokit.request(route, params)),
    asInstallation: (route, params) =>
      run(async () => {
        const installation = await app.getInstallationOctokit(credentials.installationId);
        return installation.request(route, params);
      }),
  };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
