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
