import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasGuidance, nextIntlLookup, renderGuidance } from '@git-migrator/guidance';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { GUIDANCE_NAMESPACE, messages } from './messages.ts';

describe('[UI-040] the guidance catalog is mounted in the app catalog', () => {
  // The guidance keys are dotted strings from another package, so the generated key types do not know them.
  const t = createTranslator({
    locale: 'en',
    messages,
    namespace: GUIDANCE_NAMESPACE,
  }) as unknown as { has(key: string): boolean; raw(key: string): string };

  it('[UI-040] keeps the interface strings and adds the guidance under its own namespace', () => {
    expect(messages.problem.run_active).toMatch(/Run/);
    expect(Object.keys(messages[GUIDANCE_NAMESPACE])).toContain('finding');
  });

  it('[UI-040] reads guidance through next-intl without ICU formatting, so placeholders survive', () => {
    expect(t.has('finding.secrets.set-value.summary')).toBe(true);
    expect(t.raw('finding.secrets.set-value.summary')).toContain('{names}');
    const rendered = renderGuidance(
      'secrets.set-value',
      { names: ['A_B'], scope: 'repository', repository: 'acme/x' },
      { lookup: nextIntlLookup(t) },
    );
    expect(rendered.problems).toEqual([]);
    expect(rendered.steps[0]?.copy).toBe('gh secret set A_B --repo acme/x');
  });

  it('[UI-040] a code with guidance is known to the view', () => {
    expect(hasGuidance('secrets.set-value')).toBe(true);
    expect(hasGuidance('made.up')).toBe(false);
  });
});

describe('[GLO-002] the interface catalog uses glossary terms', () => {
  // Provider terms are allowed in adapters, provider docs and guidance text only (GLO-002), so this
  // scans the interface catalog and not the guidance catalog. Identity-provider names (Microsoft,
  // Entra) are sign-in vocabulary (AUTH-002), not git-provider terms.
  const banned =
    /bitbucket|github|gitlab|\bworkspaces?\b|\bprojects?\b|\borgani[sz]ations?\b|pull requests?|\bPRs?\b|merge requests?/i;
  const catalog = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'messages', 'en.json'),
      'utf8',
    ),
  ) as unknown;

  const strings = (node: unknown, path: string): [string, string][] =>
    typeof node === 'string'
      ? [[path, node]]
      : node && typeof node === 'object'
        ? Object.entries(node).flatMap(([k, v]) => strings(v, `${path}.${k}`))
        : [];

  it('[GLO-002] no interface string contains a provider term', () => {
    const all = strings(catalog, '');
    expect(all.length).toBeGreaterThan(100);
    const offenders = all.filter(([, text]) => banned.test(text)).map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('[GLO-002] the vocabulary check catches provider terms', () => {
    for (const bad of ['Source project', 'target organization', 'Open the pull request', 'GitHub'])
      expect(banned.test(bad), bad).toBe(true);
    for (const ok of ['Source Namespace', 'target Namespace', 'Change request', 'work account'])
      expect(banned.test(ok), ok).toBe(false);
  });
});
