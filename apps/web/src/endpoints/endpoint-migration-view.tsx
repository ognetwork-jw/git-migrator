'use client';

import { can } from '@git-migrator/auth/capabilities';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Collapse, Empty, Space, Table, Tabs, Tag, Typography } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { formatDateTime } from '../format.ts';
import { ErrorAlert } from '../mapping/shared.tsx';
import { TypedNameDialog } from '../migration-detail/dialogs.tsx';
import { PLACEMENT_UNKNOWN_BLOCKER } from '../migration-detail/rules.ts';
import { FacetStrip } from '../repositories/facet-strip.tsx';
import { MigrationStatusTag, ReadinessTag } from '../repositories/tags.tsx';
import { useActor } from '../shell/actor-context.tsx';
import { useLiveTopics } from '../shell/live-topics.tsx';
import {
  analyzeMigration,
  type DiffFacet,
  diffKey,
  type EndpointRunKind,
  endpointMigrationKey,
  type FindingKind,
  type FindingRow,
  fetchDiff,
  fetchEndpointMigration,
  fetchFindings,
  fetchRuns,
  findingsKey,
  type RunRow,
  runsKey,
  startMigrationRun,
} from './api.ts';

type Shown = Exclude<FindingKind, 'step'>;
const FINDING_ORDER: readonly Shown[] = ['blocker', 'pre_task', 'post_task', 'warning'];
const KIND_COLOR: Record<Shown, string> = {
  blocker: 'error',
  pre_task: 'warning',
  post_task: 'blue',
  warning: 'default',
};

/** What the page follows (ADR-0270): the Migration and its Runs, by id. */
export const migrationTopics = (migrationId: string | undefined): readonly string[] =>
  migrationId === undefined ? ['list:runs'] : [`migration:${migrationId}`, 'list:runs'];

/** A readable JSON rendering of a Facet document (the side-by-side diff shows three of them). */
const pretty = (value: unknown): string =>
  value === null || value === undefined ? '' : JSON.stringify(value, null, 2);

/** The Run kind the Migration's readiness allows (LIF-005, LIF-043), or `undefined`. */
export function runKindFor(
  status: string,
  readiness: string | null,
  stale: boolean,
): EndpointRunKind | undefined {
  if (status === 'running' || stale || readiness === null) return undefined;
  if (readiness === 'ready') return 'migrate';
  return readiness === 'needs_attention' ? 'run_anyway' : undefined;
}

/**
 * The readiness the page offers a Run by. A legacy Migration of unknown place is blocked only by
 * the placement blocker its typed confirmation answers, so its open pre tasks decide (ADR-0504).
 */
export function offeredEndpointReadiness(m: {
  readonly readiness: string | null;
  readonly blockerCodes: readonly string[];
  readonly readinessCounts: { readonly preTasks?: number } | null;
  readonly targetPlacementUnknown?: boolean;
}): string | null {
  if (m.targetPlacementUnknown !== true || m.readiness !== 'blocked') return m.readiness;
  if (
    m.blockerCodes.length === 0 ||
    !m.blockerCodes.every((c) => c === PLACEMENT_UNKNOWN_BLOCKER)
  ) {
    return m.readiness;
  }
  return (m.readinessCounts?.preTasks ?? 0) > 0 ? 'needs_attention' : 'ready';
}

/** The Facet badge strip of the UI-022 layout: one badge per Facet in the Plan, by worst finding. */
function EndpointFacetStrip({ analysisId }: { readonly analysisId: string | null }) {
  const findings = useQuery({
    queryKey: findingsKey(analysisId ?? ''),
    queryFn: () => fetchFindings(analysisId as string),
    enabled: analysisId !== null,
  });
  if (analysisId === null || findings.data === undefined) return null;
  const items = findings.data
    .filter((r) => r.facetKey !== 'framework')
    .map((r) => ({ facetKey: r.facetKey, kind: r.kind }));
  return <FacetStrip analysis={{ createdAt: '', items }} />;
}

function FindingsTab({ analysisId }: { readonly analysisId: string | null }) {
  const t = useTranslations('endpoints.migration');
  const findings = useQuery({
    queryKey: findingsKey(analysisId ?? ''),
    queryFn: () => fetchFindings(analysisId as string),
    enabled: analysisId !== null,
  });
  if (analysisId === null) return <Empty description={t('notAnalyzed')} />;
  if (findings.isError) return <ErrorAlert error={findings.error} />;
  const rows = (findings.data ?? []).filter((r) => r.kind !== 'step');
  if (findings.isSuccess && rows.length === 0) return <Empty description={t('noFindings')} />;
  return (
    <div className="flex flex-col gap-4">
      {FINDING_ORDER.map((kind) => {
        const ofKind = rows.filter((r) => r.kind === kind);
        if (ofKind.length === 0) return null;
        return (
          <section key={kind} aria-label={t(`kind.${kind}`)}>
            <Typography.Title level={5} className="mt-0">
              {t(`kind.${kind}`)} ({ofKind.length})
            </Typography.Title>
            <Table<FindingRow>
              rowKey="id"
              size="small"
              loading={findings.isLoading}
              dataSource={ofKind}
              pagination={false}
              scroll={{ x: 'max-content' }}
              columns={[
                {
                  title: t('finding.code'),
                  key: 'code',
                  render: (_: unknown, row) => (
                    <Tag color={KIND_COLOR[row.kind as Shown]}>{row.code}</Tag>
                  ),
                },
                { title: t('finding.facet'), key: 'facet', dataIndex: 'facetKey' },
                {
                  title: t('finding.paths'),
                  key: 'paths',
                  render: (_: unknown, row) => row.fieldPaths.join(', '),
                },
              ]}
            />
          </section>
        );
      })}
    </div>
  );
}

function FacetsTab({
  migrationId,
  analysisId,
}: {
  readonly migrationId: string;
  readonly analysisId: string | null;
}) {
  const t = useTranslations('endpoints.migration');
  const diff = useQuery({
    queryKey: diffKey(migrationId, analysisId),
    queryFn: () => fetchDiff(migrationId),
    enabled: analysisId !== null,
  });
  if (analysisId === null) return <Empty description={t('notAnalyzed')} />;
  if (diff.isError) return <ErrorAlert error={diff.error} />;
  const facets: readonly DiffFacet[] = diff.data?.facets ?? [];
  if (diff.isSuccess && facets.length === 0) return <Empty description={t('noFacets')} />;
  return (
    <Collapse
      items={facets.map((facet) => ({
        key: facet.facetKey,
        label: (
          <Space>
            <Typography.Text strong>{facet.facetKey}</Typography.Text>
            {facet.parity ? <Tag>{t('facet.parity', { status: facet.parity.status })}</Tag> : null}
            {facet.expectedDifferences.length > 0 ? (
              <Tag>{t('facet.expected', { count: facet.expectedDifferences.length })}</Tag>
            ) : null}
          </Space>
        ),
        children: (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            {(['source', 'desired', 'target'] as const).map((side) => (
              <section key={side} aria-label={t(`facet.${side}`)}>
                <Typography.Title level={5} className="mt-0">
                  {t(`facet.${side}`)}
                </Typography.Title>
                <pre className="m-0 max-h-96 overflow-auto text-xs">{pretty(facet[side])}</pre>
              </section>
            ))}
          </div>
        ),
      }))}
    />
  );
}

function RunsTab({ migrationId }: { readonly migrationId: string }) {
  const t = useTranslations('endpoints.migration');
  const kinds = useTranslations('runKind');
  const statuses = useTranslations('runStatus');
  const runs = useQuery({ queryKey: runsKey(migrationId), queryFn: () => fetchRuns(migrationId) });
  if (runs.isError) return <ErrorAlert error={runs.error} />;
  return (
    <Table<RunRow>
      rowKey="id"
      size="small"
      loading={runs.isLoading}
      dataSource={runs.data ?? []}
      locale={{ emptyText: t('noRuns') }}
      pagination={false}
      scroll={{ x: 'max-content' }}
      columns={[
        {
          title: t('run.kind'),
          key: 'kind',
          render: (_: unknown, row) => (kinds.has(row.kind) ? kinds(row.kind) : row.kind),
        },
        {
          title: t('run.status'),
          key: 'status',
          render: (_: unknown, row) =>
            statuses.has(row.status) ? statuses(row.status) : row.status,
        },
        {
          title: t('run.created'),
          key: 'created',
          render: (_: unknown, row) => formatDateTime(row.createdAt),
        },
        {
          title: t('run.finished'),
          key: 'finished',
          render: (_: unknown, row) => formatDateTime(row.finishedAt),
        },
        {
          title: t('run.open'),
          key: 'open',
          render: (_: unknown, row) => (
            <Link href={`/runs/${encodeURIComponent(row.id)}`}>{t('run.open')}</Link>
          ),
        },
      ]}
    />
  );
}

/** UI-026: findings, Facet diffs and Runs of a Route's endpoint migration, laid out like UI-022. */
export function EndpointMigrationView({ routeId }: { readonly routeId: string }) {
  const t = useTranslations('endpoints.migration');
  const confirmTexts = useTranslations('migrationDetail.actions.confirm.legacy');
  const [confirming, setConfirming] = useState<EndpointRunKind | undefined>(undefined);
  const actor = useActor();
  const operate = can(actor, 'operate');
  const queryClient = useQueryClient();
  const migration = useQuery({
    queryKey: endpointMigrationKey(routeId),
    queryFn: () => fetchEndpointMigration(routeId),
  });
  const migrationId = migration.data?.id;
  useLiveTopics(migrationTopics(migrationId), () => [['endpoints']]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['endpoints'] });
  const analyze = useMutation({
    mutationFn: (id: string) => analyzeMigration(id),
    onSuccess: refresh,
  });
  const start = useMutation({
    mutationFn: (input: { id: string; kind: EndpointRunKind; confirm?: string }) =>
      startMigrationRun(input.id, input.kind, input.confirm),
    onSuccess: () => {
      setConfirming(undefined);
      return refresh();
    },
  });

  if (migration.isError) return <ErrorAlert error={migration.error} />;
  if (migration.isSuccess && migration.data === null) {
    return <Empty description={t('missing')} />;
  }
  const data = migration.data;
  if (!data) return null;
  const stale = data.analysisStaleAt !== null && new Date(data.analysisStaleAt) <= new Date();
  const kind = runKindFor(data.status, offeredEndpointReadiness(data), stale);
  // Target writes of unknown place: the Run waits for the Route's Namespace path (ADR-0504).
  const legacyName = data.targetPlacementUnknown === true ? data.route.targetNamespacePath : null;
  const runLabel = (k: EndpointRunKind | undefined) =>
    k === 'run_anyway' ? t('action.runAnyway') : t('action.migrate');

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Typography.Text strong>
              {t('route', {
                source: data.route.sourceEndpoint.displayName,
                target: data.route.targetEndpoint.displayName,
                namespace: data.route.targetNamespacePath,
              })}
            </Typography.Text>
            <MigrationStatusTag status={data.status} />
            <ReadinessTag readiness={data.readiness} />
            {stale ? <Tag color="warning">{t('stale')}</Tag> : null}
          </div>
          {operate ? (
            <Space wrap>
              <Button
                loading={analyze.isPending}
                disabled={data.status === 'running'}
                onClick={() => analyze.mutate(data.id)}
              >
                {t('action.analyze')}
              </Button>
              <Button
                type="primary"
                loading={start.isPending}
                disabled={kind === undefined}
                onClick={() => {
                  if (kind === undefined) return;
                  if (legacyName !== null) {
                    start.reset();
                    setConfirming(kind);
                  } else start.mutate({ id: data.id, kind });
                }}
              >
                {runLabel(kind)}
              </Button>
            </Space>
          ) : null}
        </div>
        {analyze.isError ? <ErrorAlert error={analyze.error} /> : null}
        {start.isError && confirming === undefined ? <ErrorAlert error={start.error} /> : null}
        {analyze.isSuccess ? (
          <Alert type="info" showIcon className="mt-3" title={t('analyzeQueued')} />
        ) : null}
        {start.isSuccess ? (
          <Alert type="success" showIcon className="mt-3" title={t('runQueued')} />
        ) : null}
        <div className="mt-3">
          <EndpointFacetStrip analysisId={data.latestAnalysisId} />
        </div>
        <Typography.Paragraph type="secondary" className="mb-0 mt-3">
          {t('hint')}
        </Typography.Paragraph>
      </Card>
      <TypedNameDialog
        open={confirming !== undefined}
        name={legacyName}
        texts={{
          title: confirmTexts('title'),
          ok: runLabel(confirming),
          body: confirmTexts('body', { name: legacyName ?? '' }),
        }}
        warning={confirmTexts('warning')}
        loading={start.isPending}
        error={start.error}
        errorScope="run"
        onConfirm={(typed) =>
          confirming && start.mutate({ id: data.id, kind: confirming, confirm: typed })
        }
        onCancel={() => setConfirming(undefined)}
      />
      <Tabs
        items={[
          {
            key: 'overview',
            label: t('tab.overview'),
            children: <FindingsTab analysisId={data.latestAnalysisId} />,
          },
          {
            key: 'facets',
            label: t('tab.facets'),
            children: <FacetsTab migrationId={data.id} analysisId={data.latestAnalysisId} />,
          },
          { key: 'runs', label: t('tab.runs'), children: <RunsTab migrationId={data.id} /> },
        ]}
      />
    </div>
  );
}
