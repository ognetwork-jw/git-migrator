'use client';

import { can } from '@git-migrator/auth/capabilities';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Descriptions, Select, Tabs, Tag, Typography } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type ReactNode, useState } from 'react';
import { formatDateTime } from '../format.ts';
import { ErrorAlert } from '../mapping/shared.tsx';
import { facetBadges } from '../repositories/facet-strip.tsx';
import { MigrationStatusTag, ReadinessTag } from '../repositories/tags.tsx';
import { useActor } from '../shell/actor-context.tsx';
import { useLiveTopics } from '../shell/live-topics.tsx';
import { ActionError } from './action-error.tsx';
import {
  detailKey,
  detailRootKey,
  fetchMigration,
  fetchRuns,
  fetchWaveChoices,
  type MigrationDetail,
  runsKey,
  setWave,
  wavesChoiceKey,
} from './api.ts';
import { FacetsTab } from './facets-tab.tsx';
import { HeaderActions } from './header-actions.tsx';
import { AuditTab, RunsTab } from './history-tabs.tsx';
import { OverviewTab } from './overview-tab.tsx';
import { targetFullName } from './rules.ts';
import { TasksTab } from './tasks-tab.tsx';

const FACET_COLOR: Record<string, string | undefined> = {
  blocker: 'error',
  pre_task: 'warning',
  post_task: 'gold',
  warning: 'default',
};

/** The tabs of the page, in order. A later task adds its own entry here (UI-022). */
export const DETAIL_TABS = ['overview', 'facets', 'tasks', 'runs', 'audit'] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

/** The Facet strip (UI-022): a badge per Facet, colored by its worst finding; a click opens its tab. */
function FacetJump({
  migration,
  onJump,
}: {
  readonly migration: MigrationDetail;
  readonly onJump: (facetKey: string) => void;
}) {
  const t = useTranslations('migrationDetail.strip');
  const tKind = useTranslations('migrationDetail.findingKind');
  const badges = facetBadges(migration.latestAnalysis);
  if (badges.length === 0) return null;
  return (
    <ul aria-label={t('label')} className="m-0 flex list-none flex-wrap gap-1 p-0">
      {badges.map((badge) => {
        const hint =
          badge.worst === null
            ? t('clean', { facet: badge.facetKey })
            : t('hint', {
                facet: badge.facetKey,
                count: badge.count,
                kind: tKind(badge.worst),
              });
        return (
          <li key={badge.facetKey}>
            <button
              type="button"
              title={hint}
              aria-label={hint}
              onClick={() => onJump(badge.facetKey)}
              className="cursor-pointer border-0 bg-transparent p-0"
            >
              <Tag
                color={badge.worst === null ? 'success' : FACET_COLOR[badge.worst]}
                className="me-0"
              >
                {badge.facetKey}
              </Tag>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function WaveField({
  migration,
  editable,
}: {
  readonly migration: MigrationDetail;
  readonly editable: boolean;
}) {
  const t = useTranslations('migrationDetail.header');
  const queryClient = useQueryClient();
  const waves = useQuery({
    queryKey: wavesChoiceKey,
    queryFn: fetchWaveChoices,
    enabled: editable,
  });
  const change = useMutation({
    mutationFn: (waveId: string | null) => setWave(migration.id, waveId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: detailRootKey(migration.id) }),
  });
  if (!editable) return <>{migration.wave?.name ?? t('noWave')}</>;
  return (
    <div className="flex flex-col gap-1">
      <Select
        aria-label={t('wave')}
        className="min-w-48"
        allowClear
        placeholder={t('noWave')}
        loading={waves.isLoading || change.isPending}
        value={migration.waveId ?? undefined}
        options={(waves.data ?? []).map((w) => ({ value: w.id, label: w.name }))}
        onChange={(value: string | undefined) => change.mutate(value ?? null)}
      />
      {change.isError ? <ActionError error={change.error} scope="wave" /> : null}
    </div>
  );
}

function Header({
  migration,
  operator,
}: {
  readonly migration: MigrationDetail;
  readonly operator: boolean;
}) {
  const t = useTranslations('migrationDetail.header');
  const counts = migration.readinessCounts;
  const target = targetFullName(migration);
  const items: { key: string; label: string; children: ReactNode }[] = [
    {
      key: 'source',
      label: t('source'),
      children: migration.sourceRepository ? (
        <span>
          <code className="font-mono">{migration.sourceRepository.fullPath}</code>
          <br />
          <Typography.Text type="secondary">
            {migration.route.sourceEndpoint.displayName}
          </Typography.Text>
        </span>
      ) : (
        t('none')
      ),
    },
    {
      key: 'target',
      label: t('target'),
      children: target ? (
        <span>
          <code className="font-mono">{target}</code>
          {migration.targetRepository ? null : <Tag className="ms-2">{t('planned')}</Tag>}
          <br />
          <Typography.Text type="secondary">
            {migration.route.targetEndpoint.displayName}
          </Typography.Text>
        </span>
      ) : (
        t('none')
      ),
    },
    {
      key: 'status',
      label: t('status'),
      children: <MigrationStatusTag status={migration.status} />,
    },
    {
      key: 'readiness',
      label: t('readiness'),
      children: (
        <span className="flex flex-wrap items-center gap-2">
          <ReadinessTag readiness={migration.readiness} />
          {counts ? (
            <Typography.Text type="secondary">
              {t('counts', {
                blockers: counts.blockers ?? 0,
                pre: counts.preTasks ?? 0,
                post: counts.postTasks ?? 0,
              })}
            </Typography.Text>
          ) : null}
        </span>
      ),
    },
    {
      key: 'wave',
      label: t('wave'),
      children: <WaveField migration={migration} editable={operator} />,
    },
    {
      key: 'analyzed',
      label: t('analyzed'),
      children: migration.latestAnalysis
        ? formatDateTime(migration.latestAnalysis.createdAt)
        : t('never'),
    },
  ];
  if (migration.verifiedAt) {
    items.push({
      key: 'verified',
      label: t('verified'),
      children: formatDateTime(migration.verifiedAt),
    });
  }
  if (migration.manualCompletion) {
    items.push({
      key: 'completion',
      label: t('completion'),
      children: t('completionValue', {
        when: formatDateTime(migration.manualCompletion.at),
        reason: migration.manualCompletion.reason,
      }),
    });
  }
  return <Descriptions size="small" bordered column={{ xs: 1, md: 2 }} items={items} />;
}

/**
 * UI-022: one repository's Migration. A header with the source and target, status, readiness, Wave
 * and actions; the Facet strip; and the tabs Overview, Facets, Tasks, Runs and Audit. It follows
 * `migration:<id>` over the shell's live connection (JOB-060), so a Run or a task change refreshes
 * every tab.
 */
export function MigrationDetailView({ id }: { readonly id: string }) {
  const t = useTranslations('migrationDetail');
  const actor = useActor();
  const operator = can(actor, 'operate');
  const [tab, setTab] = useState<DetailTab>('overview');
  const [facet, setFacet] = useState<string | undefined>(undefined);
  useLiveTopics([`migration:${id}`], () => [detailRootKey(id)]);
  const migration = useQuery({ queryKey: detailKey(id), queryFn: () => fetchMigration(id) });
  const runs = useQuery({ queryKey: runsKey(id), queryFn: () => fetchRuns(id) });

  if (migration.isError) return <ErrorAlert error={migration.error} />;
  if (migration.isLoading) {
    return <Typography.Text type="secondary">{t('loading')}</Typography.Text>;
  }
  const m = migration.data;
  if (m === null || m === undefined) {
    return <Alert type="warning" showIcon title={t('notFound')} />;
  }
  const title = m.sourceRepository?.fullPath ?? m.id;
  const openTasks = (m.readinessCounts?.preTasks ?? 0) + (m.readinessCounts?.postTasks ?? 0);

  return (
    <div className="flex flex-col gap-4">
      <Link href="/repositories">{t('back')}</Link>
      <Typography.Title level={2} className="m-0 text-xl">
        {title}
      </Typography.Title>
      {m.analysisStaleAt ? <Alert type="info" showIcon title={t('stale')} /> : null}
      <Header migration={m} operator={operator} />
      <HeaderActions migration={m} runs={runs.data ?? []} />
      <FacetJump
        migration={m}
        onJump={(key) => {
          setFacet(key);
          setTab('facets');
        }}
      />
      <Tabs
        activeKey={tab}
        onChange={(key) => setTab(key as DetailTab)}
        items={[
          {
            key: 'overview',
            label: t('tab.overview'),
            children: <OverviewTab migration={m} />,
          },
          {
            key: 'facets',
            label: t('tab.facets'),
            children: (
              <FacetsTab
                migrationId={m.id}
                operator={operator}
                selected={facet}
                onSelect={setFacet}
              />
            ),
          },
          {
            key: 'tasks',
            label: openTasks > 0 ? t('tab.tasksOpen', { count: openTasks }) : t('tab.tasks'),
            children: (
              <TasksTab
                migrationId={m.id}
                operator={can(actor, 'manageTasks')}
                targetName={targetFullName(m)}
              />
            ),
          },
          { key: 'runs', label: t('tab.runs'), children: <RunsTab migrationId={m.id} /> },
          { key: 'audit', label: t('tab.audit'), children: <AuditTab migrationId={m.id} /> },
        ]}
      />
    </div>
  );
}
