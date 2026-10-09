'use client';

import { can } from '@git-migrator/auth/capabilities';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TableColumnsType } from 'antd';
import { Alert, Button, Checkbox, Input, Modal, Select, Space, Table, Typography } from 'antd';
import type { SorterResult } from 'antd/es/table/interface';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../api/http.ts';
import { formatDateTime } from '../format.ts';
import { ErrorAlert, RouteSelect, useRouteChoice } from '../mapping/shared.tsx';
import { useActor } from '../shell/actor-context.tsx';
import { useLiveTopics } from '../shell/live-topics.tsx';
import {
  analyzeMigration,
  countMatching,
  fetchNamespaces,
  fetchRepositoryPage,
  fetchWaves,
  namespacesKey,
  type RepositoryRow,
  type RowRunKind,
  repositoriesKey,
  repositoryPageKey,
  startMigrationRun,
  wavesKey,
} from './api.ts';
import { BulkBar } from './bulk-bar.tsx';
import { FacetStrip } from './facet-strip.tsx';
import { splitBytes } from './format.ts';
import {
  DEFAULT_SORT,
  defaultFilters,
  MIGRATION_STATUSES,
  PAGE_SIZE,
  READINESS_VALUES,
  type Readiness,
  type RepositoryFilters,
  type RepositorySort,
  SIZE_CLASSES,
  type SizeClass,
  type SortField,
  type StatusFilter,
} from './query.ts';
import { type RepositorySelection, useRepositorySelection } from './selection.ts';
import { MigrationStatusTag, ReadinessTag } from './tags.tsx';

/** The topics the list follows (JOB-060, ADR-0270). The shell's one connection carries them (ADR-0350). */
export const REPOSITORY_TOPICS: readonly string[] = [
  'list:migrations',
  'list:runs',
  'list:tasks',
  'list:repositories',
];

const repositoryKeys = () => [repositoriesKey];

type FilterState = Omit<RepositoryFilters, 'routeId'>;
const initialFilters = (): FilterState => {
  const { routeId: _routeId, ...rest } = defaultFilters('');
  return rest;
};

/** Selected ids above this are not checked against the filters (the check is one GET). */
const MAX_HIDDEN_CHECK = 100;

export interface RepositoriesViewProps {
  /** Opens the list on this Route (for links from the dashboard). */
  /** Rows per page (default 50, UI-021); tests use a small page. */
  readonly pageSize?: number;
  readonly initialRouteId?: string;
  /** Opens the list with these filters instead of the defaults. */
  readonly initialFilters?: Partial<FilterState>;
  /** Replaces the default bulk bar (UI-021, T-088). */
  readonly bulkBar?: (selection: RepositorySelection) => ReactNode;
}

/** UI-021: the repositories list, filtered, sorted and paged on the server. */
export function RepositoriesView({
  bulkBar,
  pageSize = PAGE_SIZE,
  initialRouteId,
  initialFilters: initial,
}: RepositoriesViewProps) {
  const t = useTranslations('repositories');
  const tStatus = useTranslations('migrationStatus');
  const tReadiness = useTranslations('readiness');
  const tRun = useTranslations('runKind');
  const tRunStatus = useTranslations('runStatus');
  const actor = useActor();
  const operator = can(actor, 'operate');
  const queryClient = useQueryClient();
  const [chosenRoute, setChosenRoute] = useState<string | undefined>(initialRouteId);
  const { routes, routeId, query: routesQuery } = useRouteChoice(chosenRoute);
  const route = routes.find((r) => r.id === routeId);
  // A link to a Route that does not exist (any more) opens the first Route and says so.
  const unknownRoute =
    initialRouteId !== undefined &&
    chosenRoute === initialRouteId &&
    routesQuery.isSuccess &&
    !routes.some((r) => r.id === initialRouteId);

  const [filters, setFilters] = useState<FilterState>(() => ({ ...initialFilters(), ...initial }));
  const [sort, setSort] = useState<RepositorySort>(DEFAULT_SORT);
  const [page, setPage] = useState(1);
  const selection = useRepositorySelection();
  const [accepted, setAccepted] = useState(false);
  // The Run a row action asks to start, until the operator confirms or cancels it (LIF-005).
  const [pendingRun, setPendingRun] = useState<
    { readonly row: RepositoryRow; readonly kind: RowRunKind } | undefined
  >(undefined);

  useLiveTopics(REPOSITORY_TOPICS, repositoryKeys);

  const effective: RepositoryFilters = { ...filters, routeId: routeId ?? '' };
  const list = useQuery({
    queryKey: repositoryPageKey(effective, sort, page, pageSize),
    enabled: routeId !== undefined,
    queryFn: () => fetchRepositoryPage(effective, sort, page, pageSize),
    placeholderData: keepPreviousData,
  });
  const namespaces = useQuery({
    queryKey: namespacesKey(route?.sourceEndpointId ?? ''),
    enabled: route !== undefined,
    queryFn: () => fetchNamespaces(route?.sourceEndpointId as string),
  });
  const waves = useQuery({ queryKey: wavesKey, queryFn: fetchWaves });

  // A page past the end (the list shrank) falls back to the last page.
  const total = list.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => {
    if (list.isSuccess && page > lastPage) setPage(lastPage);
  }, [list.isSuccess, page, lastPage]);

  const change = (patch: Partial<FilterState>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  };

  const act = useMutation({
    mutationFn: (id: string) => analyzeMigration(id),
    onMutate: () => setAccepted(false),
    onSuccess: () => {
      setAccepted(true);
      return queryClient.invalidateQueries({ queryKey: repositoriesKey });
    },
  });

  const startRun = useMutation({
    mutationFn: (input: { id: string; kind: RowRunKind }) =>
      startMigrationRun(input.id, input.kind),
    onMutate: () => {
      setAccepted(false);
      act.reset();
    },
    onSuccess: () => {
      setPendingRun(undefined);
      setAccepted(true);
      return queryClient.invalidateQueries({ queryKey: repositoriesKey });
    },
    // The dialog closes on failure too: the error is shown on the page, and a 409 or 422 means the
    // list it was opened from is out of date.
    onError: () => {
      setPendingRun(undefined);
      return queryClient.invalidateQueries({ queryKey: repositoriesKey });
    },
  });

  // How many selected rows the current filters hide (the selection outlives filter changes).
  const selectedIds = useDebounced(selection.ids, 200);
  const matching = useQuery({
    queryKey: [...repositoriesKey, 'selection', effective, selectedIds],
    enabled:
      routeId !== undefined && selectedIds.length > 0 && selectedIds.length <= MAX_HIDDEN_CHECK,
    queryFn: () => countMatching(effective, selectedIds),
    placeholderData: keepPreviousData,
  });
  const hidden =
    selectedIds.length > 0 && selectedIds.length <= MAX_HIDDEN_CHECK && matching.data !== undefined
      ? Math.max(0, selectedIds.length - matching.data)
      : 0;

  const rows = useMemo(() => list.data?.rows ?? [], [list.data]);
  const data = useMemo(() => [...rows], [rows]);
  const pageIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const analyzing = act.isPending ? act.variables : undefined;
  const starting = startRun.isPending ? startRun.variables?.id : undefined;

  const columns = useMemo(() => {
    const sortOrderOf = (field: SortField) =>
      sort.field !== field
        ? null
        : sort.order === 'asc'
          ? ('ascend' as const)
          : ('descend' as const);
    const sizeLabel = (row: RepositoryRow) => {
      const raw = row.sourceRepository?.sizeBytes;
      if (raw === null || raw === undefined) return t('size.unknown');
      const { unit, value } = splitBytes(Number(raw));
      return t(`size.${unit}`, { value });
    };
    const cols: TableColumnsType<RepositoryRow> = [
      {
        title: t('column.source'),
        key: 'path',
        ...{ sorter: true, sortOrder: sortOrderOf('path') },
        render: (_: unknown, row) => (
          <Link href={`/repositories/${encodeURIComponent(row.id)}`}>
            {row.sourceRepository?.fullPath ?? row.id}
          </Link>
        ),
      },
      {
        title: t('column.target'),
        key: 'target',
        sorter: true,
        sortOrder: sortOrderOf('target'),
        render: (_: unknown, row) => row.plannedTargetName ?? '',
      },
      {
        title: t('column.status'),
        key: 'status',
        sorter: true,
        sortOrder: sortOrderOf('status'),
        render: (_: unknown, row) => <MigrationStatusTag status={row.status} />,
      },
      {
        title: t('column.readiness'),
        key: 'readiness',
        sorter: true,
        sortOrder: sortOrderOf('readiness'),
        render: (_: unknown, row) => {
          const counts = row.readinessCounts;
          const blockers = counts?.blockers ?? 0;
          const pre = counts?.preTasks ?? 0;
          const post = counts?.postTasks ?? 0;
          return (
            <div className="flex flex-col gap-1">
              <ReadinessTag readiness={row.readiness} />
              {counts ? (
                <Typography.Text
                  type="secondary"
                  className="text-xs"
                  aria-label={t('counts.label', { blockers, pre, post })}
                >
                  {t('counts.blockers', { count: blockers })}, {t('counts.pre', { count: pre })},{' '}
                  {t('counts.post', { count: post })}
                </Typography.Text>
              ) : null}
            </div>
          );
        },
      },
      {
        title: t('column.facets'),
        key: 'facets',
        render: (_: unknown, row) => <FacetStrip analysis={row.latestAnalysis} />,
      },
      {
        title: t('column.size'),
        key: 'size',
        sorter: true,
        sortOrder: sortOrderOf('size'),
        render: (_: unknown, row) => sizeLabel(row),
      },
      {
        title: t('column.wave'),
        key: 'wave',
        sorter: true,
        sortOrder: sortOrderOf('wave'),
        render: (_: unknown, row) => row.wave?.name ?? t('noWave'),
      },
      {
        title: t('column.analyzed'),
        key: 'analyzed',
        sorter: true,
        sortOrder: sortOrderOf('analyzed'),
        render: (_: unknown, row) =>
          row.latestAnalysis ? formatDateTime(row.latestAnalysis.createdAt) : t('notAnalyzed'),
      },
      {
        title: t('column.lastRun'),
        key: 'lastRun',
        render: (_: unknown, row) => {
          const run = row.runs[0];
          if (run === undefined) return t('never');
          return t('lastRun', {
            kind: tRun.has(run.kind) ? tRun(run.kind) : run.kind,
            status: tRunStatus.has(run.status) ? tRunStatus(run.status) : run.status,
            when: formatDateTime(run.finishedAt ?? run.createdAt),
          });
        },
      },
      ...(operator
        ? [
            {
              title: t('column.actions'),
              key: 'actions',
              render: (_: unknown, row: RepositoryRow) => {
                // Only a Migration that can take the Run offers it; the server decides again.
                const idle = row.status !== 'running' && row.status !== 'source_missing';
                return (
                  <Space size="small" wrap>
                    <Button
                      size="small"
                      loading={analyzing === row.id}
                      onClick={() => act.mutate(row.id)}
                    >
                      {t('action.analyze')}
                    </Button>
                    {row.readiness === 'ready' && idle ? (
                      <Button
                        size="small"
                        type="primary"
                        loading={starting === row.id}
                        onClick={() => setPendingRun({ row, kind: 'migrate' })}
                      >
                        {t('action.migrate')}
                      </Button>
                    ) : null}
                    {row.readiness === 'needs_attention' && idle ? (
                      <Button
                        size="small"
                        danger
                        loading={starting === row.id}
                        onClick={() => setPendingRun({ row, kind: 'run_anyway' })}
                      >
                        {t('action.runAnyway')}
                      </Button>
                    ) : null}
                  </Space>
                );
              },
            },
          ]
        : []),
    ];
    return cols;
  }, [sort, operator, analyzing, starting, t, tRun, tRunStatus, act.mutate]);

  if (routesQuery.isError) return <ErrorAlert error={routesQuery.error} />;
  if (routesQuery.isSuccess && routeId === undefined) {
    return <Typography.Paragraph type="secondary">{t('noRoutes')}</Typography.Paragraph>;
  }

  return (
    <div className="flex flex-col gap-4">
      <Space wrap align="end">
        <RouteSelect
          routes={routes}
          value={routeId}
          onChange={(id) => {
            setChosenRoute(id);
            selection.clear();
            change({ namespaceId: undefined });
          }}
        />
        <Select
          allowClear
          aria-label={t('filter.namespace')}
          placeholder={t('filter.allNamespaces')}
          className="min-w-44"
          value={filters.namespaceId}
          onChange={(value?: string) => change({ namespaceId: value })}
          options={(namespaces.data ?? []).map((n) => ({ value: n.id, label: n.name }))}
        />
        <Select
          aria-label={t('filter.status')}
          className="min-w-44"
          value={filters.status}
          onChange={(value: StatusFilter) => change({ status: value })}
          options={[
            { value: 'unmigrated', label: t('filter.unmigrated') },
            { value: 'all', label: t('filter.allStatuses') },
            ...MIGRATION_STATUSES.map((s) => ({ value: s, label: tStatus(s) })),
          ]}
        />
        <Select
          allowClear
          aria-label={t('filter.readiness')}
          placeholder={t('filter.allReadiness')}
          className="min-w-44"
          value={filters.readiness}
          onChange={(value?: Readiness) => change({ readiness: value })}
          options={READINESS_VALUES.map((r) => ({ value: r, label: tReadiness(r) }))}
        />
        <Select
          allowClear
          aria-label={t('filter.sizeClass')}
          placeholder={t('filter.allSizes')}
          className="min-w-36"
          value={filters.sizeClass}
          onChange={(value?: SizeClass) => change({ sizeClass: value })}
          options={SIZE_CLASSES.map((s) => ({ value: s, label: t(`sizeClass.${s}`) }))}
        />
        <Select
          allowClear
          aria-label={t('filter.wave')}
          placeholder={t('filter.allWaves')}
          className="min-w-36"
          value={filters.waveId}
          onChange={(value?: string) => change({ waveId: value })}
          options={(waves.data ?? []).map((w) => ({ value: w.id, label: w.name }))}
        />
        <Input.Search
          allowClear
          aria-label={t('filter.blockerCode')}
          placeholder={t('filter.blockerCodePlaceholder')}
          className="w-64"
          onSearch={(value) => change({ blockerCode: value.trim() || undefined })}
        />
        <Input.Search
          allowClear
          aria-label={t('filter.search')}
          placeholder={t('filter.searchPlaceholder')}
          className="w-64"
          onSearch={(value) => change({ search: value })}
        />
        <Checkbox
          checked={filters.hasOpenTasks}
          onChange={(event) => change({ hasOpenTasks: event.target.checked })}
        >
          {t('filter.hasOpenTasks')}
        </Checkbox>
      </Space>

      <div className="flex flex-wrap items-center gap-3" aria-live="polite">
        <Typography.Text type="secondary">{t('total', { count: total })}</Typography.Text>
        {selection.count > 0 ? (
          <>
            <Typography.Text strong>
              {hidden > 0
                ? t('selection.hidden', { count: selection.count, hidden })
                : t('selection.count', { count: selection.count })}
            </Typography.Text>
            <Button size="small" onClick={selection.clear}>
              {t('selection.clear')}
            </Button>
          </>
        ) : null}
        {operator ? bulkBar ? bulkBar(selection) : <BulkBar selection={selection} /> : null}
      </div>

      {unknownRoute ? (
        <Alert
          type="warning"
          showIcon
          title={t('routeNotFound', { id: initialRouteId ?? '', shown: routeId ?? '' })}
        />
      ) : null}
      {list.isError ? <ErrorAlert error={list.error} /> : null}
      {act.isError ? <ActionError error={act.error} /> : null}
      {startRun.isError ? <ActionError error={startRun.error} run /> : null}
      {accepted && !act.isError && !startRun.isError ? (
        <Alert type="success" showIcon title={t('action.queued')} />
      ) : null}

      <Table<RepositoryRow>
        rowKey="id"
        size="middle"
        loading={list.isLoading || list.isFetching}
        dataSource={data}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('empty') }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: false,
          hideOnSinglePage: true,
          onChange: setPage,
        }}
        onChange={(_pagination, _filters, sorter, extra) => {
          if (extra.action !== 'sort') return;
          const single = (Array.isArray(sorter) ? sorter[0] : sorter) as
            | SorterResult<RepositoryRow>
            | undefined;
          const field = single?.columnKey as SortField | undefined;
          if (field === undefined || !single?.order) setSort(DEFAULT_SORT);
          else setSort({ field, order: single.order === 'ascend' ? 'asc' : 'desc' });
          setPage(1);
        }}
        rowSelection={{
          selectedRowKeys: selection.ids as string[],
          preserveSelectedRowKeys: true,
          getCheckboxProps: (row) => ({
            'aria-label': t('selection.label', { name: row.sourceRepository?.fullPath ?? row.id }),
          }),
          onChange: (keys, selected) =>
            selection.replaceOnPage(
              pageIds,
              keys.map(String),
              selected.map((r) => ({
                id: r.id,
                readiness: r.readiness,
                path: r.sourceRepository?.fullPath ?? r.id,
              })),
            ),
        }}
        columns={columns}
      />
      <RunConfirmModal
        pending={
          // Read the row from the live list: its counts may have changed since the dialog opened.
          pendingRun
            ? { ...pendingRun, row: rows.find((r) => r.id === pendingRun.row.id) ?? pendingRun.row }
            : undefined
        }
        loading={startRun.isPending}
        onCancel={() => setPendingRun(undefined)}
        onConfirm={(pending) => startRun.mutate({ id: pending.row.id, kind: pending.kind })}
      />
    </div>
  );
}

/**
 * The confirmation before a Run starts (LIF-005, LIF-006). Run anyway names what it skips: the open
 * pre tasks the Migration still has.
 */
function RunConfirmModal({
  pending,
  loading,
  onCancel,
  onConfirm,
}: {
  readonly pending: { readonly row: RepositoryRow; readonly kind: RowRunKind } | undefined;
  readonly loading: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (pending: { readonly row: RepositoryRow; readonly kind: RowRunKind }) => void;
}) {
  const t = useTranslations('repositories.runConfirm');
  const name = pending?.row.sourceRepository?.fullPath ?? pending?.row.id ?? '';
  const target = pending?.row.plannedTargetName ?? '';
  const kind = pending?.kind ?? 'migrate';
  const preTasks = pending?.row.readinessCounts?.preTasks ?? 0;
  return (
    <Modal
      open={pending !== undefined}
      title={t(`${kind}.title`, { name })}
      okText={t(`${kind}.ok`)}
      cancelText={t('cancel')}
      okButtonProps={{ danger: kind === 'run_anyway', loading }}
      cancelButtonProps={{ disabled: loading }}
      onOk={() => pending && onConfirm(pending)}
      onCancel={loading ? undefined : onCancel}
      destroyOnHidden
    >
      <Typography.Paragraph>{t(`${kind}.body`, { name, target })}</Typography.Paragraph>
      {kind === 'run_anyway' ? (
        <Alert type="warning" showIcon title={t('run_anyway.warning', { count: preTasks })} />
      ) : null}
    </Modal>
  );
}

/** A failed row action: 409 and 422 have their own texts, the rest use the generic problem text. */
function ActionError({ error, run = false }: { readonly error: unknown; readonly run?: boolean }) {
  const t = useTranslations(run ? 'repositories.runConfirm.error' : 'repositories.action.error');
  if (error instanceof ApiError && t.has(error.code as never)) {
    return <Alert type="error" showIcon role="alert" title={t(error.code as never)} />;
  }
  return <ErrorAlert error={error} />;
}

/** `value`, once it has stopped changing for `ms` (the hidden-rows count waits for a quiet moment). */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
