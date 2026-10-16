import { describe, expect, it } from 'vitest';
import { resolutionTaskKeys, taskCompletionKey } from './completion.ts';

describe('[LIF-006] task completion modes for the page', () => {
  it('[LIF-006] lists the resolution tasks of the built-in Facets, and no other', () => {
    const keys = resolutionTaskKeys();
    expect(keys).toContain(
      taskCompletionKey('access-control', 'access-control.unmapped-principal'),
    );
    expect(keys).toContain(taskCompletionKey('teams', 'teams.unmapped-principal'));
    expect(keys).not.toContain(taskCompletionKey('secrets', 'secrets.set-value'));
    expect(resolutionTaskKeys()).toBe(keys);
  });
});
