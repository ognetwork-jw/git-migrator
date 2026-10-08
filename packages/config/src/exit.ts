import { CONFIG_EXIT_CODE, ConfigError } from './errors.ts';
import { type LoadOptions, loadConfig } from './load.ts';
import type { Config } from './schema.ts';

export interface ExitOptions {
  /** Defaults to writing to standard error. */
  readonly write?: (text: string) => void;
  /** Defaults to `process.exit`. */
  readonly exit?: (code: number) => never;
}

/**
 * Loads the configuration for an entrypoint (web, worker, migrate). On a `ConfigError` it prints the
 * report to standard error and exits with status 78 (EX_CONFIG). Other errors are rethrown.
 */
export function loadConfigOrExit(options: LoadOptions & ExitOptions = {}): Config {
  const write = options.write ?? ((text: string) => void process.stderr.write(text));
  const exit = options.exit ?? ((code: number): never => process.exit(code));
  try {
    return loadConfig(options);
  } catch (error) {
    if (error instanceof ConfigError) {
      write(`${error.message}\n`);
      exit(CONFIG_EXIT_CODE);
    }
    throw error;
  }
}
