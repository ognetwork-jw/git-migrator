// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these are workflow expressions, not templates
import type { Pipelines } from '@git-migrator/canonical';
import { resolveRoutePolicies, sha256Hex, type TranslateContext } from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import {
  bitbucketCloudToGithubPipelines,
  DELIVERY_BRANCH,
  PIPELINES_SOURCE_TYPE,
  PIPELINES_TARGET_TYPE,
  translatePipelines,
} from './index.ts';
import { variableNames } from './names.ts';
import { translatePipelinesYaml } from './translate.ts';

const unresolved = { resolve: () => ({ status: 'unmapped' as const }) };

function context(over: Partial<TranslateContext> & { sources?: Record<string, string> } = {}) {
  const { sources, ...rest } = over;
  const ctx: TranslateContext = {
    identities: unresolved,
    groups: unresolved,
    policies: resolveRoutePolicies({}),
    route: {},
    routeIndex: { pipelines: { sources: sources ?? {} } },
    sourceCaps: { read: true, write: false, fields: {} },
    targetCaps: { read: true, write: true, fields: {} },
    deps: {},
    ...rest,
  };
  return ctx;
}

const SIMPLE = 'pipelines:\n  default:\n    - step:\n        script:\n          - make\n';
const WITH_PIPE =
  'pipelines:\n  default:\n    - step:\n        script:\n          - make\n          - pipe: a/b:1\n';

function source(text: string, enabled = true): { doc: Pipelines; sources: Record<string, string> } {
  const sha256 = sha256Hex(text);
  return {
    doc: {
      files: [{ path: 'bitbucket-pipelines.yml', sha256 }],
      enabled,
      translation: { supported: true, unsupported: [] },
    },
    sources: { [sha256]: text },
  };
}

describe('bitbucket-cloud to github pipelines override', () => {
  it('[ADP-032] is registered for exactly the bitbucket-cloud to github pair of the pipelines facet', () => {
    expect(bitbucketCloudToGithubPipelines.source).toBe(PIPELINES_SOURCE_TYPE);
    expect(bitbucketCloudToGithubPipelines.target).toBe(PIPELINES_TARGET_TYPE);
    expect(bitbucketCloudToGithubPipelines.facet).toBe('pipelines');
    expect(bitbucketCloudToGithubPipelines.translate).toBe(translatePipelines);
  });

  it('[FAC-PIP-003] fully supported: the workflows and the post task pipelines.review-and-merge', () => {
    const { doc, sources } = source(SIMPLE);
    const r = translatePipelines(doc, context({ sources }));
    expect(r.desired.files.map((f) => f.path)).toEqual(['.github/workflows/ci.yml']);
    expect(r.desired.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.desired.translation).toEqual({ supported: true, unsupported: [] });
    expect(r.postTasks).toEqual([
      {
        code: 'pipelines.review-and-merge',
        paths: ['/files'],
        params: {
          workflowPath: '.github/workflows/ci.yml',
          workflowPaths: ['.github/workflows/ci.yml'],
          branch: DELIVERY_BRANCH,
        },
        verifiable: true,
      },
    ]);
    expect(DELIVERY_BRANCH).toBe('git-migrator/ci');
    expect(r.decisions).toEqual([]);
    expect([...r.blockers, ...r.preTasks, ...r.warnings]).toEqual([]);
  });

  it('[FAC-PIP-003] partially supported: pipelines.complete-translation lists the unsupported paths', () => {
    const { doc, sources } = source(WITH_PIPE);
    const r = translatePipelines(doc, context({ sources }));
    expect(r.desired.translation).toEqual({
      supported: false,
      unsupported: ['pipelines.default[0].step.script[1].pipe'],
    });
    expect(r.postTasks).toEqual([
      {
        code: 'pipelines.complete-translation',
        paths: ['/translation/unsupported'],
        params: {
          unsupported: ['pipelines.default[0].step.script[1].pipe'],
          workflowPath: '.github/workflows/ci.yml',
          workflowPaths: ['.github/workflows/ci.yml'],
        },
        verifiable: true,
      },
    ]);
    expect(r.decisions).toEqual([
      { path: '/translation/unsupported', fidelity: 'unsupported', accepted: false },
    ]);
    expect(r.desired.files).toHaveLength(1);
  });

  it('[FAC-PIP-003] the file hash is the hash of the generated workflow', () => {
    const { doc, sources } = source(SIMPLE);
    const a = translatePipelines(doc, context({ sources }));
    const b = translatePipelines(doc, context({ sources }));
    expect(a.desired).toEqual(b.desired);
  });

  it('[FAC-PIP-003] pipelines disabled with a file present: no workflow and warning pipelines.disabled', () => {
    const { doc, sources } = source(SIMPLE, false);
    const r = translatePipelines(doc, context({ sources }));
    expect(r.desired).toEqual({
      files: [],
      enabled: false,
      translation: { supported: true, unsupported: [] },
    });
    expect(r.warnings).toEqual([{ code: 'pipelines.disabled', paths: ['/enabled'], params: {} }]);
    expect(r.postTasks).toEqual([]);
  });

  it('[FAC-PIP-001] no pipeline file: nothing is generated and nothing is raised', () => {
    const r = translatePipelines(
      { files: [], enabled: true, translation: { supported: true, unsupported: [] } },
      context(),
    );
    expect(r.desired.files).toEqual([]);
    expect([...r.blockers, ...r.preTasks, ...r.postTasks, ...r.warnings, ...r.decisions]).toEqual(
      [],
    );
  });

  it('[FAC-PIP-001] an unreadable pipeline file defaults to nothing, recorded as unreadable_defaulted', () => {
    const r = translatePipelines(
      { files: [], enabled: false, translation: { supported: true, unsupported: [] } },
      context({
        sourceCaps: { read: true, write: false, fields: { '/files': { kind: 'unreadable' } } },
      }),
    );
    expect(r.decisions).toEqual([
      {
        path: '/files',
        fidelity: 'unreadable',
        defaulted: true,
        accepted: false,
        note: 'unreadable_defaulted',
      },
    ]);
  });

  it('[FAC-PIP-001] a file that cannot be parsed is partially supported with nothing generated', () => {
    const { doc, sources } = source('pipelines: [unclosed');
    const r = translatePipelines(doc, context({ sources }));
    expect(r.desired.files).toEqual([]);
    expect(r.desired.translation.supported).toBe(false);
    expect(r.postTasks[0]?.code).toBe('pipelines.complete-translation');
    expect(r.postTasks[0]?.params.workflowPath).toBe('bitbucket-pipelines.yml');
    expect(r.postTasks[0]?.params.workflowPaths).toEqual([]);
    expect(r.desired.translation.unsupported).toEqual(['bitbucket-pipelines.yml']);
  });

  it('[FAC-PIP-002] fails loudly when the caller announces a file but supplies no text', () => {
    const { doc } = source(SIMPLE);
    expect(() => translatePipelines(doc, context())).toThrow(/no text for bitbucket-pipelines.yml/);
  });

  it('[FAC-PIP-002] variable and secret names come from the dependency documents and the route index', () => {
    const text =
      'pipelines:\n  default:\n    - step:\n        script:\n          - echo $A $B $C $D\n';
    const { doc, sources } = source(text);
    const ctx = context({
      routeIndex: {
        pipelines: { sources, workspaceVariables: ['C'], workspaceSecrets: ['D'] },
      },
      deps: {
        variables: { source: {}, desired: { variables: [{ scope: 'repository', name: 'A' }] } },
        secrets: { source: {}, desired: { secrets: [{ scope: 'repository', name: 'B' }] } },
      },
    });
    const r = translatePipelines(doc, ctx);
    const expected = translatePipelinesYaml(
      text,
      variableNames(
        { variables: [{ scope: 'repository', name: 'A' }] },
        { secrets: [{ scope: 'repository', name: 'B' }] },
        { variables: ['C'], secrets: ['D'] },
      ),
    );
    const content = expected.workflows[0]?.content ?? '';
    for (const line of [
      'A: ${{ vars.A }}',
      'B: ${{ secrets.B }}',
      'C: ${{ vars.C }}',
      'D: ${{ secrets.D }}',
    ]) {
      expect(content).toContain(line);
    }
    expect(r.desired.files[0]?.sha256).toBe(sha256Hex(content));
  });

  it('[FAC-PIP-002] malformed dependency documents and route index values are ignored', () => {
    const { doc, sources } = source(SIMPLE);
    const ctx = context({
      routeIndex: { pipelines: { sources, workspaceVariables: 'x', workspaceSecrets: [1, null] } },
      deps: {
        variables: { source: {}, desired: 5 },
        secrets: { source: {}, desired: { secrets: 'x' } },
      },
    });
    expect(translatePipelines(doc, ctx).desired.files).toHaveLength(1);
    expect(() => translatePipelines(doc, context({ routeIndex: { pipelines: 'nope' } }))).toThrow(
      /no text/,
    );
  });

  it('[FAC-PIP-003] a file that yields no workflow keeps pipelines.complete-translation open and raises no review task', () => {
    for (const text of ['pipelines: {}\n', 'pipelines:\n  default: []\n', 'image: node:20\n']) {
      const { doc, sources } = source(text);
      const r = translatePipelines(doc, context({ sources }));
      expect(r.desired.files).toEqual([]);
      expect(r.desired.translation.supported).toBe(false);
      expect(r.desired.translation.unsupported.length).toBeGreaterThan(0);
      expect(r.postTasks.map((t) => t.code)).toEqual(['pipelines.complete-translation']);
      expect(r.postTasks[0]?.params.workflowPaths).toEqual([]);
    }
  });
});
