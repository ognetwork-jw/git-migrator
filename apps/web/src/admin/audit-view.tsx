'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Button, Input, Select, Space, Table, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { formatDateTime } from '../format.ts';
import { ErrorAlert } from '../mapping/shared.tsx';
import {
  type ActorRow,
  AUDIT_PAGE,
  type AuditFilter,
  type AuditRow,
  actorsKey,
  fetchActors,
  fetchAuditPage,
} from './api.ts';

/** The date filters as the API takes them: the start of the first day and the end of the last. */
export function auditBounds(from: string, to: string): { from?: string; to?: string } {
  const start = from ? new Date(`${from}T00:00:00`) : undefined;
  const end = to ? new Date(`${to}T23:59:59.999`) : undefined;
  return {
    ...(start && !Number.isNaN(start.getTime()) ? { from: start.toISOString() } : {}),
    ...(end && !Number.isNaN(end.getTime()) ? { to: end.toISOString() } : {}),
  };
}

/** Characters of an event's change shown before the rest is folded behind a control. */
export const AUDIT_DATA_PREVIEW = 300;

/** The change of one event; a long one shows its start and expands on request. */
function AuditData({ data }: { readonly data: unknown }) {
  const t = useTranslations('admin.audit');
  const [open, setOpen] = useState(false);
  const text = JSON.stringify(data, null, 2) ?? '';
  const long = text.length > AUDIT_DATA_PREVIEW;
  return (
    <div className="max-w-md">
      <pre className="m-0 whitespace-pre-wrap break-words text-xs">
        {long && !open ? `${text.slice(0, AUDIT_DATA_PREVIEW)}…` : text}
      </pre>
      {long ? (
        <Button type="link" size="small" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t('showLess') : t('showMore')}
        </Button>
      ) : null}
    </div>
  );
}

/** UI-035: the audit log, filterable by Actor, action, subject type and date range (AUTH-022). */
export function AuditLogView() {
  const t = useTranslations('admin.audit');
  const [actorId, setActorId] = useState<string>();
  const [action, setAction] = useState('');
  const [subjectType, setSubjectType] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const actors = useQuery({ queryKey: actorsKey, queryFn: fetchActors });
  const names = new Map<string, string>(
    (actors.data ?? []).map((a: ActorRow) => [a.id, a.displayName]),
  );

  const filter: AuditFilter = {
    ...(actorId ? { actorId } : {}),
    ...(action.trim() ? { action: action.trim() } : {}),
    ...(subjectType.trim() ? { subjectType: subjectType.trim() } : {}),
    ...(subjectId.trim() ? { subjectId: subjectId.trim() } : {}),
    ...auditBounds(from, to),
  };

  const events = useInfiniteQuery({
    queryKey: ['admin', 'audit', filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchAuditPage(filter, pageParam),
    getNextPageParam: (last) =>
      last.length === AUDIT_PAGE ? last[last.length - 1]?.id : undefined,
  });
  const rows: AuditRow[] = events.data?.pages.flat() ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Space wrap>
        <Select<string>
          allowClear
          aria-label={t('filter.actor')}
          placeholder={t('filter.actorPlaceholder')}
          className="min-w-52"
          value={actorId}
          onChange={(value) => setActorId(value)}
          options={(actors.data ?? []).map((a) => ({ value: a.id, label: a.displayName }))}
        />
        <Input
          allowClear
          aria-label={t('filter.action')}
          placeholder={t('filter.actionPlaceholder')}
          className="w-56"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        />
        <Input
          allowClear
          aria-label={t('filter.subjectType')}
          placeholder={t('filter.subjectTypePlaceholder')}
          className="w-44"
          value={subjectType}
          onChange={(e) => setSubjectType(e.target.value)}
        />
        <Input
          allowClear
          aria-label={t('filter.subjectId')}
          placeholder={t('filter.subjectIdPlaceholder')}
          className="w-56"
          value={subjectId}
          onChange={(e) => setSubjectId(e.target.value)}
        />
        <Input
          type="date"
          aria-label={t('filter.from')}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Input
          type="date"
          aria-label={t('filter.to')}
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </Space>

      {events.isError ? <ErrorAlert error={events.error} /> : null}

      <Table<AuditRow>
        rowKey="id"
        size="middle"
        loading={events.isLoading || events.isFetching}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('empty') }}
        columns={[
          {
            title: t('column.at'),
            key: 'at',
            render: (_: unknown, e) => formatDateTime(e.at),
          },
          {
            title: t('column.actor'),
            key: 'actor',
            render: (_: unknown, e) =>
              e.actorId === null ? t('system') : (names.get(e.actorId) ?? e.actorId),
          },
          {
            title: t('column.action'),
            key: 'action',
            render: (_: unknown, e) => <Typography.Text code>{e.action}</Typography.Text>,
          },
          {
            title: t('column.subject'),
            key: 'subject',
            render: (_: unknown, e) => `${e.subjectType} ${e.subjectId}`,
          },
          {
            title: t('column.data'),
            key: 'data',
            render: (_: unknown, e) =>
              e.data === null || e.data === undefined ? '' : <AuditData data={e.data} />,
          },
        ]}
      />
      {events.hasNextPage ? (
        <Button
          onClick={() => void events.fetchNextPage()}
          loading={events.isFetchingNextPage}
          className="self-start"
        >
          {t('loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
