'use client';

import { useQuery } from '@tanstack/react-query';
import { Alert, Descriptions, Tag, Typography } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { dashboardKey, fetchDashboard } from '../dashboard/api.ts';
import { formatDateTime } from '../format.ts';
import { ErrorAlert } from '../mapping/shared.tsx';
import { RepositoriesView } from '../repositories/repositories-view.tsx';
import { useLiveTopics } from '../shell/live-topics.tsx';
import { fetchWave, fetchWaveRoute, waveKey, waveRouteKey } from './api.ts';
import { WAVE_TOPICS } from './waves-view.tsx';

/** UI-024: one Wave, its status breakdown, and the repositories list filtered to it. */
export function WaveDetailView({ id }: { readonly id: string }) {
  const t = useTranslations('waves.detail');
  const tWave = useTranslations('waves');
  const tStatus = useTranslations('migrationStatus');
  useLiveTopics(WAVE_TOPICS, () => [dashboardKey, ['waves']]);
  const wave = useQuery({ queryKey: waveKey(id), queryFn: () => fetchWave(id) });
  const route = useQuery({ queryKey: waveRouteKey(id), queryFn: () => fetchWaveRoute(id) });
  const dashboard = useQuery({ queryKey: dashboardKey, queryFn: fetchDashboard });

  if (wave.isError) return <ErrorAlert error={wave.error} />;
  if (wave.isSuccess && wave.data === null) {
    return <Alert type="warning" showIcon title={t('notFound')} />;
  }
  const progress = dashboard.data?.waves.find((w) => w.id === id);
  const counts = Object.entries(progress?.byStatus ?? {}).filter(([, n]) => n > 0);

  return (
    <div className="flex flex-col gap-4">
      <Link href="/waves">{t('back')}</Link>
      {wave.data ? (
        <Descriptions size="small" column={1} title={wave.data.name}>
          <Descriptions.Item label={tWave('column.targetDate')}>
            {wave.data.targetDate ? formatDateTime(wave.data.targetDate) : tWave('noDate')}
          </Descriptions.Item>
          {wave.data.description ? (
            <Descriptions.Item label={tWave('column.description')}>
              {wave.data.description}
            </Descriptions.Item>
          ) : null}
        </Descriptions>
      ) : null}
      <section aria-label={t('breakdown')}>
        <Typography.Title level={2} className="text-lg">
          {t('breakdown')}
        </Typography.Title>
        {dashboard.isLoading ? (
          <Typography.Text type="secondary">{t('loading')}</Typography.Text>
        ) : dashboard.isError ? (
          <ErrorAlert error={dashboard.error} />
        ) : progress === undefined && dashboard.data?.wavesTruncated ? (
          <Typography.Text type="secondary">{t('unknown')}</Typography.Text>
        ) : counts.length === 0 ? (
          <Typography.Text type="secondary">{t('noMembers')}</Typography.Text>
        ) : (
          <div className="flex flex-wrap gap-2">
            {counts.map(([status, n]) => (
              <Tag key={status}>
                {tStatus.has(status as never) ? tStatus(status as never) : status}: {n}
              </Tag>
            ))}
          </div>
        )}
      </section>
      <section aria-label={t('repositories')}>
        <Typography.Title level={2} className="text-lg">
          {t('repositories')}
        </Typography.Title>
        {route.isSuccess ? (
          <RepositoriesView
            {...(route.data ? { initialRouteId: route.data } : {})}
            initialFilters={{ waveId: id, status: 'all' }}
          />
        ) : null}
      </section>
    </div>
  );
}
