import { describe, expect, it } from 'vitest';
import { classifyGitFailure, classifyPushFailure, GitCommandError } from './errors.ts';

describe('git failure classification (ADR-0071 fragments)', () => {
  it.each([
    [
      'error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413',
      'push-too-large',
      'blocked_by_provider',
      false,
    ],
    ['remote: error: GH001: Large files detected.', 'blob-too-large', 'blocked_by_provider', false],
    ["fatal: Authentication failed for 'http://x/'", 'unauthorized', 'unauthorized', false],
    [
      'fatal: could not read Username for http://x: terminal prompts disabled',
      'unauthorized',
      'unauthorized',
      false,
    ],
    ['The requested URL returned error: 403', 'forbidden', 'forbidden', false],
    ["fatal: repository 'http://x/a.git/' not found", 'not-found', 'not_found', false],
    [
      ' ! [remote rejected] main -> main (pre-receive hook declined)',
      'rejected',
      'blocked_by_provider',
      false,
    ],
    ['fatal: unable to access: Could not resolve host: x', 'network', 'transient', true],
    ['error: RPC failed; HTTP 503 curl 22', 'network', 'transient', true],
    ['error: HTTP 429 too many requests', 'rate-limited', 'rate_limited', true],
    ['something nobody has seen', 'unknown', 'transient', true],
  ])('[ADP-050] %s', (stderr, reason, code, retryable) => {
    expect(classifyGitFailure(stderr)).toEqual({ code, reason, retryable });
  });

  it('[ADP-071] the error message is scrubbed of the credential, URL userinfo and token shapes', () => {
    const secret = 'pw-0123456789-secret';
    const basic = Buffer.from(`bot:${secret}`).toString('base64');
    const error = new GitCommandError({
      operation: 'push',
      exitCode: 128,
      stderr: `fatal: unable to access 'https://bot:${secret}@host.example/a.git/': The requested URL returned error: 401 Authorization: Basic ${basic}`,
      secrets: [secret, `bot:${secret}`],
    });
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain(basic);
    expect(error.message).toContain('git push failed (exit 128, unauthorized)');
    expect(error).toMatchObject({
      code: 'unauthorized',
      reason: 'unauthorized',
      provider: 'git',
      retryable: false,
    });
  });

  it('[ADP-071] long stderr is cut to its tail', () => {
    const error = new GitCommandError({
      operation: 'clone',
      exitCode: 1,
      stderr: `${'x'.repeat(10_000)}END`,
      secrets: [],
    });
    expect(error.message.length).toBeLessThan(2200);
    expect(error.message.endsWith('END')).toBe(true);
  });
});

describe('classifyPushFailure (porcelain output)', () => {
  const failed = 'error: failed to push some refs to http://x/a.git';

  it('[LIF-044] a rejected ref is a non-retryable conflict and the text names the ref and reason', () => {
    const out = '!\tabc:refs/heads/main\t[rejected] (non-fast-forward)\nDone';
    const { klass, text } = classifyPushFailure(out, failed);
    expect(klass).toEqual({ code: 'conflict', reason: 'rejected', retryable: false });
    expect(text).toContain('refs/heads/main');
    expect(text).toContain('non-fast-forward');
  });

  it('[LIF-044] a remote rejection by a hook or rule is a conflict too', () => {
    const out = '!\tabc:refs/heads/main\t[remote rejected] (pre-receive hook declined)\n';
    expect(classifyPushFailure(out, failed).klass.reason).toBe('rejected');
    const rule =
      '!\tabc:refs/heads/main\t[remote rejected] (push declined due to repository rule violations)\n';
    expect(classifyPushFailure(rule, failed)).toMatchObject({
      klass: { retryable: false, code: 'conflict' },
    });
  });

  it('[LIF-044] a more specific cause in stderr wins over the rejection line', () => {
    const out = '!\tabc:refs/heads/main\t[rejected] (x)\n';
    expect(classifyPushFailure(out, 'error: RPC failed; HTTP 413').klass.reason).toBe(
      'push-too-large',
    );
    expect(classifyPushFailure(out, 'fatal: Authentication failed').klass.reason).toBe(
      'unauthorized',
    );
  });

  it('[LIF-044] invalid refspecs are not retried', () => {
    for (const stderr of [
      'error: src refspec nope does not match any\n',
      "fatal: invalid refspec 'a:b:c'",
      'error: dst refspec refs/heads/x matches more than one',
    ]) {
      expect(classifyPushFailure('', stderr).klass).toEqual({
        code: 'invalid',
        reason: 'invalid-refspec',
        retryable: false,
      });
    }
  });

  it('[LIF-044] without rejection lines the stderr classification applies', () => {
    expect(classifyPushFailure('', 'error: RPC failed; HTTP 503').klass.retryable).toBe(true);
  });
});

describe('classification inputs (round 3)', () => {
  const failed = 'error: failed to push some refs to';

  it('[LIF-044] [remote failure] is a retryable network failure, and network stderr beats a generic rejection line', () => {
    const failure = '!\tabc:refs/heads/main\t[remote failure] (remote failed to report status)\n';
    expect(classifyPushFailure(failure, failed).klass).toEqual({
      code: 'transient',
      reason: 'network',
      retryable: true,
    });
    const rejected = '!\tabc:refs/heads/main\t[rejected] (fetch first)\n';
    expect(
      classifyPushFailure(
        rejected,
        'error: RPC failed; curl 56\nfatal: remote end hung up unexpectedly',
      ).klass.reason,
    ).toBe('network');
    // A mix of failure and rejection is still a rejection.
    expect(classifyPushFailure(failure + rejected, failed).klass.reason).toBe('rejected');
  });

  it('[ADP-050] repository and ref names do not drive classification', () => {
    const stderr = "error: failed to push some refs to 'http://h/acme/gh001-tools.git'";
    const out = '!\tabc:refs/heads/rate-limit-401-timed-out\t[rejected] (non-fast-forward)\n';
    expect(classifyPushFailure(out, stderr).klass).toEqual({
      code: 'conflict',
      reason: 'rejected',
      retryable: false,
    });
    expect(
      classifyGitFailure("fatal: unable to access 'http://h/a/gh001-tools.git/': HTTP 503").reason,
    ).toBe('network');
    expect(classifyGitFailure('remote: error: GH001: Large files detected.').reason).toBe(
      'blob-too-large',
    );
    expect(classifyGitFailure('remote: error: gh001 something').reason).toBe('unknown');
  });
});
