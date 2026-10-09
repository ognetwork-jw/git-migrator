'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import { Card, Table, Typography } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { dashboardKey, fetchDashboard } from '../dashboard/api.ts';
import { formatDateTime } from '../format.ts';
import { ErrorAlert } from '../mapping/shared.tsx';
import { MigrationStatusTag, ReadinessTag } from '../repositories/tags.tsx';
import { useLiveTopics } from '../shell/live-topics.tsx';
import {
  type EndpointRow,
  endpointStatsKey,
  endpointsKey,
  fetchEndpointStats,
  fetchEndpoints,
  fetchRoutes,
  type RouteRow,
  routesKey,
} from './api.ts';

/** What the page follows (ADR-0270): inventory progress moves the counts, Migrations the status. */
export const ENDPOINT_TOPICS: readonly string[] = ['list:repositories', 'list:migrations'];
const keysFor = (topic: string) =>
  topic === 'list:migrations' ? [dashboardKey] : ([['endpoints', 'stats']] as const);

export const migrationHref = (routeId: string): string =>
  `/endpoints/routes/${encodeURIComponent(routeId)}/migration`;

/** UI-025: the configured Endpoints and Routes (read-only), their inventory and the endpoint migration. */
export function EndpointsView() {
  const t = useTranslations('endpoints');
  useLiveTopics(ENDPOINT_TOPICS, keysFor);
  const endpoints = useQuery({ queryKey: endpointsKey, queryFn: fetchEndpoints });
  const routes = useQuery({ queryKey: routesKey, queryFn: fetchRoutes });
  const dashboard = useQuery({ queryKey: dashboardKey, queryFn: fetchDashboard });
  const stats = useQueries({
    queries: (endpoints.data ?? []).map((e) => ({
      queryKey: endpointStatsKey(e.id),
      queryFn: () => fetchEndpointStats(e.id),
    })),
  });
  const statsOf = new Map((endpoints.data ?? []).map((e, i) => [e.id, stats[i]?.data]));
  const summaries = new Map((dashboard.data?.routes ?? []).map((r) => [r.routeId, r]));

  if (endpoints.isError) return <ErrorAlert error={endpoints.error} />;
  if (routes.isError) return <ErrorAlert error={routes.error} />;
  const noRoutes = routes.data !== undefined && routes.data.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <Card title={t('endpoints.title')}>
        <Table<EndpointRow>
          rowKey="id"
          size="small"
          loading={endpoints.isLoading}
          dataSource={endpoints.data ?? []}
          locale={{ emptyText: t('endpoints.empty') }}
          pagination={false}
          scroll={{ x: 'max-content' }}
          columns={[
            {
              title: t('endpoints.column.name'),
              key: 'name',
              render: (_: unknown, row) => (
                <>
                  <Typography.Text strong>{row.displayName}</Typography.Text>{' '}
                  <Typography.Text type="secondary">{row.id}</Typography.Text>
                </>
              ),
            },
            { title: t('endpoints.column.provider'), key: 'provider', dataIndex: 'providerType' },
            { title: t('endpoints.column.url'), key: 'url', dataIndex: 'baseUrl' },
            { title: t('endpoints.column.status'), key: 'status', dataIndex: 'status' },
            {
              title: t('endpoints.column.repositories'),
              key: 'repositories',
              render: (_: unknown, row) => statsOf.get(row.id)?.repositories ?? '',
            },
            {
              title: t('endpoints.column.identities'),
              key: 'identities',
              render: (_: unknown, row) => statsOf.get(row.id)?.identities ?? '',
            },
            {
              title: t('endpoints.column.groups'),
              key: 'groups',
              render: (_: unknown, row) => statsOf.get(row.id)?.groups ?? '',
            },
            {
              title: t('endpoints.column.inventoried'),
              key: 'inventoried',
              render: (_: unknown, row) => {
                const s = statsOf.get(row.id);
                if (s === undefined) return '';
                return s.lastInventoriedAt
                  ? formatDateTime(s.lastInventoriedAt)
                  : t('endpoints.neverInventoried');
              },
            },
          ]}
        />
      </Card>
      <Card title={t('routes.title')}>
        {noRoutes ? <Typography.Text type="secondary">{t('routes.empty')}</Typography.Text> : null}
        {noRoutes ? null : (
          <Table<RouteRow>
            rowKey="id"
            size="small"
            loading={routes.isLoading}
            dataSource={routes.data ?? []}
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: t('routes.column.route'), key: 'route', dataIndex: 'id' },
              {
                title: t('routes.column.direction'),
                key: 'direction',
                render: (_: unknown, row) =>
                  t('routes.direction', {
                    source: row.sourceEndpointId,
                    target: row.targetEndpointId,
                    namespace: row.targetNamespacePath,
                  }),
              },
              {
                title: t('routes.column.repositories'),
                key: 'repositories',
                render: (_: unknown, row) => summaries.get(row.id)?.total ?? '',
              },
              {
                title: t('routes.column.endpointMigration'),
                key: 'migration',
                render: (_: unknown, row) => {
                  const m = summaries.get(row.id)?.endpointMigration;
                  if (!m)
                    return <Typography.Text type="secondary">{t('routes.none')}</Typography.Text>;
                  return (
                    <>
                      <MigrationStatusTag status={m.status} />
                      <ReadinessTag readiness={m.readiness} />
                    </>
                  );
                },
              },
              {
                title: t('routes.column.actions'),
                key: 'actions',
                render: (_: unknown, row) => (
                  <Link href={migrationHref(row.id)}>{t('routes.open')}</Link>
                ),
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
