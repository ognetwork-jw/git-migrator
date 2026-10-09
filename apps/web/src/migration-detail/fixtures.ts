import type { DiffFacet, MigrationDetail, MigrationDiff, RunSummaryRow, TaskRow } from './api.ts';

/** Test builders for the repository detail page. Used only by tests. */

export const migration = (extra: Partial<MigrationDetail> = {}): MigrationDetail => ({
  id: 'm1',
  scope: 'repository',
  status: 'analyzed',
  readiness: 'ready',
  readinessCounts: { blockers: 0, preTasks: 0, postTasks: 1, warnings: 0 },
  plannedTargetName: 'plat-api',
  blockerCodes: [],
  runBlockers: [],
  waveId: null,
  targetCreatedByFramework: false,
  sourceReadOnlyApplied: false,
  analysisStaleAt: null,
  verifiedAt: null,
  lastParityAt: null,
  manualCompletion: null,
  route: {
    id: 'r1',
    targetNamespacePath: 'acme-org',
    sourceEndpoint: { displayName: 'Source main' },
    targetEndpoint: { displayName: 'Target main' },
  },
  sourceRepository: { id: 's1', fullPath: 'ws/plat/api' },
  targetRepository: null,
  wave: null,
  latestAnalysis: {
    id: 'a1',
    createdAt: '2026-10-01T10:00:00.000Z',
    items: [
      {
        id: 'p1',
        facetKey: 'secrets',
        kind: 'post_task',
        code: 'secrets.set-value',
        fieldPaths: [],
        params: { names: ['API_TOKEN'], scope: 'repository' },
        order: 1,
      },
      {
        id: 'p2',
        facetKey: 'branch-rules',
        kind: 'warning',
        code: 'branch-rules.branching-model',
        fieldPaths: [],
        params: {},
        order: 2,
      },
      {
        id: 'p3',
        facetKey: 'git-refs',
        kind: 'step',
        code: 'git-refs.push',
        fieldPaths: [],
        params: {},
        order: 3,
      },
    ],
  },
  ...extra,
});

export const run = (n: number, extra: Partial<RunSummaryRow> = {}): RunSummaryRow => ({
  id: `run${n}`,
  kind: 'migrate',
  status: 'succeeded',
  createdAt: '2026-10-02T10:00:00.000Z',
  startedAt: '2026-10-02T10:00:01.000Z',
  finishedAt: '2026-10-02T10:05:00.000Z',
  hasMutations: true,
  triggeredBy: { displayName: 'Ada' },
  ...extra,
});

export const task = (n: number, extra: Partial<TaskRow> = {}): TaskRow => ({
  id: `t${n}`,
  facetKey: 'secrets',
  code: 'secrets.set-value',
  phase: 'post',
  origin: 'analysis',
  params: { names: ['API_TOKEN'], scope: 'repository' },
  verifiable: true,
  status: 'open',
  note: null,
  completedAt: null,
  completedBy: null,
  sourcePlanItem: null,
  ...extra,
});

export const diffFacet = (extra: Partial<DiffFacet> = {}): DiffFacet => ({
  facetKey: 'branch-rules',
  source: { rules: [{ pattern: 'main', restrictPushes: ['a'] }] },
  desired: { rules: [{ pattern: 'main', restrictPushes: ['a'] }] },
  target: { rules: [{ pattern: 'main', restrictPushes: [] }] },
  sourceUnreadable: [],
  targetUnreadable: [],
  sourceFetchedAt: '2026-10-01T09:00:00.000Z',
  targetFetchedAt: '2026-10-01T09:30:00.000Z',
  decisions: [
    {
      path: '/rules[pattern=main]/restrictPushes',
      fidelity: 'lossy',
      accepted: false,
      policyKey: 'branch-rules.x',
    },
  ],
  overridden: null,
  parity: {
    status: 'different',
    checkedAt: '2026-10-01T10:00:00.000Z',
    diffs: [{ path: '/rules[pattern=main]/restrictPushes', source: ['a'], target: [] }],
    excluded: [],
  },
  expectedDifferences: [
    { id: 'ed1', path: '/description', reason: 'manual_accepted', note: 'fine', migrationId: 'm1' },
    { id: 'ed2', path: '/x', reason: 'framework_mutation', note: null, migrationId: 'm1' },
  ],
  ...extra,
});

export const diff = (facets: DiffFacet[] = [diffFacet()]): MigrationDiff => ({
  migrationId: 'm1',
  analysisId: 'a1',
  analyzedAt: '2026-10-01T10:00:00.000Z',
  facets,
});
