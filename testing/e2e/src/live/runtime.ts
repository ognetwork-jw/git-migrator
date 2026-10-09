import { type E2eContext, liveContext } from './context.ts';
import { type BitbucketApi, createBitbucketApi, createGithubApi, type GithubApi } from './ports.ts';
import { resolveTarget, withAbsoluteConfig } from './target.ts';

/** Environment variable through which the global setup hands the fakes' context to the workers. */
export const CONTEXT_VARIABLE = 'GM_E2E_CONTEXT';

/**
 * The context of this run. In the `fakes` mode the global setup built it from the running fakes
 * (fake credentials only) and put it in `GM_E2E_CONTEXT`; in the `live` mode it comes from the
 * configuration file and secretspec.
 * @throws RefusedError when the target is invalid or the live mode is not allowed.
 */
export function contextFromEnv(env: Readonly<Record<string, string | undefined>>): E2eContext {
  if (resolveTarget(env) === 'live') return liveContext(withAbsoluteConfig(env));
  const raw = env[CONTEXT_VARIABLE];
  if (!raw) throw new Error(`${CONTEXT_VARIABLE} is missing: the global setup did not run.`);
  return JSON.parse(raw) as E2eContext;
}

export interface Ports {
  readonly bitbucket: BitbucketApi;
  readonly github: GithubApi;
}

/** HTTP ports to the providers of the context (the fakes or the real accounts). */
export function portsFor(ctx: E2eContext): Ports {
  return {
    bitbucket: createBitbucketApi({
      baseUrl: ctx.bitbucket.baseUrl,
      email: ctx.bitbucket.email,
      apiToken: ctx.bitbucket.apiToken,
    }),
    github: createGithubApi(ctx.github),
  };
}
