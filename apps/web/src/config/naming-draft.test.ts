import { describe, expect, it } from 'vitest';
import {
  bodyKey,
  defaultPipeline,
  draftProblems,
  makeStep,
  OVERRIDE_PLACEHOLDER_PIPELINE,
  type PreviewResult,
  type PreviewState,
  type RuleDraft,
  ruleBody,
  saveBlock,
} from './naming-draft.ts';

const draft = (patch: Partial<RuleDraft> = {}): RuleDraft => ({
  scope: 'namespace',
  scopeRef: 'ns1',
  mode: 'pipeline',
  pipeline: defaultPipeline(),
  override: '',
  ...patch,
});

const result = (collisions: PreviewResult['collisions'] = []): PreviewResult => ({
  summary: { affected: 2, changed: 2, invalid: 0, colliding: collisions.length },
  collisions,
  items: [],
  nextCursor: null,
});

describe('naming rule draft (UI-030, LIF-030)', () => {
  it('[UI-030] the default pipeline is the LIF-030 default', () => {
    const body = ruleBody(draft());
    expect(body).toEqual({
      scope: 'namespace',
      scopeRef: 'ns1',
      pipeline: {
        steps: [
          { var: 'namespace', op: 'projectKey' },
          { var: 'namespace', op: 'lowercase' },
          { var: 'repository', op: 'slug' },
          { var: 'repository', op: 'kebab' },
        ],
        template: '{namespace}-{repository}',
      },
    });
    expect(draftProblems(draft())).toEqual([]);
  });

  it('[UI-030] the body carries only the fields each op uses', () => {
    const pipeline = {
      template: '{repository}',
      steps: [
        makeStep({ var: 'repository', op: 'truncate', arg: 12, pattern: 'stale', with: 'x' }),
        makeStep({ var: 'repository', op: 'replace', arg: 3, pattern: '_', with: '-' }),
        makeStep({ var: 'repository', op: 'kebab', arg: 9, pattern: 'x', with: 'y' }),
      ],
    };
    const body = ruleBody(draft({ pipeline }));
    expect('pipeline' in body && body.pipeline.steps).toEqual([
      { var: 'repository', op: 'truncate', arg: 12 },
      { var: 'repository', op: 'replace', pattern: '_', with: '-' },
      { var: 'repository', op: 'kebab' },
    ]);
  });

  it('[UI-030] an override is a repository literal, trimmed, and stores the placeholder pipeline', () => {
    const body = ruleBody(
      draft({ scope: 'repository', mode: 'override', scopeRef: 'r1', override: '  legacy-name ' }),
    );
    expect(body).toEqual({ scope: 'repository', scopeRef: 'r1', override: 'legacy-name' });
    expect(OVERRIDE_PLACEHOLDER_PIPELINE).toEqual({ steps: [], template: '' });
  });

  it('[UI-030] draftProblems names each problem the API would refuse', () => {
    expect(draftProblems(draft({ scopeRef: '' }))).toContain('scope');
    expect(draftProblems(draft({ pipeline: { steps: [], template: '{a}' } }))).toContain('steps');
    expect(draftProblems(draft({ pipeline: { ...defaultPipeline(), template: ' ' } }))).toContain(
      'template',
    );
    const bad = draft({
      pipeline: {
        template: '{repository}',
        steps: [
          makeStep({ var: '', op: 'lowercase', arg: null, pattern: '', with: '' }),
          makeStep({ var: 'repository', op: 'nope', arg: null, pattern: '', with: '' }),
          makeStep({ var: 'repository', op: 'truncate', arg: 0, pattern: '', with: '' }),
          makeStep({ var: 'repository', op: 'replace', arg: null, pattern: '', with: '' }),
        ],
      },
    });
    expect(draftProblems(bad).sort()).toEqual(['op', 'pattern', 'truncateArg', 'var'].sort());
    expect(draftProblems(draft({ mode: 'override', scope: 'namespace', override: 'x' }))).toEqual([
      'overrideScope',
    ]);
    expect(
      draftProblems(draft({ mode: 'override', scope: 'repository', override: '   ' })),
    ).toEqual(['override']);
  });
});

describe('naming save gate (UI-030, LIF-031)', () => {
  const key = bodyKey(ruleBody(draft()));
  const preview = (state: Partial<PreviewState> = {}): PreviewState => ({
    key,
    body: ruleBody(draft()),
    result: result(),
    ...state,
  });

  it('[LIF-031] saving needs a preview of the exact body being saved', () => {
    expect(saveBlock({ valid: true, key, preview: undefined, confirmed: false })).toBe(
      'no-preview',
    );
    expect(
      saveBlock({ valid: true, key, preview: preview({ key: 'other' }), confirmed: false }),
    ).toBe('stale-preview');
    expect(saveBlock({ valid: false, key, preview: preview(), confirmed: false })).toBe('invalid');
  });

  it('[UI-030] a preview that could not run blocks the save, because collisions are unknown', () => {
    expect(
      saveBlock({
        valid: true,
        key,
        preview: { key, body: ruleBody(draft()), failure: 'validation_failed' },
        confirmed: true,
      }),
    ).toBe('preview-unavailable');
  });

  it('[UI-030] a rule that introduces collisions is blocked unless the operator confirms', () => {
    const colliding = preview({ result: result([{ key: 'acme-api', members: ['m1', 'm2'] }]) });
    expect(saveBlock({ valid: true, key, preview: colliding, confirmed: false })).toBe(
      'collisions-unconfirmed',
    );
    expect(saveBlock({ valid: true, key, preview: colliding, confirmed: true })).toBeUndefined();
  });

  it('[UI-030] a rule without collisions can be saved after its preview', () => {
    expect(saveBlock({ valid: true, key, preview: preview(), confirmed: false })).toBeUndefined();
  });
});
