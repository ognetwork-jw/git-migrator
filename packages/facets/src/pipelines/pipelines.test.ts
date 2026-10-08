import type { Pipelines } from '@git-migrator/canonical';
import {
  compareFacet,
  type FacetCapability,
  FacetRegistry,
  resolveRoutePolicies,
  type TranslateEnvironment,
  translateFacet,
} from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import {
  comparePipelines,
  isPipelinesTaskSatisfied,
  normalizePipelines,
  PIPELINES_COMPLETE_TRANSLATION,
  PIPELINES_DISABLED,
  PIPELINES_REVIEW_AND_MERGE,
  pipelinesDefinition,
} from './index.ts';

const registry = new FacetRegistry().register(pipelinesDefinition);
const unresolved = { resolve: () => ({ status: 'unmapped' as const }) };
const env: TranslateEnvironment = {
  identities: unresolved,
  groups: unresolved,
  policies: resolveRoutePolicies({}),
  route: {},
  routeIndex: {},
};
const SHA = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const file = (path: string, sha256 = SHA) => ({ path, sha256 });
const doc = (over: Partial<Pipelines> = {}): Pipelines => ({
  files: [],
  enabled: true,
  translation: { supported: true, unsupported: [] },
  ...over,
});
const translate = (source: Pipelines, sourceCaps?: FacetCapability) =>
  translateFacet(registry, 'pipelines', source, { env, sourceCaps });

describe('pipelines facet', () => {
  it('[FAC-PIP-002] normalize sorts and dedupes unsupported paths and keeps supported consistent', () => {
    const n = normalizePipelines(
      doc({ translation: { supported: true, unsupported: ['b', 'a', 'b'] } }),
    );
    expect(n.translation).toEqual({ supported: false, unsupported: ['a', 'b'] });
    expect(normalizePipelines(doc()).translation).toEqual({ supported: true, unsupported: [] });
    expect(
      normalizePipelines(doc({ translation: { supported: false, unsupported: [] } })).translation
        .supported,
    ).toBe(false);
  });

  it('[FAC-PIP-001] a repository without a pipeline file translates to an empty, supported document', () => {
    const t = translate(doc());
    expect(t.desired).toEqual(doc());
    expect([...t.blockers, ...t.preTasks, ...t.postTasks, ...t.warnings]).toEqual([]);
  });

  it('[FAC-PIP-001] an unreadable pipeline file defaults to nothing, without a task', () => {
    const t = translate(doc(), {
      read: true,
      write: false,
      fields: { '/files': { kind: 'unreadable' } },
    });
    expect(t.desired).toEqual(doc());
    expect(t.decisions.map((d) => [d.path, d.fidelity])).toEqual([['/files', 'unreadable']]);
    expect(t.postTasks).toEqual([]);
  });

  it('[FAC-PIP-003] pipelines disabled with a file present raises warning pipelines.disabled and generates nothing', () => {
    const t = translate(doc({ enabled: false, files: [file('pipeline-source.yml')] }));
    expect((t.desired as Pipelines).files).toEqual([]);
    expect(t.warnings.map((w) => w.code)).toEqual([PIPELINES_DISABLED]);
    expect(t.postTasks).toEqual([]);
  });

  it('[FAC-PIP-003] a pair without an override fails closed with pipelines.complete-translation', () => {
    const t = translate(doc({ files: [file('pipeline-source.yml')] }));
    expect((t.desired as Pipelines).files).toEqual([]);
    expect((t.desired as Pipelines).translation).toEqual({
      supported: false,
      unsupported: ['pipeline-source.yml'],
    });
    expect(t.postTasks.map((p) => [p.code, p.verifiable])).toEqual([
      [PIPELINES_COMPLETE_TRANSLATION, true],
    ]);
  });

  it('[FAC-PIP-003] declares exactly the three spec finding codes with their kinds', () => {
    expect(pipelinesDefinition.findingCodes).toEqual({
      [PIPELINES_REVIEW_AND_MERGE]: { kind: 'post', completion: 'parity' },
      [PIPELINES_COMPLETE_TRANSLATION]: { kind: 'post', completion: 'parity' },
      [PIPELINES_DISABLED]: { kind: 'warning' },
    });
    expect(pipelinesDefinition.policyKeys).toEqual([]);
    expect(pipelinesDefinition.dependsOn).toEqual(['git-refs', 'variables', 'secrets']);
  });
});

describe('pipelines parity (FAC-PIP-004)', () => {
  const desired = doc({
    files: [file('generated/ci.yml'), file('generated/custom-x.yml')],
  });

  it('[FAC-PIP-004] is equal when the target contains every generated workflow path', () => {
    const actual = doc({
      files: [
        file('generated/ci.yml', SHA_B),
        file('generated/custom-x.yml', SHA_B),
        file('generated/other.yml'),
      ],
    });
    expect(comparePipelines(desired, actual)).toEqual([]);
  });

  it('[FAC-PIP-004] ignores sha256, enabled and translation', () => {
    const actual = doc({
      enabled: false,
      translation: { supported: false, unsupported: ['x'] },
      files: [file('generated/ci.yml', SHA_B), file('generated/custom-x.yml', SHA_B)],
    });
    expect(comparePipelines(desired, actual)).toEqual([]);
  });

  it('[FAC-PIP-004] before the merge the facet is different: a missing path is a difference', () => {
    const diffs = comparePipelines(desired, doc({ files: [file('generated/ci.yml')] }));
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.path).toContain('custom-x.yml');
    expect(diffs[0]?.actual).toBeUndefined();
    expect(comparePipelines(desired, doc())).toHaveLength(2);
  });

  it('[FAC-PIP-004] runs through the engine as a full comparison', () => {
    const diffs = compareFacet(registry, 'pipelines', desired, doc());
    expect(diffs?.status).toBe('different');
    expect(diffs?.diffs.length).toBe(2);
  });

  it('[FAC-PIP-003] both delivery tasks complete by parity once the target holds the listed paths', () => {
    const paths = desired.files.map((f) => f.path);
    const task = { code: PIPELINES_REVIEW_AND_MERGE, params: { workflowPaths: paths } };
    expect(isPipelinesTaskSatisfied(task, desired, [])).toBe(true);
    expect(
      isPipelinesTaskSatisfied(task, desired, [
        { path: '/files[path=x]/path', desired: 'x', actual: undefined },
      ]),
    ).toBe(false);
    expect(isPipelinesTaskSatisfied(task, doc(), [])).toBe(false);
  });

  it('[FAC-PIP-003] a task that lists no generated path never completes by parity', () => {
    for (const params of [{ workflowPaths: [] }, {}, null, { workflowPaths: 'x' }]) {
      const task = { code: PIPELINES_COMPLETE_TRANSLATION, params };
      expect(isPipelinesTaskSatisfied(task, desired, [])).toBe(false);
      expect(isPipelinesTaskSatisfied(task, doc(), [])).toBe(false);
    }
  });

  it('[FAC-PIP-003] the facet names no target path or provider', () => {
    const t = translate(doc({ files: [file('pipeline-source.yml')] }));
    expect(JSON.stringify(t.postTasks)).not.toMatch(/github|workflows/i);
  });
});
