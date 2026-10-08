import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { applyEnvOverrides } from './env.ts';
import { ConfigError, type ConfigIssue } from './errors.ts';
import { type Config, ConfigSchema } from './schema.ts';

export interface ResolveInput {
  /** Text of the configuration file, or `undefined` when no file is configured. */
  readonly text?: string | undefined;
  readonly fileName?: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Receives warnings. Defaults to standard error. */
  readonly warn?: ((message: string) => void) | undefined;
}

/**
 * Parses, overrides and validates a configuration without touching the file system (ARC-030).
 * Order: YAML document, then GM_* overrides, then the Zod schema with its defaults.
 * @throws ConfigError when the YAML is malformed, is not a mapping, or fails validation.
 */
export function resolveConfig(input: ResolveInput): Config {
  const context = { fileName: input.fileName };
  let document: Record<string, unknown> = {};

  if (input.text !== undefined) {
    const parsed = parseDocument(input.text, { uniqueKeys: true });
    if (parsed.errors.length > 0) {
      throw new ConfigError(
        parsed.errors.map((error) => ({
          path: '',
          message: `is not valid YAML: ${error.message.split('\n')[0] ?? error.message}`,
        })),
        context,
      );
    }
    let data: unknown;
    try {
      data = parsed.toJS();
    } catch (error) {
      // Alias expansion can fail (for example an alias bomb); that is a bad file, not a crash.
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      throw new ConfigError([{ path: '', message: `is not valid YAML: ${reason}` }], context);
    }
    if (data === null || data === undefined) {
      document = {};
    } else if (typeof data === 'object' && !Array.isArray(data)) {
      document = data as Record<string, unknown>;
    } else {
      throw new ConfigError(
        [{ path: '', message: 'must be a mapping of configuration keys' }],
        context,
      );
    }
  }

  const { value, applied } = applyEnvOverrides(document, input.env);
  const result = ConfigSchema.safeParse(value);
  if (result.success) {
    warnIfDefaultedEnvironmentIsUnsafe(result.data, value, applied, input.warn);
    return result.data;
  }

  const issues: ConfigIssue[] = result.error.issues.map((issue) => {
    const path = formatPath(issue.path);
    const envVar = applied.get(path);
    return envVar === undefined
      ? { path, message: issue.message }
      : { path, message: issue.message, envVar };
  });
  throw new ConfigError(issues, context);
}

/**
 * `environment` defaults to `development` (ADR-0051). When nothing sets it, a configuration that
 * enables test sign-in or uses plain http is probably a production file that lost its environment.
 * That is reported loudly; the start still succeeds, because the spec default is kept.
 */
function warnIfDefaultedEnvironmentIsUnsafe(
  config: Config,
  document: unknown,
  applied: ReadonlyMap<string, string>,
  warn: ((message: string) => void) | undefined,
): void {
  const explicit =
    applied.has('environment') || (isObjectWith(document) && 'environment' in document);
  if (explicit) return;
  const risky: string[] = [];
  if (config.auth.testSignIn.enabled) risky.push('auth.testSignIn.enabled is true');
  // The default public URL is plain http for local development, so only an explicit one counts.
  const urlSet = applied.has('publicUrl') || (isObjectWith(document) && 'publicUrl' in document);
  if (urlSet && config.publicUrl.startsWith('http://')) risky.push('publicUrl uses http');
  if (risky.length === 0) return;
  const message = [
    'WARNING: environment is not set, so it defaults to "development" (ADR-0051), but',
    `${risky.join(' and ')}. If this is a production deployment, set GM_ENVIRONMENT=production.`,
  ].join(' ');
  (warn ?? ((text: string) => void process.stderr.write(`${text}\n`)))(message);
}

function isObjectWith(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Converts a Zod issue path to `endpoints[0].options.appId`. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

export interface LoadOptions {
  /** Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Receives warnings. Defaults to standard error. */
  readonly warn?: (message: string) => void;
  /** Defaults to reading UTF-8 text from disk. Injected by tests. */
  readonly readFile?: (path: string) => string;
}

/**
 * Loads the runtime configuration (DEP-040). The file is named by GM_CONFIG_FILE. When that variable
 * is unset, the configuration is the defaults plus any GM_* overrides, which suits local development.
 * @throws ConfigError with every problem found; a file that cannot be read is also a ConfigError.
 */
export function loadConfig(options: LoadOptions = {}): Config {
  const env = options.env ?? process.env;
  const fileName = env.GM_CONFIG_FILE || undefined;
  let text: string | undefined;
  if (fileName !== undefined) {
    const read = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
    try {
      text = read(fileName);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ConfigError(
        [{ path: '', message: `cannot read the file named by GM_CONFIG_FILE (${reason})` }],
        { fileName },
      );
    }
  }
  return resolveConfig({ text, fileName, env, warn: options.warn });
}
