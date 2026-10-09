import { type Config, resolveConfig } from '@git-migrator/config';
import { describe, expect, it } from 'vitest';
import { liveContext } from './context.ts';
import { RefusedError } from './target.ts';

const YAML = `
environment: e2e
publicUrl: http://127.0.0.1:3000
auth: { testSignIn: { enabled: true } }
endpoints:
  - { id: bb, provider: bitbucket-cloud, options: { workspace: gm-e2e } }
  - { id: gh, provider: github, options: { org: gm-e2e-org, appId: 7, installationId: 9 } }
routes:
  - { id: r, source: bb, target: gh, targetNamespace: gm-e2e-org }
`;
const SECRETS = {
  BITBUCKET_CREDENTIALS: JSON.stringify([
    { id: 'e2e', accountId: 'acct-1', email: 'a@example.com', apiToken: 'x' },
  ]),
  GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
  GM_TEST_USER_PASSWORD: 'p',
};
const load =
  (yaml: string) =>
  (env: Record<string, string | undefined>): Config =>
    resolveConfig({ text: yaml, env });

function reasons(yaml: string, env: Record<string, string | undefined>): string {
  try {
    liveContext(env, load(yaml));
  } catch (error) {
    if (error instanceof RefusedError) return error.reasons.join('\n');
    throw error;
  }
  return '';
}

describe('live e2e context (TST-030, TST-031)', () => {
  it('[TST-030] reads the accounts from the configuration file and the secrets', () => {
    const ctx = liveContext(SECRETS, load(YAML));
    expect(ctx).toMatchObject({
      target: 'live',
      bitbucket: { workspace: 'gm-e2e', accountId: 'acct-1', baseUrl: 'https://api.bitbucket.org' },
      github: { org: 'gm-e2e-org', appId: 7, installationId: 9, baseUrl: 'https://api.github.com' },
      fixture: { projectKey: 'E2E', slug: 'e2e-auto-ok', targetName: 'e2e-e2e-auto-ok' },
    });
  });

  it('[TST-031] lists each missing secret with the command that sets it', () => {
    const found = reasons(YAML, {});
    expect(found).toMatch(/secretspec set BITBUCKET_CREDENTIALS --profile e2e/);
    expect(found).toMatch(/secretspec set GITHUB_APP_PRIVATE_KEY --profile e2e/);
    expect(found).toMatch(/secretspec set GM_TEST_USER_PASSWORD --profile e2e/);
  });

  it('[TST-006] refuses endpoints on local addresses (those are the fakes)', () => {
    const local = YAML.replace(
      'provider: github,',
      'provider: github, baseUrl: "http://127.0.0.1:4020",',
    );
    expect(reasons(local, SECRETS)).toMatch(/points at http:\/\/127\.0\.0\.1:4020/);
  });

  it('[TST-031] refuses the example placeholders and zero IDs', () => {
    const example = YAML.replace(
      'gm-e2e-org, appId: 7, installationId: 9',
      '<github-organization>, appId: 0, installationId: 0',
    );
    const found = reasons(example, SECRETS);
    expect(found).toMatch(/placeholder values/);
    expect(found).toMatch(/appId: 0/);
  });

  it('[TST-030] requires environment e2e and the test sign-in', () => {
    const wrong = YAML.replace('environment: e2e', 'environment: development').replace(
      'enabled: true',
      'enabled: false',
    );
    const found = reasons(wrong, SECRETS);
    expect(found).toMatch(/must be "e2e"/);
    expect(found).toMatch(/testSignIn.enabled: true/);
  });

  it('[TST-031] reports an invalid configuration as a refusal', () => {
    expect(reasons('endpoints: 3', SECRETS)).toMatch(/endpoints/);
  });

  it('[TST-031] ties the Route to the organization of the App', () => {
    const wrongOrg = YAML.replace('targetNamespace: gm-e2e-org', 'targetNamespace: other-org');
    expect(reasons(wrongOrg, SECRETS)).toMatch(/targetNamespace is other-org.*gm-e2e-org/);
    const twoRoutes = `${YAML}  - { id: r2, source: bb, target: gh, targetNamespace: gm-e2e-org }\n`;
    expect(reasons(twoRoutes, SECRETS)).toMatch(/exactly one Route/);
    const extra = YAML.replace(
      'routes:',
      '  - { id: gh2, provider: github, options: { org: other, appId: 1, installationId: 1 } }\nroutes:',
    );
    expect(reasons(extra, SECRETS)).toMatch(/exactly one bitbucket-cloud and one github endpoint/);
  });
});
