/**
 * Failure classification for git and git-lfs commands (ADP-050). Matches stable fragments of
 * stderr (ADR-0071), never exact wording, and scrubs the text with the adapter-sdk scrubbers
 * before it enters an error (ADP-071).
 */
import { AdapterError, type AdapterErrorCode, stripText } from '@git-migrator/adapter-sdk';

/** What failed, in the terms the Run engine turns into findings (LIF-049). */
export type GitFailureReason =
  | 'push-too-large'
  | 'blob-too-large'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'rejected'
  | 'invalid-refspec'
  | 'cancelled'
  | 'rate-limited'
  | 'network'
  | 'unknown';

export interface GitFailureClass {
  readonly code: AdapterErrorCode;
  readonly reason: GitFailureReason;
  readonly retryable: boolean;
}

const RULES: readonly (readonly [RegExp, GitFailureClass])[] = [
  [
    /HTTP 413|pack exceeds maximum|exceeds the maximum (?:allowed )?(?:push|pack)|push (?:is )?too large/i,
    { code: 'blocked_by_provider', reason: 'push-too-large', retryable: false },
  ],
  [
    // Provider codes are matched case-sensitively and anchored, so a repository or branch name
    // cannot imitate them.
    /error: GH001|Large files detected|exceeds .{0,40}file size limit|file size limit/,
    { code: 'blocked_by_provider', reason: 'blob-too-large', retryable: false },
  ],
  [
    /HTTP 429|rate limit|too many requests/i,
    { code: 'rate_limited', reason: 'rate-limited', retryable: true },
  ],
  [
    /Authentication failed|HTTP 401|error: 401|returned error: 401|terminal prompts disabled|could not read (?:Username|Password)|Invalid username or token|credentials .{0,30}not found/i,
    { code: 'unauthorized', reason: 'unauthorized', retryable: false },
  ],
  [
    /HTTP 403|error: 403|returned error: 403|access denied|permission to .{0,80} denied/i,
    { code: 'forbidden', reason: 'forbidden', retryable: false },
  ],
  [
    /HTTP 404|error: 404|returned error: 404|repository .{0,200}not found|does not appear to be a git repository/i,
    { code: 'not_found', reason: 'not-found', retryable: false },
  ],
  [
    /invalid refspec|matches more than one|src refspec .{0,200} does not match any/i,
    { code: 'invalid', reason: 'invalid-refspec', retryable: false },
  ],
  [
    /pre-receive hook declined|remote rejected|protected branch|\[rejected\]|non-fast-forward|hook declined/i,
    { code: 'blocked_by_provider', reason: 'rejected', retryable: false },
  ],
  [
    /Could not resolve host|Connection (?:refused|reset|timed out)|timed out|RPC failed|early EOF|unexpected disconnect|HTTP (?:5\d\d)|error: 5\d\d|returned error: 5\d\d|remote end hung up|Failed to connect|SSL_ERROR|gnutls_handshake/i,
    { code: 'transient', reason: 'network', retryable: true },
  ],
];

/** Unknown failures are retried: a push is idempotent and the retry budget is small. */
const UNKNOWN: GitFailureClass = { code: 'transient', reason: 'unknown', retryable: true };

/**
 * What classification may look at: URLs (they hold repository names) are removed, and porcelain
 * lines keep only their status and reason, not the refspec column (it holds ref names).
 */
export function scrubForClassification(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (line.startsWith('!\t')) {
        const [, , ...rest] = line.split('\t');
        return rest.join('\t');
      }
      return line.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>');
    })
    .join('\n');
}

export function classifyGitFailure(stderr: string): GitFailureClass {
  const text = scrubForClassification(stderr);
  for (const [pattern, klass] of RULES) if (pattern.test(text)) return klass;
  return UNKNOWN;
}

/**
 * `git push --porcelain` reports per-ref results on stdout (`!\t<refspec>\t[rejected] (reason)`),
 * and stderr only says "failed to push some refs". A rejection is a conflict the retry cannot
 * change, unless stderr names a more specific cause (size, authentication, rate limit).
 */
const SPECIFIC: ReadonlySet<GitFailureReason> = new Set([
  'push-too-large',
  'blob-too-large',
  'unauthorized',
  'forbidden',
  'not-found',
  'rate-limited',
  'invalid-refspec',
]);

export function classifyPushFailure(
  stdout: string,
  stderr: string,
): { klass: GitFailureClass; text: string } {
  const lines = stdout.split('\n').filter((line) => line.startsWith('!'));
  const text = lines.length > 0 ? `${stderr}\n${lines.join('\n')}` : stderr;
  const fromStderr = classifyGitFailure(stderr);
  if (lines.length === 0) return { klass: fromStderr, text };
  // A named cause in stderr (size, authentication, a dropped connection) beats the status lines.
  if (SPECIFIC.has(fromStderr.reason) || fromStderr.reason === 'network') {
    return { klass: fromStderr, text };
  }
  // `[remote failure]` means the far side never reported a result: try again.
  const statuses = lines.map((line) => line.split('\t')[2] ?? '');
  if (statuses.every((status) => status.startsWith('[remote failure]'))) {
    return { klass: { code: 'transient', reason: 'network', retryable: true }, text };
  }
  return { klass: { code: 'conflict', reason: 'rejected', retryable: false }, text };
}

const MAX_MESSAGE_CHARS = 2000;

/** An `AdapterError` for a failed git command, with `reason` for the engine. */
export class GitCommandError extends AdapterError {
  readonly reason: GitFailureReason;
  readonly operation: string;
  readonly exitCode: number;

  constructor(init: {
    readonly operation: string;
    readonly exitCode: number;
    readonly stderr: string;
    readonly secrets: readonly string[];
    readonly klass?: GitFailureClass;
  }) {
    const klass = init.klass ?? classifyGitFailure(init.stderr);
    const text = stripText(init.stderr.trim(), { secrets: init.secrets });
    const tail =
      text.length > MAX_MESSAGE_CHARS ? text.slice(text.length - MAX_MESSAGE_CHARS) : text;
    super({
      code: klass.code,
      provider: 'git',
      message: `git ${init.operation} failed (exit ${init.exitCode}, ${klass.reason}): ${tail}`,
      retryable: klass.retryable,
    });
    this.name = 'GitCommandError';
    this.reason = klass.reason;
    this.operation = init.operation;
    this.exitCode = init.exitCode;
  }
}

export function isGitCommandError(value: unknown): value is GitCommandError {
  return value instanceof GitCommandError;
}
