'use client';

import { can } from '@git-migrator/auth/capabilities';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Empty, Progress, Spin, Statistic, Table, Typography } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { formatDateTime } from '../format.ts';
import { ErrorAlert } from '../mapping/shared.tsx';
import { splitDuration } from '../repositories/format.ts';
import { MigrationStatusTag, ReadinessTag } from '../repositories/tags.tsx';
import { useActor } from '../shell/actor-context.tsx';
import { useLiveTopics } from '../shell/live-topics.tsx';
import {
  type Dashboard,
  dashboardKey,
  fetchDashboard,
  fetchQuota,
  type Quota,
  quotaKey,
  refreshInventory,
} from './api.ts';

/** What the dashboard follows (ADR-0270): counts, Runs and quota. The shell's connection carries them. */
export const DASHBOARD_TOPICS: readonly string[] = ['list:migrations', 'list:runs', 'quota'];

const keysFor = (topic: string) => (topic === 'quota' ? [quotaKey] : [dashboardKey]);

/** Statuses that count as done for a Wave's progress. */
const DONE_STATUSES = ['migrated', 'verified', 'manually_completed'] as const;

const READINESS_ORDER = ['ready', 'needs_attention', 'blocked', 'unanalyzed'] as const;

/** UI-020: per Route counts and Waves, quota gauges, recent Runs and the endpoint migration. */
export function DashboardView() {
  const t = useTranslations('dashboard');
  const actor = useActor();
  const queryClient = useQueryClient();
  const [queued, setQueued] = useState(false);
  useLiveTopics(DASHBOARD_TOPICS, keysFor);

  const dashboard = useQuery({ queryKey: dashboardKey, queryFn: fetchDashboard });
  const quota = useQuery({ queryKey: quotaKey, queryFn: fetchQuota });
  const refresh = useMutation({
    mutationFn: refreshInventory,
    onMutate: () => setQueued(false),
    onSuccess: () => {
      setQueued(true);
      return queryClient.invalidateQueries({ queryKey: dashboardKey });
    },
  });

  if (dashboard.isError) return <ErrorAlert error={dashboard.error} />;
  if (dashboard.data === undefined) {
    return (
      <div role="status" className="flex items-center gap-3">
        <Spin />
        <Typography.Text type="secondary">{t('loading')}</Typography.Text>
      </div>
    );
  }
  const data = dashboard.data;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Typography.Text type="secondary">
          {t('updated', { when: formatDateTime(data.generatedAt) })}
        </Typography.Text>
        {can(actor, 'operate') ? (
          <Button loading={refresh.isPending} onClick={() => refresh.mutate()}>
            {t('refreshInventory')}
          </Button>
        ) : null}
      </div>
      {refresh.isError ? <ErrorAlert error={refresh.error} /> : null}
      {queued && !refresh.isError ? (
        <Alert type="success" showIcon title={t('refreshQueued')} />
      ) : null}

      {data.routes.length === 0 ? (
        <Typography.Paragraph type="secondary">{t('noRoutes')}</Typography.Paragraph>
      ) : null}
      {data.routes.map((route) => (
        <RouteCounts key={route.routeId} route={route} />
      ))}

      <WavesCard dashboard={data} />
      <QuotaCard query={quota} />
      <RecentRuns runs={data.recentRuns} />
    </div>
  );
}

/** A card title that opens the repositories list on the Route with these filters (UI-020). */
const listLink = (routeId: string, label: string, query: string) => (
  <Link href={`/repositories?route=${encodeURIComponent(routeId)}&${query}`}>{label}</Link>
);

function RouteCounts({ route }: { readonly route: Dashboard['routes'][number] }) {
  const t = useTranslations('dashboard');
  const tStatus = useTranslations('migrationStatus');
  const tReadiness = useTranslations('readiness');
  const statuses = Object.entries(route.byStatus).filter(([, count]) => count > 0);
  return (
    <Card
      title={t('route', { id: route.routeId })}
      extra={
        <Link href={`/repositories?route=${encodeURIComponent(route.routeId)}`}>
          {t('openList')}
        </Link>
      }
    >
      <section aria-label={t('byStatus')} className="mb-4">
        <Typography.Title level={4} className="mt-0 text-base">
          {t('byStatus')}
        </Typography.Title>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <Statistic
            title={listLink(route.routeId, t('total'), 'status=all')}
            value={route.total}
          />
          {statuses.map(([status, count]) => (
            <Statistic
              key={status}
              title={listLink(
                route.routeId,
                tStatus.has(status) ? tStatus(status) : status,
                `status=${encodeURIComponent(status)}`,
              )}
              value={count}
            />
          ))}
        </div>
      </section>
      <section aria-label={t('byReadiness')} className="mb-4">
        <Typography.Title level={4} className="mt-0 text-base">
          {t('byReadiness')}
        </Typography.Title>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {READINESS_ORDER.map((key) => (
            <Statistic
              key={key}
              title={
                key === 'unanalyzed'
                  ? tReadiness(key)
                  : listLink(route.routeId, tReadiness(key), `status=all&readiness=${key}`)
              }
              value={route.byReadiness[key] ?? 0}
            />
          ))}
        </div>
      </section>
      <section aria-label={t('endpointMigration.title')}>
        <Typography.Title level={4} className="mt-0 text-base">
          {t('endpointMigration.title')}
        </Typography.Title>
        {route.endpointMigration === null ? (
          <Typography.Text type="secondary">{t('endpointMigration.none')}</Typography.Text>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <MigrationStatusTag status={route.endpointMigration.status} />
            <ReadinessTag readiness={route.endpointMigration.readiness} />
          </div>
        )}
      </section>
    </Card>
  );
}

function WavesCard({ dashboard }: { readonly dashboard: Dashboard }) {
  const t = useTranslations('dashboard.waves');
  return (
    <Card title={t('title')}>
      {dashboard.wavesTruncated ? (
        <Alert
          type="warning"
          showIcon
          className="mb-3"
          title={t('truncated', { count: dashboard.waves.length })}
        />
      ) : null}
      {dashboard.waves.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('empty')} />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {dashboard.waves.map((wave) => {
            const done = DONE_STATUSES.reduce((sum, s) => sum + (wave.byStatus[s] ?? 0), 0);
            const percent = wave.total === 0 ? 0 : Math.round((done / wave.total) * 100);
            return (
              <li key={wave.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Typography.Text strong>{wave.name}</Typography.Text>
                  <Typography.Text type="secondary">
                    {t('total', { count: wave.total })}
                    {wave.targetDate
                      ? `, ${t('target', { date: formatDateTime(wave.targetDate) })}`
                      : ''}
                  </Typography.Text>
                </div>
                <Progress
                  percent={percent}
                  aria-label={wave.name}
                  format={() => t('progress', { done, total: wave.total })}
                />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function QuotaCard({ query }: { readonly query: ReturnType<typeof useQuery<Quota>> }) {
  const t = useTranslations('dashboard.quota');
  const tDuration = useTranslations('dashboard.duration');
  const duration = (seconds: number) => {
    const { unit, count } = splitDuration(seconds);
    return tDuration(unit, { count });
  };
  const data = query.data;
  return (
    <Card title={t('title')} loading={query.isLoading}>
      {query.isError ? <Alert type="error" showIcon role="alert" title={t('error')} /> : null}
      {data?.backlogTruncated ? (
        <Alert type="warning" showIcon className="mb-3" title={t('backlogTruncated')} />
      ) : null}
      {data ? (
        <Typography.Paragraph type="secondary">
          {t('backlogTotal', { count: data.backlogTotal })}
        </Typography.Paragraph>
      ) : null}
      {data && data.buckets.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('empty')} />
      ) : null}
      <ul className="m-0 flex list-none flex-col gap-4 p-0">
        {(data?.buckets ?? []).map((bucket) => {
          const label = t('bucket', {
            endpoint: bucket.endpointId ?? '',
            account: bucket.accountKey ?? '',
            group: bucket.resourceGroup ?? '',
          });
          const percent =
            bucket.effectiveLimit > 0
              ? Math.min(100, Math.round((bucket.used / bucket.effectiveLimit) * 100))
              : 0;
          const blocked = bucket.blockedUntil !== null;
          return (
            <li key={bucket.bucketKey} data-bucket={bucket.bucketKey}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Typography.Text strong>{label}</Typography.Text>
                <Typography.Text type="secondary">
                  {t('used', { used: bucket.used, limit: bucket.effectiveLimit })}
                  {bucket.resetAt
                    ? `, ${t('resetAt', { when: formatDateTime(bucket.resetAt) })}`
                    : ''}
                </Typography.Text>
              </div>
              <Progress
                percent={percent}
                aria-label={t('gauge', { bucket: label })}
                status={blocked || bucket.nearLimit ? 'exception' : 'normal'}
              />
              <div className="flex flex-col gap-1 text-sm">
                {blocked ? (
                  <Typography.Text type="danger">
                    {t('blockedUntil', { when: formatDateTime(bucket.blockedUntil) })}
                  </Typography.Text>
                ) : null}
                {bucket.nearLimit && !blocked ? (
                  <Typography.Text type="warning">{t('nearLimit')}</Typography.Text>
                ) : null}
                <Typography.Text type="secondary">
                  {t('backlog', { count: bucket.backlog })}
                  {'. '}
                  {bucket.backlog === 0
                    ? t('etaZero')
                    : bucket.backgroundEtaSeconds === null
                      ? t('etaNone')
                      : t('eta', { duration: duration(bucket.backgroundEtaSeconds) })}
                </Typography.Text>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function RecentRuns({ runs }: { readonly runs: Dashboard['recentRuns'] }) {
  const t = useTranslations('dashboard.runs');
  const tKind = useTranslations('runKind');
  const tStatus = useTranslations('runStatus');
  return (
    <Card title={t('title')}>
      <Table<Dashboard['recentRuns'][number]>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={[...runs]}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('empty') }}
        columns={[
          {
            title: t('column.migration'),
            key: 'migration',
            render: (_: unknown, run) => (
              <Link href={`/repositories/${encodeURIComponent(run.migrationId)}`}>{t('open')}</Link>
            ),
          },
          {
            title: t('column.kind'),
            key: 'kind',
            render: (_: unknown, run) => (tKind.has(run.kind) ? tKind(run.kind) : run.kind),
          },
          {
            title: t('column.status'),
            key: 'status',
            render: (_: unknown, run) =>
              tStatus.has(run.status) ? tStatus(run.status) : run.status,
          },
          {
            title: t('column.created'),
            key: 'created',
            render: (_: unknown, run) => formatDateTime(run.createdAt),
          },
          {
            title: t('column.finished'),
            key: 'finished',
            render: (_: unknown, run) => formatDateTime(run.finishedAt),
          },
        ]}
      />
    </Card>
  );
}
