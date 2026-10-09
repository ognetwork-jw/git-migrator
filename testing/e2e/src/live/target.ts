import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which stack the live e2e spec runs against (TST-030). `fakes` is the "dry" mode: the same spec
 * and the same checks, against the provider fakes, which is what CI runs. `live` calls the real
 * providers and is only ever started by a human.
 */
export type E2eTarget = 'fakes' | 'live';

/** Thrown when the run must not start. The message says what to change. */
export class RefusedError extends Error {
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(`Refusing to run:\n${reasons.map((reason) => `  - ${reason}`).join('\n')}`);
    this.name = 'RefusedError';
    this.reasons = reasons;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/** Variables that CI systems set. Any non-empty value counts, even "false": fail closed. */
export const CI_VARIABLES = [
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'JENKINS_URL',
  'TF_BUILD',
  'TEAMCITY_VERSION',
  'CODEBUILD_BUILD_ID',
  'BITBUCKET_BUILD_NUMBER',
  'CIRCLECI',
  'DRONE',
  'BUILD_ID',
];

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * The absolute path `GM_CONFIG_FILE` names. A relative value is looked up from the working
 * directory (`testing/e2e` for the package scripts) and then from the repository root (the form
 * TST-030 uses). `undefined` when it names nothing that exists.
 */
export function resolveConfigFile(
  value: string,
  exists: (path: string) => boolean = existsSync,
  cwd: string = process.cwd(),
): string | undefined {
  const candidates = isAbsolute(value) ? [value] : [resolve(cwd, value), resolve(REPO_ROOT, value)];
  return candidates.find((path) => exists(path));
}

/**
 * The environment with `GM_CONFIG_FILE` made absolute, once, before anything uses it: the web app
 * runs from another directory, where a relative path would name nothing. Unchanged when the file
 * cannot be found (the guard reports that).
 */
export function withAbsoluteConfig(
  env: Readonly<Record<string, string | undefined>>,
  exists?: (path: string) => boolean,
  cwd?: string,
): Record<string, string | undefined> {
  const file = env.GM_CONFIG_FILE;
  const found = file ? resolveConfigFile(file, exists, cwd) : undefined;
  return found ? { ...env, GM_CONFIG_FILE: found } : { ...env };
}

/** Reasons the live mode must not start in this environment (TST-006). Empty means allowed. */
export function liveRefusals(env: Env, exists: (path: string) => boolean = existsSync): string[] {
  const reasons: string[] = [];
  const ci = CI_VARIABLES.filter((name) => (env[name] ?? '') !== '');
  if (ci.length > 0) {
    reasons.push(
      `the live e2e never runs in CI (${ci.join(', ')} is set). CI runs the dry mode with GM_E2E_TARGET=fakes.`,
    );
  }
  if (env.GM_ENVIRONMENT !== undefined && env.GM_ENVIRONMENT !== 'e2e') {
    // The provider HTTP client refuses real hosts when GM_ENVIRONMENT=test (TST-006).
    reasons.push(
      `GM_ENVIRONMENT is "${env.GM_ENVIRONMENT}". Leave it unset: the configuration file sets "e2e".`,
    );
  }
  const file = env.GM_CONFIG_FILE;
  if (!file) {
    reasons.push(
      'GM_CONFIG_FILE is not set. Point it at testing/e2e/live/config.e2e.yaml (copy config.e2e.example.yaml; see docs/e2e-setup.md).',
    );
  } else if (!resolveConfigFile(file, exists)) {
    reasons.push(
      `GM_CONFIG_FILE names ${file}, which does not exist. Copy testing/e2e/live/config.e2e.example.yaml to it and fill it in (docs/e2e-setup.md).`,
    );
  }
  return reasons;
}

/**
 * Reads `GM_E2E_TARGET`. It has no default: an unset or unknown value is an error, so a typo can
 * never select the live mode and a missing value never selects anything.
 * @throws RefusedError when the value is invalid or the live mode is not allowed here.
 */
export function resolveTarget(env: Env, exists?: (path: string) => boolean): E2eTarget {
  const value = env.GM_E2E_TARGET;
  if (value === 'fakes') return 'fakes';
  if (value === 'live') {
    const reasons = liveRefusals(env, exists);
    if (reasons.length > 0) throw new RefusedError(reasons);
    return 'live';
  }
  throw new RefusedError([
    `GM_E2E_TARGET must be "fakes" (dry mode, against the provider fakes) or "live" (real accounts, human only); it is ${value === undefined ? 'unset' : `"${value}"`}.`,
  ]);
}
