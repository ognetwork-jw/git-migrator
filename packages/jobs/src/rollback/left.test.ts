/**
 * What a rollback leaves is reported as structured entries, and guidance renders every kind in the
 * glossary's terms (LIF-077, GLO-002, ADR-0465 round 4).
 */
import { UNDO_LEFT_KINDS } from '@git-migrator/adapter-sdk';
import { PARAMS, renderGuidance } from '@git-migrator/guidance';
import { describe, expect, it } from 'vitest';
import { LEFT_IN_PLACE } from './steps.ts';

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
});
