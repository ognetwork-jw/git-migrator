import { describe, expect, it } from 'vitest';
import { capabilities } from './capabilities.ts';

const field = (facet: keyof typeof capabilities.facets, path: string) =>
  capabilities.facets[facet]?.fields[path];

describe('GitHub static capabilities (worst-case ceiling, ADR-0261)', () => {
  it.each([
    ['repository-settings', '/description'],
    ['branch-rules', '/rules/pattern'],
    ['branch-rules', '/rules/enforcement'],
    ['branch-rules', '/rules/restrictMerges'],
    ['branch-rules', '/rules/deletionExempt'],
    ['branch-rules', '/rules/changeRequest/minApprovals'],
    ['branch-rules', '/rules/changeRequest/requireTasksResolved'],
    ['environments', '/environments/category'],
    ['variables', '/variables/name'],
    ['org-variables', '/variables/name'],
    ['webhooks', '/hooks/events'],
    ['org-webhooks', '/hooks/events'],
    ['code-ownership', '/owners'],
    ['merge-settings', '/allowed'],
  ] as const)('[ADP-014] %s %s is constrained (lossy in 05-facets)', (facet, path) => {
    expect(field(facet, path)?.kind).toBe('constrained');
  });

  it('[ADP-014] branch-rules minPassingBuilds is unsupported and the webhook secret unreadable', () => {
    expect(field('branch-rules', '/rules/changeRequest/minPassingBuilds')?.kind).toBe(
      'unsupported',
    );
    expect(field('webhooks', '/hooks/secret')?.kind).toBe('unreadable');
    expect(field('org-webhooks', '/hooks/secret')?.kind).toBe('unreadable');
  });

  it('[FAC-WEB-001] /hooks/events never starts with only:, which would switch on event filtering in the translator', () => {
    for (const facet of ['webhooks', 'org-webhooks'] as const) {
      const f = field(facet, '/hooks/events');
      expect(f?.kind === 'constrained' && f.constraint.startsWith('only:')).toBe(false);
    }
  });

  it('[FAC-BRR-002] force-push exemptions stay supported (the translator reads this path)', () => {
    expect(field('branch-rules', '/rules/forcePushExempt')).toEqual({ kind: 'supported' });
  });
});
