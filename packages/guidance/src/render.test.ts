import { describe, expect, it } from 'vitest';
import { FINDING_CODES } from './codes.ts';
import { GUIDANCE } from './entries.ts';
import enMessages from './messages/en.json' with { type: 'json' };
import {
  displayTargetUrl,
  GUIDANCE_MESSAGES_EN,
  GuidanceError,
  nestCatalog,
  nextIntlLookup,
  renderGuidance,
} from './render.ts';
import { SAMPLE_VALUES } from './sample-values.ts';

describe('guidance rendering', () => {
  it('[UI-040] renders every code with full sample parameters, with no problems and no undefined', () => {
    for (const code of FINDING_CODES) {
      const rendered = renderGuidance(code, SAMPLE_VALUES);
      expect(rendered.problems, code).toEqual([]);
      const output = JSON.stringify(rendered);
      expect(output, code).not.toMatch(/undefined|null|NaN|‹/);
      expect(rendered.title.length, code).toBeGreaterThan(0);
      expect(rendered.summary.length, code).toBeGreaterThan(0);
      expect(rendered.steps.length, code).toBeGreaterThan(0);
      for (const step of rendered.steps) expect(step.text.length, code).toBeGreaterThan(0);
    }
  });

  it('[UI-040] carries severity and verifiable from the source list', () => {
    const rendered = renderGuidance('secrets.set-value', SAMPLE_VALUES);
    expect(rendered).toMatchObject({
      code: 'secrets.set-value',
      severity: 'post',
      verifiable: true,
    });
    expect(renderGuidance('git-refs.blob-too-large', SAMPLE_VALUES)).toMatchObject({
      severity: 'blocker',
      verifiable: false,
    });
  });

  it('[UI-040] copy snippets are rendered as ready-to-run lines, one per secret name', () => {
    const rendered = renderGuidance('secrets.set-value', {
      repository: 'acme/payments',
      scope: 'repository',
      names: ['API_TOKEN', 'DB PASSWORD'],
    });
    expect(rendered.steps).toHaveLength(1);
    expect(rendered.steps[0]?.copy).toBe(
      "gh secret set API_TOKEN --repo acme/payments\ngh secret set 'DB PASSWORD' --repo acme/payments",
    );
  });

  it('[UI-040] when and unless choose the step for environment-scoped secrets', () => {
    const rendered = renderGuidance('secrets.set-value', SAMPLE_VALUES);
    expect(rendered.steps).toHaveLength(1);
    expect(rendered.steps[0]?.copy).toContain('--env production');

    const repositoryOnly = renderGuidance('secrets.set-value', {
      repository: 'acme/payments',
      scope: 'repository',
      names: ['API_TOKEN'],
    });
    expect(repositoryOnly.steps[0]?.copy).toBe('gh secret set API_TOKEN --repo acme/payments');
    expect(repositoryOnly.steps[0]?.copy).not.toContain('--env');
  });

  it('[UI-040] omits a copy snippet that has a missing parameter, and reports the problem', () => {
    const rendered = renderGuidance('secrets.set-value', {
      repository: 'acme/payments',
      scope: 'repository',
    });
    expect(rendered.steps[0]?.copy).toBeUndefined();
    expect(rendered.problems).toEqual([{ param: 'names', reason: 'missing' }]);
  });

  it('[UI-040] missing summary parameters show a marker, never undefined', () => {
    const rendered = renderGuidance('git-refs.blob-too-large', { path: 'a.bin' });
    expect(rendered.summary).toContain('‹size›');
    expect(rendered.summary).toContain('‹limit›');
    expect(rendered.steps[0]?.copy).toBeUndefined();
    expect(JSON.stringify(rendered)).not.toContain('undefined');
    expect(rendered.problems.map((p) => p.param).sort()).toEqual(['limit', 'size']);
  });

  it('[UI-040] quotes shell values in copy snippets and inserts URLs raw', () => {
    const deployKey = renderGuidance('deploy-keys.key-in-use', {
      repository: 'acme/payments',
      keyName: "it's the key",
    });
    expect(deployKey.steps[0]?.copy).toBe(
      "ssh-keygen -t ed25519 -C 'it'\\''s the key' -f deploy_key_ed25519",
    );
    // The key title is only ever a comment; the output file name is fixed, never provider data.
    const hostile = renderGuidance('deploy-keys.key-in-use', {
      repository: 'acme/payments',
      keyName: '../../.ssh/authorized_keys',
    });
    expect(hostile.steps[0]?.copy).toBe(
      'ssh-keygen -t ed25519 -C ../../.ssh/authorized_keys -f deploy_key_ed25519',
    );

    const hook = renderGuidance('webhooks.recreate-manually', {
      targetUrl: 'https://example.test/hooks/1?x=1&y=2',
      events: ['push'],
    });
    // Shell context: the URL is single-quoted, so ; | & $( ) and quotes stay literal.
    expect(hook.steps[0]?.copy).toBe("'https://example.test/hooks/1?x=1&y=2'");
  });

  it('[UI-040] renders with a caller-supplied message lookup and falls back to English', () => {
    const lookup = (key: string): string | undefined =>
      key === 'finding.pipelines.disabled.title' ? 'Traduction du titre' : undefined;
    const rendered = renderGuidance('pipelines.disabled', SAMPLE_VALUES, { lookup });
    expect(rendered.title).toBe('Traduction du titre');
    expect(rendered.summary).toBe(renderGuidance('pipelines.disabled', SAMPLE_VALUES).summary);
  });

  it('[UI-040] renders the shared principal guidance with the facet name', () => {
    const rendered = renderGuidance('teams.unmapped-principal', {
      principal: 'jane.doe',
      facet: 'teams',
    });
    expect(rendered.summary).toBe(
      'jane.doe appears in teams but has no confirmed identity mapping, so it is left out of the target.',
    );
    expect(rendered.problems).toEqual([]);
  });

  it('[UI-040] renders the accept-lossy guidance with the policy key in backticks', () => {
    const rendered = renderGuidance('variables.accept-lossy', {
      paths: ['/variables[name=api]'],
      policyKey: 'variables.uppercase-names',
    });
    expect(rendered.steps[1]?.text).toContain('`variables.uppercase-names`');
  });

  it('[UI-040] throws GuidanceError for a code with no guidance (a developer error)', () => {
    expect(() => renderGuidance('made-up.code', SAMPLE_VALUES)).toThrow(GuidanceError);
  });

  it('[UI-040] every entry declares a code that matches its key', () => {
    for (const [key, entry] of Object.entries(GUIDANCE)) expect(entry.code).toBe(key);
  });
});

/**
 * A faithful stand-in for the next-intl translator subset used by guidance (ADR-0093). `has` resolves
 * dotted keys through nested messages, `raw` returns the message verbatim, and `t` applies ICU rules,
 * where a `{name}` argument must be supplied. next-intl itself is not pinned in this repository.
 */
class FakeNextIntl {
  constructor(private readonly messages: Record<string, unknown>) {}

  private resolve(key: string): string | undefined {
    let node: unknown = this.messages;
    for (const part of key.split('.')) {
      if (typeof node !== 'object' || node === null || !Object.hasOwn(node, part)) return undefined;
      node = (node as Record<string, unknown>)[part];
    }
    return typeof node === 'string' ? node : undefined;
  }

  has(key: string): boolean {
    return this.resolve(key) !== undefined;
  }

  raw(key: string): string {
    const value = this.resolve(key);
    if (value === undefined) throw new Error(`MISSING_MESSAGE: ${key}`);
    return value;
  }

  t(key: string): string {
    const value = this.raw(key);
    if (/\{[A-Za-z]/.test(value)) throw new Error(`ICU: ${key} needs arguments`);
    return value;
  }
}

describe('next-intl integration (UI-040, ADR-0093)', () => {
  it('[UI-040] the nested catalog resolves every key through nextIntlLookup to the same text', () => {
    const translator = new FakeNextIntl(nestCatalog(enMessages));
    const lookup = nextIntlLookup(translator);
    for (const code of FINDING_CODES) {
      const viaNextIntl = renderGuidance(code, SAMPLE_VALUES, { lookup });
      const english = renderGuidance(code, SAMPLE_VALUES);
      expect(viaNextIntl, code).toEqual(english);
    }
  });

  it('[UI-040] plain t() would fail on guidance placeholders, so the lookup must use raw', () => {
    const translator = new FakeNextIntl(nestCatalog(enMessages));
    expect(() => translator.t('finding.git-refs.blob-large.summary')).toThrow(/ICU/);
    expect(translator.raw('finding.git-refs.blob-large.summary')).toContain('{path}');
  });

  it('[UI-040] apostrophes survive the raw lookup unchanged', () => {
    const lookup = nextIntlLookup(new FakeNextIntl(nestCatalog(enMessages)));
    const rendered = renderGuidance('repository-settings.org-forking-disabled', {}, { lookup });
    expect(rendered.steps[0]?.text).toContain("organization's settings");
  });

  it('[UI-040] a key the translator does not have falls back to English without a problem', () => {
    const lookup = nextIntlLookup(new FakeNextIntl({}));
    const rendered = renderGuidance('pipelines.disabled', SAMPLE_VALUES, { lookup });
    expect(rendered.title).toBe(renderGuidance('pipelines.disabled', SAMPLE_VALUES).title);
    expect(rendered.problems).toEqual([]);
  });

  it('[UI-040] a lookup that echoes the key is replaced by English and reported as a problem', () => {
    const echo = (key: string): string => key;
    const rendered = renderGuidance('pipelines.disabled', SAMPLE_VALUES, { lookup: echo });
    expect(rendered.title).toBe('Pipelines are disabled on the source');
    expect(rendered.problems).toContainEqual({
      param: 'finding.pipelines.disabled.title',
      reason: 'message-fallback',
    });
  });

  it('[UI-040] nestCatalog nests dotted keys and refuses a key that is also a prefix', () => {
    expect(nestCatalog({ 'a.b.c': 'x', 'a.b.d': 'y' })).toEqual({ a: { b: { c: 'x', d: 'y' } } });
    expect(() => nestCatalog({ 'a.b': 'x', 'a.b.c': 'y' })).toThrow(GuidanceError);
    expect(() => nestCatalog({ 'a.b.c': 'x', 'a.b': 'y' })).toThrow(GuidanceError);
  });
});

describe('display and copy of webhook URLs (UI-040, ADR-0092)', () => {
  it('[UI-040] summaries show the origin only, while the copy snippet carries the full URL', () => {
    const secretUrl = 'https://example.test/hooks/SECRET123?token=abc';
    const rendered = renderGuidance('webhooks.recreate-manually', {
      targetUrl: secretUrl,
      events: ['push'],
    });
    // The display origin is neutralised as an autolink like any prose value, so it renders the same.
    expect(rendered.summary).toContain('https&#58;//example.test/…');
    expect(rendered.summary).not.toContain('SECRET123');
    expect(rendered.steps[0]?.copy).toBe(`'${secretUrl}'`);
    expect(renderGuidance('webhooks.set-secret', { targetUrl: secretUrl }).summary).not.toContain(
      'SECRET123',
    );
  });

  it('[FAC-WEB-003] set-secret asks for activation only when the hook was active on the source', () => {
    const params = { targetUrlDisplay: 'https://example.test/…' };
    expect(
      renderGuidance('webhooks.set-secret', { ...params, activateAfterSecret: true }).steps,
    ).toHaveLength(2);
    expect(
      renderGuidance('webhooks.set-secret', { ...params, activateAfterSecret: false }).steps,
    ).toHaveLength(1);
    expect(renderGuidance('webhooks.set-secret', params).steps).toHaveLength(1);
  });

  it('[FAC-WEB-002] recreate-manually tells the operator to set a new secret only when the source hook had one', () => {
    for (const code of ['webhooks.recreate-manually', 'org-webhooks.recreate-manually']) {
      const base = { targetUrl: 'https://hooks.example.test/h', events: ['push'] };
      const without = renderGuidance(code, base).steps;
      const withSecret = renderGuidance(code, { ...base, hasSecret: true }).steps;
      expect(without).toHaveLength(2);
      expect(withSecret).toHaveLength(3);
      expect(JSON.stringify(without)).not.toContain('secret step');
      expect(withSecret[2]?.text).toMatch(/new secret/);
    }
  });

  it('[UI-040] non-http(s) URLs show the marker, never "null/…" or the raw URL', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'mailto:ops@example.test']) {
      const rendered = renderGuidance('webhooks.set-secret', { targetUrl: url });
      expect(rendered.summary, url).toContain('‹targetUrlDisplay›');
      expect(rendered.summary, url).not.toContain('null');
      expect(rendered.problems, url).toContainEqual({
        param: 'targetUrlDisplay',
        reason: 'missing',
      });
    }
    expect(displayTargetUrl('not a url')).toBeUndefined();
    expect(displayTargetUrl('https://example.test/x')).toBe('https://example.test/…');
  });

  it('[UI-040] the webhook copy quotes shell metacharacters and never runs them', () => {
    const cases: [string, string][] = [
      ['https://example.test/a;rm$(id)|x&y', "'https://example.test/a;rm$(id)|x&y'"],
      // The URL parser percent-encodes backticks, so the result is a plain word with no metacharacter.
      ['https://example.test/a`id`', 'https://example.test/a%60id%60'],
      ["https://example.test/a'b", "'https://example.test/a'\\''b'"],
    ];
    for (const [url, quoted] of cases) {
      const rendered = renderGuidance('webhooks.recreate-manually', {
        targetUrl: url,
        events: ['push'],
      });
      expect(rendered.steps[0]?.copy, url).toBe(quoted);
    }
  });

  it('[UI-040] a NUL byte in the webhook URL drops the copy snippet and reports it as invalid', () => {
    const rendered = renderGuidance('webhooks.recreate-manually', {
      targetUrl: 'https://example.test/\u0000',
      events: ['push'],
    });
    expect(rendered.steps[0]?.copy).toBeUndefined();
    expect(rendered.problems).toContainEqual({ param: 'targetUrl', reason: 'invalid' });
  });

  it('[UI-040] a newline in the webhook URL drops the copy snippet and reports the problem', () => {
    const rendered = renderGuidance('webhooks.recreate-manually', {
      targetUrl: 'https://example.test/a\nrm -rf /',
      events: ['push'],
    });
    expect(rendered.steps[0]?.copy).toBeUndefined();
    expect(rendered.problems.map((p) => p.param)).toContain('targetUrl');
  });
});

describe('[UI-040] the exported English catalog', () => {
  it('[UI-040] is the catalog the default lookup reads, so a host can mount it unchanged', () => {
    expect(GUIDANCE_MESSAGES_EN).toEqual(enMessages);
    expect(() => nestCatalog(GUIDANCE_MESSAGES_EN)).not.toThrow();
  });
});
