/** One problem found while loading the configuration. `path` is `''` for the document root. */
export interface ConfigIssue {
  /** Dotted key path, with `[n]` for list items, for example `endpoints[0].options.appId`. */
  readonly path: string;
  readonly message: string;
  /** Set when the value came from a GM_* environment override. */
  readonly envVar?: string;
}

export interface ConfigReportContext {
  /** The configuration file that was read, when one was given through GM_CONFIG_FILE. */
  readonly fileName?: string | undefined;
}

/** Exit status for an invalid configuration (sysexits.h EX_CONFIG). */
export const CONFIG_EXIT_CODE = 78;

/** Renders the issues as a report an operator can act on, one problem per line. */
export function formatConfigReport(
  issues: readonly ConfigIssue[],
  context: ConfigReportContext = {},
): string {
  const count = issues.length === 1 ? '1 problem' : `${issues.length} problems`;
  const lines = [`Invalid git-migrator configuration: ${count}.`];
  for (const issue of issues) {
    const where = issue.path === '' ? '(document)' : issue.path;
    const source = issue.envVar ? ` (set by ${issue.envVar})` : '';
    lines.push(`  - ${where}: ${issue.message}${source}`);
  }
  const file = context.fileName ? `the file ${context.fileName}` : 'the configuration';
  lines.push(
    `Fix ${file}${issues.some((issue) => issue.envVar) ? ' or the GM_* variables named above' : ''}, then start the process again.`,
  );
  return lines.join('\n');
}

/** Thrown when the configuration file or the merged configuration is invalid. */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[], context: ConfigReportContext = {}) {
    super(formatConfigReport(issues, context));
    this.name = 'ConfigError';
    this.issues = issues;
  }
}
