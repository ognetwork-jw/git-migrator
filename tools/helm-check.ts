/**
 * `pnpm helm:check` (DEP-033): lints the chart, renders it with every `ci/*.yaml` value file and
 * validates the output with `kubeconform -strict`, then runs the helm-unittest suites.
 *
 * Usage: node tools/helm-check.ts [--chart <dir>] [--kube-version <x.y.z>] [--require-unittest]
 *
 * `helm` and `kubeconform` are required (devenv provides them). helm-unittest is the standalone
 * `helm-unittest` binary or the `helm unittest` plugin. Without it the run warns and still passes,
 * unless `--require-unittest` is given or CI is set (the CI job always installs it).
 * Exit codes: 0 ok, 1 a check failed or a required tool is missing, 2 usage error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Kubernetes version the rendered manifests are validated against: the current AKS default.
 * Bump it, and the schema check with it, when AKS moves its default (ADR-0291).
 */
export const KUBERNETES_VERSION = '1.34.0';

export const DEFAULT_CHART = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'deploy',
  'helm',
  'git-migrator',
);

export interface HelmCheckOptions {
  readonly chart: string;
  readonly kubeVersion: string;
  readonly requireUnittest: boolean;
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): HelmCheckOptions {
  let chart = DEFAULT_CHART;
  let kubeVersion = KUBERNETES_VERSION;
  let requireUnittest = Boolean(env.CI);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--chart' || arg === '--kube-version') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--chart') chart = resolve(value);
      else if (/^\d+\.\d+\.\d+$/.test(value)) kubeVersion = value;
      else throw new Error('--kube-version must look like 1.34.0');
    } else if (arg === '--require-unittest') requireUnittest = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return { chart, kubeVersion, requireUnittest };
}

/** The value files under `<chart>/ci`, sorted, as absolute paths. */
export function ciValueFiles(chart: string): string[] {
  const dir = join(chart, 'ci');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yaml'))
    .sort()
    .map((name) => join(dir, name));
}

export function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

interface Step {
  readonly label: string;
  readonly ok: boolean;
}

function run(
  command: string,
  args: readonly string[],
  input?: string,
): Step & { out: string; stdout: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  const stdout = result.stdout ?? '';
  const out = `${stdout}${result.stderr ?? ''}`;
  return { label: `${basename(command)} ${args.join(' ')}`, ok: result.status === 0, out, stdout };
}

/** Runs every check. Returns the process exit code. */
export function helmCheck(
  options: HelmCheckOptions,
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): number {
  const helm = findOnPath('helm', env);
  const kubeconform = findOnPath('kubeconform', env);
  const missing = [helm ? '' : 'helm', kubeconform ? '' : 'kubeconform'].filter(Boolean);
  if (!helm || !kubeconform) {
    log(`helm:check: missing tools on PATH: ${missing.join(', ')} (devenv shell provides them)`);
    return 1;
  }
  const valueFiles = ciValueFiles(options.chart);
  if (valueFiles.length === 0) {
    log(`helm:check: no value files in ${join(options.chart, 'ci')}`);
    return 1;
  }
  let failed = false;
  const report = (step: Step & { out: string; stdout: string }): void => {
    log(`${step.ok ? 'ok  ' : 'FAIL'} ${step.label}`);
    if (!step.ok) {
      failed = true;
      log(step.out.trimEnd());
    }
  };
  for (const file of valueFiles) {
    report(run(helm, ['lint', options.chart, '--strict', '-f', file]));
    const rendered = run(helm, [
      'template',
      'check',
      options.chart,
      '-f',
      file,
      '--kube-version',
      options.kubeVersion,
    ]);
    report(rendered);
    if (rendered.ok) {
      report(
        run(
          kubeconform,
          ['-strict', '-summary', '-kubernetes-version', options.kubeVersion],
          rendered.stdout,
        ),
      );
    }
  }
  const unittestBinary = findOnPath('helm-unittest', env);
  const plugin = unittestBinary
    ? undefined
    : run(helm, ['unittest', '--help']).ok
      ? 'plugin'
      : undefined;
  if (unittestBinary) report(run(unittestBinary, [options.chart]));
  else if (plugin) report(run(helm, ['unittest', options.chart]));
  else if (options.requireUnittest) {
    log(
      'FAIL helm-unittest is not installed (binary `helm-unittest` or the `helm unittest` plugin)',
    );
    failed = true;
  } else {
    log('warn helm-unittest is not installed: the unit-test suites were not run');
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exit(helmCheck(parseArgs(process.argv.slice(2), process.env)));
  } catch (error) {
    process.stderr.write(`helm:check: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
