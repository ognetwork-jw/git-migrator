import { describe, expect, it } from 'vitest';
import { facetBadges } from './facet-strip.tsx';
import { splitBytes, splitDuration } from './format.ts';
import {
  buildFindMany,
  buildOrderBy,
  buildWhere,
  DEFAULT_SORT,
  DONE_STATUSES,
  defaultFilters,
  PAGE_SIZE,
  parseInitialFilters,
  SORT_FIELDS,
} from './query.ts';

describe('[UI-021] the repositories query runs on the server', () => {
  it('[UI-021] defaults to the unmigrated filter: every status but verified and manually_completed (LIF-001) for repository-scope Migrations', () => {
    expect(buildWhere(defaultFilters('r1'))).toEqual({
      scope: 'repository',
      routeId: 'r1',
      status: { notIn: ['verified', 'manually_completed'] },
    });
    expect(DONE_STATUSES).toEqual(['verified', 'manually_completed']);
  });

  it('[UI-021] maps every filter to a where clause', () => {
    const where = buildWhere({
      routeId: 'r1',
      namespaceId: 'ns1',
      status: 'failed',
      readiness: 'blocked',
      sizeClass: 'large',
      waveId: 'w1',
      blockerCode: ' naming.collision ',
      hasOpenTasks: true,
      search: ' api ',
    });
    expect(where).toEqual({
      scope: 'repository',
      routeId: 'r1',
      status: 'failed',
      readiness: 'blocked',
      waveId: 'w1',
      blockerCodes: { has: 'naming.collision' },
      manualTasks: { some: { status: 'open' } },
      sourceRepository: {
        namespaceId: 'ns1',
        sizeClass: 'large',
        OR: [
          { name: { contains: 'api', mode: 'insensitive' } },
          { fullPath: { contains: 'api', mode: 'insensitive' } },
        ],
      },
    });
  });

  it('[UI-021] the all-statuses filter adds no status clause', () => {
    expect(buildWhere({ ...defaultFilters('r1'), status: 'all' })).not.toHaveProperty('status');
  });

  it('[UI-021] every sortable column has an order with the id as tie-breaker', () => {
    for (const field of SORT_FIELDS) {
      const order = buildOrderBy({ field, order: 'desc' });
      expect(order).toHaveLength(2);
      expect(order[1]).toEqual({ id: 'asc' });
    }
    expect(buildOrderBy({ field: 'path', order: 'asc' })[0]).toEqual({
      sourceRepository: { fullPath: 'asc' },
    });
    expect(buildOrderBy({ field: 'analyzed', order: 'desc' })[0]).toEqual({
      latestAnalysis: { createdAt: 'desc' },
    });
  });

  it('[UI-021] pages are 50 rows and skip the earlier pages', () => {
    expect(PAGE_SIZE).toBe(50);
    const first = buildFindMany(defaultFilters('r1'), DEFAULT_SORT, 1);
    const third = buildFindMany(defaultFilters('r1'), DEFAULT_SORT, 3);
    expect([first.skip, first.take]).toEqual([0, 50]);
    expect([third.skip, third.take]).toEqual([100, 50]);
    expect(buildFindMany(defaultFilters('r1'), DEFAULT_SORT, 0).skip).toBe(0);
  });

  it('[UI-021] the Facet badge strip has one badge per Facet: by its worst finding, or clean when it only has steps', () => {
    const badges = facetBadges({
      createdAt: '2026-10-01T00:00:00Z',
      items: [
        { facetKey: 'refs', kind: 'step' },
        { facetKey: 'hooks', kind: 'warning' },
        { facetKey: 'hooks', kind: 'pre_task' },
        { facetKey: 'branch-rules', kind: 'post_task' },
        { facetKey: 'branch-rules', kind: 'blocker' },
      ],
    });
    expect(badges).toEqual([
      { facetKey: 'branch-rules', worst: 'blocker', count: 2 },
      { facetKey: 'hooks', worst: 'pre_task', count: 2 },
      { facetKey: 'refs', worst: null, count: 0 },
    ]);
    expect(facetBadges(null)).toEqual([]);
    // A clean Analysis still names its Facets.
    expect(
      facetBadges({
        createdAt: '2026-10-01T00:00:00Z',
        items: [{ facetKey: 'refs', kind: 'step' }],
      }),
    ).toEqual([{ facetKey: 'refs', worst: null, count: 0 }]);
  });

  it('[UI-021] sizes and durations are split into a unit and a short number', () => {
    expect(splitBytes(512)).toEqual({ unit: 'bytes', value: '512' });
    expect(splitBytes(1536)).toEqual({ unit: 'kib', value: '1.5' });
    expect(splitBytes(3 * 1024 ** 3)).toEqual({ unit: 'gib', value: '3.0' });
    expect(splitBytes(20 * 1024 ** 4)).toEqual({ unit: 'tib', value: '20' });
    expect(splitDuration(30)).toEqual({ unit: 'seconds', count: 30 });
    expect(splitDuration(7200)).toEqual({ unit: 'hours', count: 2 });
    expect(splitDuration(90_000)).toEqual({ unit: 'days', count: 1 });
    expect(splitDuration(600)).toEqual({ unit: 'minutes', count: 10 });
  });
});

describe('[UI-021] pre-filtered entry', () => {
  it('[UI-021] reads the Route, status and readiness from the address and ignores unknown values', () => {
    expect(parseInitialFilters({ route: 'r2', status: 'failed', readiness: 'blocked' })).toEqual({
      routeId: 'r2',
      filters: { status: 'failed', readiness: 'blocked' },
    });
    expect(parseInitialFilters({ status: 'all' })).toEqual({ filters: { status: 'all' } });
    expect(parseInitialFilters({ status: 'bogus', readiness: ['ready'], route: '' })).toEqual({
      filters: {},
    });
    expect(parseInitialFilters({ status: ['failed', 'all'], route: ['r1'] })).toEqual({
      filters: {},
    });
    expect(parseInitialFilters({ readiness: 'meh', status: undefined })).toEqual({ filters: {} });
  });
});
