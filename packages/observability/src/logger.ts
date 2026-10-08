import { isSpanContextValid, trace } from '@opentelemetry/api';
import pino, { type Bindings, type DestinationStream, type Logger } from 'pino';
import { REDACT_PATHS, REDACTED, redactString, redactValue } from './redact.ts';

export type { Logger };

/** A sink for log lines: a pino destination, or any object with a `write(line)` method. */
export type LogSink = DestinationStream | { write(line: string): unknown };

export interface LoggerOptions {
  /** Pino level name. Defaults to `info`; `observability.logLevel` in the configuration. */
  readonly level?: string;
  /** Written as `service` on every line. Defaults to `git-migrator`. */
  readonly service?: string;
  /** Defaults to standard output, which is where the container runtime collects logs (DEP-050). */
  readonly destination?: LogSink;
}

type PinoChild = (this: unknown, bindings: Bindings, childOptions?: unknown) => Logger;

/** Trace fields added to every line while a span is active (DEP-050: `traceId`). */
function traceFields(): Record<string, string> {
  const context = trace.getActiveSpan()?.spanContext();
  return context && isSpanContextValid(context) ? { traceId: context.traceId } : {};
}

/**
 * Turns the arguments of one log call into values that contain no secrets. The first string is the
 * message and is scrubbed. Later strings are interpolation or extra text and are replaced
 * entirely, because a positional value has no key to judge it by (ADR-0052). Errors are sent under
 * `err`; when the call has no message, the error message becomes the message.
 */
function redactArguments(args: unknown[]): unknown[] {
  const out: unknown[] = [];
  let errorMessage: string | undefined;
  let hasMessage = false;
  for (const arg of args) {
    if (arg instanceof Error) {
      out.push({ err: redactValue(arg) });
      errorMessage ??= redactString(arg.message);
    } else if (typeof arg === 'string') {
      out.push(hasMessage ? REDACTED : redactString(arg));
      hasMessage = true;
    } else {
      out.push(redactValue(arg));
    }
  }
  if (errorMessage !== undefined && !hasMessage) out.push(errorMessage);
  return out;
}

/**
 * The application logger: pino JSON lines with `level`, `time`, `msg`, `service`, `traceId` and the
 * fields each caller binds with `child()` (DEP-050). Every value is scrubbed before it is written:
 * the message, the arguments, child bindings and nested objects. See ADR-0052.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const destination = options.destination as DestinationStream | undefined;
  const logger = pino(
    {
      level: options.level ?? 'info',
      base: { service: options.service ?? 'git-migrator' },
      messageKey: 'msg',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
        bindings: (bindings) => redactValue(bindings) as Record<string, unknown>,
      },
      // Values are scrubbed before pino sees them, so its default `err` serializer (which would
      // rewrite the type and drop properties) is replaced by the identity.
      serializers: { err: (value: unknown) => value },
      hooks: {
        logMethod(args, method) {
          method.apply(this, redactArguments(args) as Parameters<typeof method>);
        },
      },
      mixin: traceFields,
      redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    },
    destination,
  );
  // Pino resets its bindings formatter for children, so child bindings are scrubbed here. `this` is
  // the logger that `child` was called on, so grandchildren are covered too.
  const pinoChild: unknown = logger.child;
  const scrubbedChild = function scrubbedChild(
    this: unknown,
    bindings: Bindings,
    childOptions?: unknown,
  ): Logger {
    return (pinoChild as PinoChild).call(this, redactValue(bindings) as Bindings, childOptions);
  };
  logger.child = scrubbedChild as unknown as typeof logger.child;
  return logger;
}
