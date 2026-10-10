/** How a rollback treats a ledgered target record (LIF-077). */
import { describe, expect, it } from 'vitest';
import { dispositionOf } from './ledger.ts';

describe('dispositionOf', () => {
  it('[LIF-077] a code-ownership delivery is reverted by its resource kind: the pull request is closed, the branch is left', () => {
    // The code-ownership driver tags the Change Request writer's records with its own facet key
    // (LIF-045); the disposition follows `resourceRef.kind`, so rollback is unchanged by the tag.
    expect(
      dispositionOf({
        action: 'create',
        resourceRef: { kind: 'change-request', purpose: 'codeowners', number: 7 },
      }),
    ).toBe('change-request');
    expect(
      dispositionOf({ action: 'update', resourceRef: { kind: 'change-request', number: 7 } }),
    ).toBe('left');
    expect(
      dispositionOf({ action: 'create', resourceRef: { kind: 'ref', ref: 'refs/heads/x' } }),
    ).toBe('left');
  });
});
