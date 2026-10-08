import { describe, expect, it } from 'vitest';
import { CONFIG_EXIT_CODE, ConfigError, formatConfigReport } from './errors.ts';

describe('configuration error report (ARC-030)', () => {
  it('[ARC-030] lists each problem on its own line with its key path', () => {
    const report = formatConfigReport([
      { path: 'publicUrl', message: 'must be an http or https URL' },
      { path: 'endpoints[0].options.appId', message: 'must be a whole number' },
    ]);
    expect(report).toBe(
      [
        'Invalid git-migrator configuration: 2 problems.',
        '  - publicUrl: must be an http or https URL',
        '  - endpoints[0].options.appId: must be a whole number',
        'Fix the configuration, then start the process again.',
      ].join('\n'),
    );
  });

  it('[ARC-030] uses the singular for one problem and names the file that was read', () => {
    const report = formatConfigReport([{ path: 'metrics.port', message: 'must be a number' }], {
      fileName: '/etc/git-migrator/config.yaml',
    });
    expect(report.split('\n')[0]).toBe('Invalid git-migrator configuration: 1 problem.');
    expect(report.split('\n').at(-1)).toBe(
      'Fix the file /etc/git-migrator/config.yaml, then start the process again.',
    );
  });

  it('[ARC-030] names the GM_* variable that set a value and points at it in the advice', () => {
    const report = formatConfigReport([
      { path: 'publicUrl', message: 'must be an http or https URL', envVar: 'GM_PUBLIC_URL' },
    ]);
    expect(report).toContain('  - publicUrl: must be an http or https URL (set by GM_PUBLIC_URL)');
    expect(report).toContain('or the GM_* variables named above');
  });

  it('[ARC-030] reports a problem at the document root as (document)', () => {
    expect(
      formatConfigReport([{ path: '', message: 'must be a mapping of configuration keys' }]),
    ).toContain('  - (document): must be a mapping of configuration keys');
  });

  it('[ARC-030] ConfigError carries the issues and the rendered report as its message', () => {
    const issues = [{ path: 'git.maxPushBytes', message: 'must be greater than 0' }];
    const error = new ConfigError(issues, { fileName: 'c.yaml' });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ConfigError');
    expect(error.issues).toEqual(issues);
    expect(error.message).toContain('  - git.maxPushBytes: must be greater than 0');
  });

  it('[ARC-030] the entrypoint exit status for configuration errors is 78 (EX_CONFIG)', () => {
    expect(CONFIG_EXIT_CODE).toBe(78);
  });
});
