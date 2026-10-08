/**
 * Pack size estimates for the batched push (LIF-044). The estimate for "everything reachable from
 * `include` that is not reachable from `exclude`" uses `git rev-list --objects --disk-usage` when
 * git has it (2.31 and later), and otherwise counts the bytes of `git pack-objects --revs --stdout`.
 */
import type { GitContext, GitRunner } from './runner.ts';

/** Bytes a push of `include` would send when the receiver already has `exclude`. */
export type PackEstimator = (
  include: readonly string[],
  exclude: readonly string[],
) => Promise<number>;

export type EstimatorMode = 'disk-usage' | 'pack-objects';

/** `rev-list --disk-usage` arrived in git 2.31. */
export function supportsDiskUsage(versionOutput: string): boolean {
  const match = /git version (\d+)\.(\d+)/.exec(versionOutput);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 2 || (major === 2 && minor >= 31);
}

export async function detectEstimatorMode(
  runner: GitRunner,
  context: GitContext,
): Promise<EstimatorMode> {
  const result = await runner.run(context, ['version'], { check: false });
  return result.code === 0 && supportsDiskUsage(result.stdout) ? 'disk-usage' : 'pack-objects';
}

export function createPackEstimator(
  runner: GitRunner,
  context: GitContext,
  options: { dir: string; mode: EstimatorMode; signal?: AbortSignal },
): PackEstimator {
  const common = {
    cwd: options.dir,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
  return async (include, exclude) => {
    if (include.length === 0) return 0;
    if (options.mode === 'disk-usage') {
      const input = `${[...include, ...exclude.map((sha) => `^${sha}`)].join('\n')}\n`;
      const result = await runner.run(
        context,
        ['rev-list', '--objects', '--disk-usage', '--stdin'],
        { ...common, input, operation: 'rev-list --disk-usage' },
      );
      const bytes = Number(result.stdout.trim());
      if (!Number.isFinite(bytes)) throw new Error('git rev-list --disk-usage printed no size');
      return bytes;
    }
    const lines = exclude.length > 0 ? [...include, '--not', ...exclude] : [...include];
    const result = await runner.run(
      context,
      ['pack-objects', '--revs', '--stdout', '--thin', '--quiet'],
      { ...common, input: `${lines.join('\n')}\n`, discardStdout: true, operation: 'pack-objects' },
    );
    return result.stdoutBytes;
  };
}
