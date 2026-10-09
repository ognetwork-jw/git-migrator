'use client';

import { useQuery } from '@tanstack/react-query';
import { Button, Table, Tag, Typography } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { formatDateTime } from '../format.ts';
import { ErrorAlert } from '../mapping/shared.tsx';
import {
  auditKey,
  fetchMigrationAudit,
  fetchRuns,
  type MigrationAuditRow,
  type RunSummaryRow,
  runsKey,
} from './api.ts';

const RUN_COLOR: Record<string, string | undefined> = {
  queued: 'default',
  running: 'processing',
  succeeded: 'success',
  partial: 'warning',
  failed: 'error',
  cancelled: 'default',
};

/** The Runs tab (UI-022): the history of Runs, newest first, each linking to its page (UI-023). */
export function RunsTab({ migrationId }: { readonly migrationId: string }) {
  const t = useTranslations('migrationDetail.runs');
  const tKind = useTranslations('runKind');
  const tStatus = useTranslations('runStatus');
  const runs = useQuery({ queryKey: runsKey(migrationId), queryFn: () => fetchRuns(migrationId) });
  if (runs.isError) return <ErrorAlert error={runs.error} />;
  return (
    <Table<RunSummaryRow>
      size="small"
      rowKey="id"
      loading={runs.isLoading}
      pagination={false}
      locale={{ emptyText: t('empty') }}
      dataSource={[...(runs.data ?? [])]}
      columns={[
        {
          title: t('column.kind'),
          dataIndex: 'kind',
          render: (kind: string, row) => (
            <Link href={`/runs/${encodeURIComponent(row.id)}`}>
              {tKind.has(kind) ? tKind(kind) : kind}
            </Link>
          ),
        },
        {
          title: t('column.status'),
          dataIndex: 'status',
          render: (status: string) => (
            <Tag color={RUN_COLOR[status]}>{tStatus.has(status) ? tStatus(status) : status}</Tag>
          ),
        },
        {
          title: t('column.started'),
          key: 'started',
          render: (_: unknown, row) => formatDateTime(row.startedAt ?? row.createdAt),
        },
        {
          title: t('column.finished'),
          dataIndex: 'finishedAt',
          render: (v: string | null) => (v ? formatDateTime(v) : t('notFinished')),
        },
        {
          title: t('column.by'),
          key: 'by',
          render: (_: unknown, row) => row.triggeredBy?.displayName ?? '',
        },
      ]}
    />
  );
}

/** Characters of an event's data shown before the rest folds behind a control. */
const DATA_PREVIEW = 200;

function AuditData({ data }: { readonly data: unknown }) {
  const t = useTranslations('migrationDetail.audit');
  const [open, setOpen] = useState(false);
  const text = JSON.stringify(data) ?? '';
  const long = text.length > DATA_PREVIEW;
  return (
    <div className="max-w-md">
      <code className="break-words font-mono text-xs">
        {long && !open ? `${text.slice(0, DATA_PREVIEW)}…` : text}
      </code>
      {long ? (
        <Button type="link" size="small" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t('showLess') : t('showMore')}
        </Button>
      ) : null}
    </div>
  );
}

/** The Audit tab (UI-022): AuditEvents about this Migration, its Runs, tasks and differences. */
export function AuditTab({ migrationId }: { readonly migrationId: string }) {
  const t = useTranslations('migrationDetail.audit');
  const events = useQuery({
    queryKey: auditKey(migrationId),
    queryFn: () => fetchMigrationAudit(migrationId),
  });
  if (events.isError) return <ErrorAlert error={events.error} />;
  return (
    <>
      <Typography.Paragraph type="secondary">{t('intro')}</Typography.Paragraph>
      <Table<MigrationAuditRow>
        size="small"
        rowKey="id"
        loading={events.isLoading}
        pagination={false}
        locale={{ emptyText: t('empty') }}
        dataSource={[...(events.data ?? [])]}
        columns={[
          { title: t('column.when'), dataIndex: 'at', render: (v: string) => formatDateTime(v) },
          {
            title: t('column.actor'),
            key: 'actor',
            render: (_: unknown, row) => row.actor?.displayName ?? t('system'),
          },
          {
            title: t('column.action'),
            dataIndex: 'action',
            render: (v: string) => <code className="font-mono text-xs">{v}</code>,
          },
          {
            title: t('column.data'),
            dataIndex: 'data',
            render: (v: unknown) => (v === null || v === undefined ? null : <AuditData data={v} />),
          },
        ]}
      />
    </>
  );
}
