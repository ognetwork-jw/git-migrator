/**
 * What a rollback leaves is reported as structured entries, and guidance renders every kind in the
 * glossary's terms (LIF-077, GLO-002, ADR-0465 round 4).
 */
import { UNDO_LEFT_KINDS } from '@git-migrator/adapter-sdk';
import { PARAMS, renderGuidance } from '@git-migrator/guidance';
import { describe, expect, it } from 'vitest';
import { LEFT_IN_PLACE, leftInPlaceReport } from './steps.ts';

describe('left-in-place entries (ADR-0465 round 4)', () => {
  it('[LIF-077] every kind an undo or the rollback can leave is declared by the guidance parameter and renders without problems', () => {
    expect([...PARAMS.details.entryKinds].sort()).toEqual([...UNDO_LEFT_KINDS].sort());
    for (const kind of UNDO_LEFT_KINDS) {
      const rendered = renderGuidance(LEFT_IN_PLACE, { details: [{ kind, name: 'platform' }] });
      expect(rendered.problems, kind).toEqual([]);
      expect(rendered.summary, kind).toContain('platform');
      // GLO-002: provider vocabulary stays out of the rendered entry.
      expect(rendered.summary, kind).not.toMatch(/\bteams?\b/i);
    }
  });

  it('[LIF-077] a long left list names the first 20, says so, and the guidance tells how many are not listed', () => {
    const lefts = Array.from({ length: 23 }, (_, i) => ({
      kind: 'repository-earlier' as const,
      name: `repo-${i}`,
    }));
    const report = leftInPlaceReport(lefts);
    expect(report.details).toHaveLength(20);
    expect(report.params).toEqual({ details: report.details, omitted: 3 });
    expect(report.message).toMatch(/^23 change\(s\) /);
    expect(report.message).toMatch(/repo-19 \(first 20 shown\)$/);
    const rendered = renderGuidance(LEFT_IN_PLACE, report.params);
    expect(rendered.problems).toEqual([]);
    expect(rendered.steps.map((s) => s.text).join('\n')).toContain('3 more change(s)');

    const short = leftInPlaceReport(lefts.slice(0, 2));
    expect(short.params).toEqual({ details: short.details });
    expect(short.message).not.toContain('shown');
    expect(
      renderGuidance(LEFT_IN_PLACE, short.params)
        .steps.map((s) => s.text)
        .join('\n'),
    ).not.toContain('more change');
  });
});
