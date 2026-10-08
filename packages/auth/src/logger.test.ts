import { createLogger } from '@git-migrator/observability';
import { describe, expect, it } from 'vitest';
import { betterAuthLogger, MAX_LOGGED_TEXT, scrubEmails } from './logger.ts';

interface Line {
  msg?: string;
  component?: string;
  err?: Record<string, unknown>;
  args?: unknown[];
}

function capture() {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', destination: { write: (l) => lines.push(l) } });
  return {
    log: betterAuthLogger(logger),
    lines,
    parsed: () => lines.map((l) => JSON.parse(l) as Line),
  };
}

describe('Better Auth logger adapter (DEP-050)', () => {
  it('[DEP-050] a huge address-like string is scrubbed in bounded time', () => {
    const { log, lines } = capture();
    const huge = `${'a'.repeat(50_000)}@${'b'.repeat(50_000)}`;
    const started = performance.now();
    log.log('error', huge, { callbackURL: huge }, huge);
    expect(performance.now() - started).toBeLessThan(200);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.length).toBeLessThan(4 * MAX_LOGGED_TEXT);
    expect(lines[0]).toContain('[truncated ');
  });

  it('[DEP-050] scrubEmails itself is linear on a long run of address characters', () => {
    const started = performance.now();
    scrubEmails(`${'a'.repeat(50_000)}@${'b'.repeat(50_000)}.${'c'.repeat(50_000)}`);
    expect(performance.now() - started).toBeLessThan(200);
    expect(scrubEmails('mail ada@example.test now')).toBe('mail [REDACTED] now');
    expect(scrubEmails('see https://x.example/u/ada@example.test/z')).toBe(
      'see https://x.example/u/[REDACTED]/z',
    );
  });

  it('[DEP-050] a cut never leaves half an address behind', () => {
    const { log, parsed } = capture();
    const text = `${'x '.repeat((MAX_LOGGED_TEXT - 10) / 2)}someone.long@example.test`;
    log.log('info', text);
    const msg = parsed()[0]?.msg ?? '';
    expect(msg).not.toContain('someone');
    expect(msg).toContain('[truncated ');
  });

  it('[DEP-050] a non-string message is logged and never throws', () => {
    const { log, parsed } = capture();
    expect(() => log.log('warn', 42 as unknown as string)).not.toThrow();
    expect(() =>
      log.log('warn', {
        toString: () => {
          throw new Error('no');
        },
      } as unknown as string),
    ).not.toThrow();
    expect(parsed().map((l) => l.msg)).toEqual(['42', '[Unprintable]']);
  });

  it('[DEP-050] a throwing getter does not throw into the caller and the other fields survive', () => {
    const { log, parsed } = capture();
    const value = {
      ok: 'kept',
      get bad(): string {
        throw new Error('getter');
      },
    };
    expect(() => log.log('error', 'getter test', value)).not.toThrow();
    expect(parsed()[0]?.args).toEqual([{ ok: 'kept', bad: '[Unreadable]' }]);
  });

  it('[DEP-050] self-references and shared objects are cheap and do not throw', () => {
    const { log, parsed } = capture();
    const self: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) self[`k${i}`] = self;
    // Every level shares one child ten times: 10^6 paths without a value budget.
    let shared: Record<string, unknown> = { leaf: 'x' };
    for (let level = 0; level < 6; level++) {
      const next: Record<string, unknown> = {};
      for (let i = 0; i < 10; i++) next[`k${i}`] = shared;
      shared = next;
    }
    const started = performance.now();
    expect(() => log.log('info', 'graph', self, shared)).not.toThrow();
    expect(performance.now() - started).toBeLessThan(200);
    const [first] = (parsed()[0]?.args ?? []) as [Record<string, unknown>];
    expect(Object.values(first)).toEqual(Array(10).fill('[Circular]'));
  });

  it('[DEP-050] an error keeps its type and own fields such as code (as errorKind), detail and constraint, scrubbed', () => {
    const { log, parsed } = capture();
    class DatabaseError extends Error {
      code = '23505';
      detail = 'Key (email)=(ada@example.test) already exists.';
      constraint = 'user_email_key';
    }
    const error = new DatabaseError('duplicate key for bob@example.test');
    log.log(
      'error',
      'insert failed',
      error,
      new Date(0),
      new URL('https://x.example/carol@example.test'),
    );
    const line = parsed()[0];
    expect(line?.err).toMatchObject({
      type: 'DatabaseError',
      errorKind: '23505',
      detail: 'Key (email)=([REDACTED]) already exists.',
      constraint: 'user_email_key',
      message: 'duplicate key for [REDACTED]',
    });
    expect(line?.args?.[0]).toBe(new Date(0).toString());
    expect(String(line?.args?.[1])).not.toContain('carol@');
  });

  it('[DEP-050] an unknown level falls back to error instead of throwing', () => {
    const { log, parsed } = capture();
    expect(() => log.log('fatal' as 'error', 'odd level')).not.toThrow();
    expect(parsed()[0]?.msg).toBe('odd level');
  });
});
