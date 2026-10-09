import {
  FAKE_BITBUCKET_TOKEN,
  FAKE_OPERATOR_EMAIL,
  FAKE_PEM,
  SOURCE_ENDPOINT,
  startLiveStack,
  startStack,
} from '../harness/stack.ts';
import type { E2eContext } from '../src/live/context.ts';
import { assertPreconditions } from '../src/live/preconditions.ts';
import { CONTEXT_VARIABLE, contextFromEnv, portsFor } from '../src/live/runtime.ts';
import { resolveTarget, withAbsoluteConfig } from '../src/live/target.ts';

/**
 * Playwright global setup of the live e2e. It decides the target first (an invalid value or a live
 * run in CI stops here, TST-006), checks the preconditions (TST-031) and only then starts the
 * stack, so a missing fixture is reported before anything is created.
 *
 * - `fakes` (dry mode): the same stack as the UI tier, with the Octokit and Bitbucket clients of
 *   the spec pointed at the fakes through fake credentials.
 * - `live`: the worker and web app against the real accounts of `GM_CONFIG_FILE`.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const target = resolveTarget(process.env);
  if (target === 'fakes') {
    const stack = await startStack();
    try {
      const gh = stack.fakes.github;
      if (!gh) throw new Error('the fake GitHub did not start');
      const installationId = [...gh.state.installations.keys()][0] as number;
      // The account the fake Bitbucket answers `GET /2.0/user` with, for any valid token.
      const FAKE_TOKEN_ACCOUNT_ID = 'acct-000001';
      const context: E2eContext = {
        target: 'fakes',
        fixture: {
          projectKey: 'PLAT',
          slug: 'auto-ok',
          description: 'git-migrator e2e fixture',
          website: '',
          branches: ['main', 'develop', 'feature/one'],
          tags: ['v1.0.0', 'v1.0.1'],
          deployKeyTitle: 'e2e-key',
          variable: { name: 'E2E_VAR', value: 'hello' },
          targetName: 'plat-auto-ok',
        },
        bitbucket: {
          baseUrl: `http://127.0.0.1:${stack.fakes.bitbucket.port}`,
          endpointId: SOURCE_ENDPOINT,
          workspace: 'acme',
          accountId: FAKE_TOKEN_ACCOUNT_ID,
          email: FAKE_OPERATOR_EMAIL,
          apiToken: FAKE_BITBUCKET_TOKEN,
        },
        github: {
          baseUrl: `http://127.0.0.1:${gh.port}`,
          org: 'acme',
          appId: gh.state.ownApp.id,
          installationId,
          privateKey: FAKE_PEM,
        },
        operatorEmail: FAKE_OPERATOR_EMAIL,
        // What the fakes do not implement: the tag listing and file lookups of the source
        // API, and on the target the Actions variables and whatever was pushed over git (refs,
        // files, the branch protection read). The live mode has no such list.
        skipChecks: [
          'bitbucket-tags',
          'bitbucket-lfs',
          'github-variables',
          'github-refs',
          'github-contents',
          'github-protection',
        ],
      };
      process.env[CONTEXT_VARIABLE] = JSON.stringify(context);
      process.env.GM_E2E_BASE_URL = stack.baseUrl;
      return stack.stop;
    } catch (error) {
      await stack.stop();
      throw error;
    }
  }
  // One absolute path for every process: the web app runs from another directory.
  Object.assign(process.env, withAbsoluteConfig(process.env));
  const ctx = contextFromEnv(process.env);
  await assertPreconditions(ctx, portsFor(ctx));
  const stack = await startLiveStack(process.env);
  process.env.GM_E2E_BASE_URL = stack.baseUrl;
  return stack.stop;
}
