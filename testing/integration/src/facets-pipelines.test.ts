import { bitbucketCloudToGithubPipelines } from '@git-migrator/adapter-github';
import type { Pipelines } from '@git-migrator/canonical';
import {
  compareFacet,
  FacetRegistry,
  resolveRoutePolicies,
  sha256Hex,
  type TranslateEnvironment,
  translateFacet,
} from '@git-migrator/core';
import { pipelinesDefinition } from '@git-migrator/facets';
import { assertGuidanceCoverage, type ParamValues, renderGuidance } from '@git-migrator/guidance';
import { describe, expect, it } from 'vitest';

const PAIR = { source: 'bitbucket-cloud', target: 'github' };
const registry = new FacetRegistry()
  .register(pipelinesDefinition)
  .registerOverride(bitbucketCloudToGithubPipelines);
const unresolved = { resolve: () => ({ status: 'unmapped' as const }) };

const FULL = 'pipelines:\n  default:\n    - step:\n        script:\n          - make\n';
const PARTIAL = `${FULL}          - pipe: a/b:1\n`;

function sourceOf(text: string, enabled = true): Pipelines {
  return {
    files: [{ path: 'bitbucket-pipelines.yml', sha256: sha256Hex(text) }],
    enabled,
    translation: { supported: true, unsupported: [] },
  };
}

function envFor(text: string): TranslateEnvironment {
  return {
    identities: unresolved,
    groups: unresolved,
    policies: resolveRoutePolicies({}),
    route: {},
    routeIndex: { pipelines: { sources: { [sha256Hex(text)]: text } } },
  };
}

const translate = (text: string, enabled = true, pair: typeof PAIR | null = PAIR) =>
  translateFacet(registry, 'pipelines', sourceOf(text, enabled), {
    env: envFor(text),
    ...(pair === null ? {} : { pair }),
  });

describe('guidance coverage of the pipelines facet', () => {
  it('[FAC-002] every declared finding code has guidance', () => {
    const codes = Object.keys(pipelinesDefinition.findingCodes);
    expect(codes.sort()).toEqual([
      'pipelines.complete-translation',
      'pipelines.disabled',
      'pipelines.review-and-merge',
    ]);
    expect(() => assertGuidanceCoverage(codes)).not.toThrow();
  });
});

describe('pipelines facet with the bitbucket-cloud to github override', () => {
  it('[ADP-032] the override replaces the default translation for the pair only', () => {
    const withPair = translate(FULL);
    expect(withPair.overridden).toBe(true);
    expect((withPair.desired as Pipelines).files.map((f) => f.path)).toEqual([
      '.github/workflows/ci.yml',
    ]);
    const withoutPair = translate(FULL, true, null);
    expect(withoutPair.overridden).toBe(false);
    expect((withoutPair.desired as Pipelines).files).toEqual([]);
  });

  it('[FAC-PIP-003] fully supported: one verifiable post task, rendered without missing parameters', () => {
    const t = translate(FULL);
    expect(t.postTasks.map((p) => [p.code, p.verifiable])).toEqual([
      ['pipelines.review-and-merge', true],
    ]);
    const task = t.postTasks[0];
    const rendered = renderGuidance('pipelines.review-and-merge', task?.params as ParamValues);
    expect(rendered.problems).toEqual([]);
    expect(rendered.summary).toContain('.github/workflows/ci.yml');
    expect(rendered.summary).toContain('git-migrator/ci');
  });

  it('[FAC-PIP-003] partially supported: pipelines.complete-translation, rendered without missing parameters', () => {
    const t = translate(PARTIAL);
    expect(t.postTasks.map((p) => p.code)).toEqual(['pipelines.complete-translation']);
    expect((t.desired as Pipelines).translation).toEqual({
      supported: false,
      unsupported: ['pipelines.default[0].step.script[1].pipe'],
    });
    const rendered = renderGuidance(
      'pipelines.complete-translation',
      t.postTasks[0]?.params as ParamValues,
    );
    expect(rendered.problems).toEqual([]);
    expect(rendered.summary).toContain('step.script\\[1\\].pipe');
  });

  it('[FAC-PIP-003] disabled pipelines raise the warning only', () => {
    const t = translate(FULL, false);
    expect(t.warnings.map((w) => w.code)).toEqual(['pipelines.disabled']);
    expect([...t.blockers, ...t.preTasks, ...t.postTasks]).toEqual([]);
    expect(renderGuidance('pipelines.disabled', {}).problems).toEqual([]);
  });

  it('[FAC-PIP-004] parity: different before the merge, equal once the target holds the paths', () => {
    const t = translate(FULL);
    const empty: Pipelines = {
      files: [],
      enabled: true,
      translation: { supported: true, unsupported: [] },
    };
    expect(compareFacet(registry, 'pipelines', t.desired, empty)?.status).toBe('different');
    const merged: Pipelines = {
      files: [
        { path: '.github/workflows/ci.yml', sha256: sha256Hex('edited by a human') },
        { path: '.github/workflows/other.yml', sha256: sha256Hex('another') },
      ],
      enabled: false,
      translation: { supported: false, unsupported: ['x'] },
    };
    expect(compareFacet(registry, 'pipelines', t.desired, merged)?.status).toBe('equal');
  });

  it('[FAC-PIP-003] nothing generated: the completion task stays open and no review task is raised', () => {
    const t = translate('pipelines: {}\n');
    expect((t.desired as Pipelines).files).toEqual([]);
    expect(t.postTasks.map((p) => p.code)).toEqual(['pipelines.complete-translation']);
    const empty: Pipelines = {
      files: [],
      enabled: true,
      translation: { supported: true, unsupported: [] },
    };
    const task = { code: 'pipelines.complete-translation', params: t.postTasks[0]?.params };
    expect(pipelinesDefinition.isTaskSatisfied?.(task, empty, [])).toBe(false);
  });

  it('[FAC-PIP-003] generated paths complete the task once the target holds them', () => {
    const t = translate(FULL);
    const task = { code: 'pipelines.review-and-merge', params: t.postTasks[0]?.params };
    const merged: Pipelines = {
      files: [{ path: '.github/workflows/ci.yml', sha256: sha256Hex('x') }],
      enabled: true,
      translation: { supported: true, unsupported: [] },
    };
    expect(pipelinesDefinition.isTaskSatisfied?.(task, merged, [])).toBe(true);
  });
});
