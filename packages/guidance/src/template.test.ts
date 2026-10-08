import { describe, expect, it } from 'vitest';
import type { ParamValues } from './params.ts';
import {
  escapeMarkdown,
  isSupplied,
  missingMarker,
  neutraliseAutolinks,
  quoteShell,
  renderLines,
  renderTemplate,
  TemplateError,
} from './template.ts';

/** Untyped input, as a caller might pass at runtime. */
const loose = (values: Record<string, unknown>): ParamValues => values as ParamValues;

describe('guidance templating', () => {
  it('[UI-040] substitutes typed text parameters into prose', () => {
    const result = renderTemplate('Repository {repository} is ready.', {
      repository: 'acme/payments',
    });
    expect(result).toEqual({ text: 'Repository acme/payments is ready.', problems: [] });
  });

  it('[UI-040] escapes Markdown control characters in prose values', () => {
    const result = renderTemplate('{repository}', { repository: 'a_b*c[d](e)<f>|g&h' });
    expect(result.text).toBe('a\\_b\\*c\\[d\\](e)\\<f\\>\\|g\\&h');
    expect(escapeMarkdown('plain text')).toBe('plain text');
  });

  it('[UI-040] shell context quotes values that are not plain words', () => {
    const shell = (keyName: string): string => renderTemplate('{keyName:shell}', { keyName }).text;
    expect(shell('DB_HOST')).toBe('DB_HOST');
    expect(shell("it's")).toBe("'it'\\''s'");
    expect(shell('$(rm -rf /)')).toBe("'$(rm -rf /)'");
    expect(shell('a b;c')).toBe("'a b;c'");
    // A value that starts with "-" would be read as an option, so shell context refuses it.
    expect(shell('-rf')).toBe('‹keyName›');
    expect(quoteShell('ok.name-1')).toBe('ok.name-1');
  });

  it('[UI-040] raw context inserts a validated URL unchanged', () => {
    const result = renderTemplate('{targetUrl:raw}', {
      targetUrl: 'https://example.test/hooks/1?a=1&b=2',
    });
    expect(result.text).toBe('https://example.test/hooks/1?a=1&b=2');
  });

  it('[UI-040] rejects URLs that are not plain http(s) or that carry credentials', () => {
    for (const bad of [
      'javascript:alert(1)',
      'ftp://example.test/x',
      'https://user:pw@example.test/',
      'not a url',
    ]) {
      const result = renderTemplate('{targetUrl:raw}', { targetUrl: bad });
      expect(result.text).toBe(missingMarker('targetUrl'));
      expect(result.problems).toEqual([{ param: 'targetUrl', reason: 'invalid' }]);
    }
  });

  it('[UI-040] integer parameters accept only non-negative safe integers', () => {
    expect(renderTemplate('{count}', { count: 0 }).text).toBe('0');
    expect(renderTemplate('{count}', { count: 42 }).text).toBe('42');
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE, '3']) {
      expect(renderTemplate('{count}', loose({ count: bad })).problems).toEqual([
        { param: 'count', reason: 'invalid' },
      ]);
    }
  });

  it('[UI-040] list parameters join items in each context', () => {
    expect(renderTemplate('{names}', { names: ['A_1', 'B'] }).text).toBe('A\\_1, B');
    expect(renderTemplate('{names:shell}', { names: ['A_1', 'b c'] }).text).toBe("A_1 'b c'");
    // raw is for URL parameters only.
    expect(renderTemplate('{names:raw}', { names: ['x', 'y'] }).problems).toEqual([
      { param: 'names', reason: 'context-mismatch' },
    ]);
  });

  it('[UI-040] never prints undefined, null, NaN or an empty value', () => {
    const junk: unknown[] = [
      undefined,
      null,
      '',
      '   ',
      {},
      Number.NaN,
      [],
      ['ok', ''],
      'line\nbreak',
      'x'.repeat(2000),
    ];
    for (const bad of junk) {
      const result = renderTemplate('[{repository}]', loose({ repository: bad }));
      expect(result.text).toBe(`[${missingMarker('repository')}]`);
      expect(result.text).not.toMatch(/undefined|null|NaN|\[object/);
      expect(result.problems).toHaveLength(1);
    }
  });

  it('[UI-040] reports missing and invalid parameters as problems, not exceptions', () => {
    const result = renderTemplate('{repository} {count} {names}', {});
    expect(result.text).toBe('‹repository› ‹count› ‹names›');
    expect(result.problems).toEqual([
      { param: 'repository', reason: 'missing' },
      { param: 'count', reason: 'missing' },
      { param: 'names', reason: 'missing' },
    ]);
  });

  it('[UI-040] unknown parameters and contexts render as markers and are reported', () => {
    const result = renderTemplate('{nope} {repository:html}', { repository: 'acme/x' });
    expect(result.text).toBe('‹nope› ‹repository›');
    expect(result.problems).toEqual([
      { param: 'nope', reason: 'unknown-param' },
      { param: 'repository', reason: 'unknown-context' },
    ]);
  });

  it('[UI-040] inserted values are not expanded again', () => {
    expect(renderTemplate('{repository}', { repository: '{count}' }).text).toBe('{count}');
  });

  it('[UI-040] braces that are not placeholders are kept as written', () => {
    expect(renderTemplate('set {} and {1x} and { spaced }', {}).text).toBe(
      'set {} and {1x} and { spaced }',
    );
  });

  it('[UI-040] renderLines repeats a snippet once per list item', () => {
    const result = renderLines('gh secret set {names:shell} --repo {repository:shell}', {
      names: ['API_TOKEN', 'DB_PASSWORD'],
      repository: 'acme/payments',
    });
    expect(result.text).toBe(
      'gh secret set API_TOKEN --repo acme/payments\ngh secret set DB_PASSWORD --repo acme/payments',
    );
    expect(result.problems).toEqual([]);
  });

  it('[UI-040] renderLines marks a snippet whose list is missing and does not invent lines', () => {
    const result = renderLines('gh secret set {names:shell} --repo {repository:shell}', {
      repository: 'acme/x',
    });
    expect(result.text).toBe('gh secret set ‹names› --repo acme/x');
    expect(result.problems).toEqual([{ param: 'names', reason: 'missing' }]);
  });

  it('[UI-040] renderLines refuses a snippet with two list parameters (developer error)', () => {
    expect(() => renderLines('{names} {paths}', { names: ['a'], paths: ['b'] })).toThrow(
      TemplateError,
    );
  });

  it('[UI-040] supplied-value check treats blank strings and empty lists as missing', () => {
    expect(isSupplied(undefined)).toBe(false);
    expect(isSupplied(null)).toBe(false);
    expect(isSupplied('  ')).toBe(false);
    expect(isSupplied([])).toBe(false);
    expect(isSupplied(0)).toBe(true);
    expect(isSupplied(['a'])).toBe(true);
  });
});

describe('guidance value hardening (UI-040, ADR-0092)', () => {
  it('[UI-040] rejects C1 controls, line and paragraph separators and bidi controls in text and shell', () => {
    const forbidden = ['\u0085', '\u009b', ' ', ' ', '‮', '⁦', '⁩', 'ok‪hidden'];
    for (const value of forbidden) {
      // Whitespace-only values count as missing; everything else is invalid. Both show a marker.
      const result = renderTemplate('{repository}', { repository: value });
      expect(result.text, JSON.stringify(value)).toBe('‹repository›');
      expect(result.problems, JSON.stringify(value)).toHaveLength(1);
      expect(renderTemplate('{keyName:shell}', { keyName: value }).text).toBe('‹keyName›');
    }
  });

  it('[UI-040] neutralises bare URL autolinks in prose', () => {
    expect(renderTemplate('{repository}', { repository: 'https://evil.test/x' }).text).toBe(
      'https&#58;//evil.test/x',
    );
    expect(renderTemplate('{repository}', { repository: 'www.evil.test' }).text).toBe(
      'www&#46;evil.test',
    );
    expect(renderTemplate('{repository}', { repository: 'plain-name' }).text).toBe('plain-name');
  });

  it('[UI-040] neutralises schemes and hosts glued to a preceding word character', () => {
    expect(renderTemplate('{repository}', { repository: 'xhttps://evil.test' }).text).toBe(
      'xhttps&#58;//evil.test',
    );
    expect(renderTemplate('{repository}', { repository: 'a_www.evil.test' }).text).toBe(
      'a\\_www&#46;evil.test',
    );
    expect(renderTemplate('{repository}', { repository: 'ftp://h' }).text).toBe('ftp&#58;//h');
    expect(neutraliseAutolinks('XHTTP://A and WWW.B')).toBe('XHTTP&#58;//A and www&#46;B');
    // Every URI scheme, not only web schemes.
    expect(neutraliseAutolinks('ssh://host/x')).toBe('ssh&#58;//host/x');
    expect(neutraliseAutolinks('git://host/repo')).toBe('git&#58;//host/repo');
    expect(neutraliseAutolinks('file:///etc/passwd')).toBe('file&#58;///etc/passwd');
    expect(neutraliseAutolinks('my-app+v2.1://x')).toBe('my-app+v2.1&#58;//x');
  });

  it('[UI-040] raw URLs have single quotes percent-encoded so they cannot end a shell word', () => {
    const result = renderTemplate('{targetUrl:raw}', { targetUrl: "https://example.test/a'b" });
    expect(result.text).toBe('https://example.test/a%27b');
  });

  it('[UI-040] raw is refused for non-URL parameters', () => {
    expect(renderTemplate('{repository:raw}', { repository: 'acme/x' }).problems).toEqual([
      { param: 'repository', reason: 'context-mismatch' },
    ]);
  });

  it('[UI-040] a NUL byte in a shell value is invalid, so no copy is produced', () => {
    const result = renderTemplate('echo {keyName:shell}', { keyName: 'a\u0000b' });
    expect(result.text).toBe('echo ‹keyName›');
    expect(result.problems).toEqual([{ param: 'keyName', reason: 'invalid' }]);
  });

  it('[UI-040] shell context refuses leading dashes in every list item', () => {
    expect(renderTemplate('{names:shell}', { names: ['OK', '--force'] }).problems).toEqual([
      { param: 'names', reason: 'invalid' },
    ]);
  });
});
