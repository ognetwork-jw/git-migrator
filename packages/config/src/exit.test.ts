import { describe, expect, it } from 'vitest';
import { loadConfigOrExit } from './exit.ts';

class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const exitStub = (code: number): never => {
  throw new Exited(code);
};

describe('entrypoint configuration exit (ARC-030)', () => {
  it('[ARC-030] returns the configuration when it is valid and writes nothing', () => {
    const written: string[] = [];
    const config = loadConfigOrExit({
      env: {},
      write: (text) => written.push(text),
      exit: exitStub,
    });
    expect(config.environment).toBe('development');
    expect(written).toEqual([]);
  });

  it('[ARC-030] prints the report to the given writer and exits with status 78', () => {
    const written: string[] = [];
    let thrown: unknown;
    try {
      loadConfigOrExit({
        env: { GM_PUBLIC_URL: 'not a url' },
        write: (text) => written.push(text),
        exit: exitStub,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Exited);
    expect((thrown as Exited).code).toBe(78);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('Invalid git-migrator configuration: 1 problem.');
    expect(written[0]).toContain('publicUrl: must be an http or https URL (set by GM_PUBLIC_URL)');
    expect(written[0]?.endsWith('\n')).toBe(true);
  });

  it('[ARC-030] rethrows errors that are not configuration errors', () => {
    const env = new Proxy({} as Record<string, string>, {
      get: () => {
        throw new TypeError('not a config problem');
      },
    });
    expect(() => loadConfigOrExit({ env, exit: exitStub, write: () => undefined })).toThrow(
      TypeError,
    );
  });

  it('[ARC-030] an unreadable configuration file exits with status 78 and names the file', () => {
    const written: string[] = [];
    expect(() =>
      loadConfigOrExit({
        env: { GM_CONFIG_FILE: '/x.yaml' },
        readFile: () => {
          throw new Error('ENOENT');
        },
        exit: exitStub,
        write: (text) => written.push(text),
      }),
    ).toThrow(Exited);
    expect(written[0]).toContain('cannot read the file named by GM_CONFIG_FILE (ENOENT)');
    expect(written[0]).toContain('Fix the file /x.yaml');
  });
});
