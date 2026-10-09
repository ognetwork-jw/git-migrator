'use client';

import { PlusOutlined } from '@ant-design/icons';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { Button, Drawer, Input, Select, Space, Table, Typography } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useLiveInvalidation } from '../live/index.ts';
import { ErrorAlert, RouteSelect, useRouteChoice } from '../mapping/shared.tsx';
import {
  BATCH_STATUSES,
  type Batch,
  batchesKey,
  type Candidate,
  candidatesKey,
  createBatch,
  fetchBatches,
  fetchCandidates,
  invitationsKey,
} from './api.ts';
import { BatchStatusTag, useSeatText, useWhen } from './shared.tsx';

/** The follow-up of every view: events refetch the pages (JOB-060, ADR-0370). */
export const invitationTopics = (extra: readonly string[] = []) => ['list:invitations', ...extra];

/** UI-029: the batch list, and the drawer that drafts a new batch from candidates. */
export function InvitationsView() {
  const t = useTranslations('invitations');
  const [chosenRoute, setChosenRoute] = useState<string>();
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const { routes, routeId, query: routesQuery } = useRouteChoice(chosenRoute);
  useLiveInvalidation({
    topics: invitationTopics(),
    queryKeysFor: () => [invitationsKey],
  });

  const list = useInfiniteQuery({
    queryKey: batchesKey(routeId ?? '', status),
    enabled: routeId !== undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      fetchBatches({
        routeId: routeId as string,
        status,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  if (routesQuery.isError) return <ErrorAlert error={routesQuery.error} />;
  if (routesQuery.isSuccess && routeId === undefined) {
    return <Typography.Paragraph type="secondary">{t('noRoutes')}</Typography.Paragraph>;
  }

  return (
    <div className="flex flex-col gap-4">
      <Space wrap>
        <RouteSelect routes={routes} value={routeId} onChange={setChosenRoute} />
        <Select
          aria-label={t('filter.status')}
          className="min-w-44"
          value={status}
          onChange={setStatus}
          options={[
            { value: '', label: t('filter.allStatuses') },
            ...BATCH_STATUSES.map((s) => ({ value: s, label: t(`batchStatus.${s}`) })),
          ]}
        />
        <Button
          type="primary"
          icon={<PlusOutlined aria-hidden />}
          onClick={() => setCreating(true)}
          disabled={routeId === undefined}
        >
          {t('new.open')}
        </Button>
      </Space>
      <Typography.Paragraph type="secondary" className="mb-0">
        {t('safety')}
      </Typography.Paragraph>

      {list.isError ? <ErrorAlert error={list.error} /> : null}

      <BatchTable rows={rows} loading={list.isLoading || list.isFetching} />
      {list.hasNextPage ? (
        <Button onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
          {t('loadMore')}
        </Button>
      ) : null}

      {routeId !== undefined ? (
        <NewBatchDrawer routeId={routeId} open={creating} onClose={() => setCreating(false)} />
      ) : null}
    </div>
  );
}

function SeatCell({ batch }: { readonly batch: Batch }) {
  return <>{useSeatText(batch.seatPreview)}</>;
}

function BatchTable({ rows, loading }: { readonly rows: Batch[]; readonly loading: boolean }) {
  const t = useTranslations('invitations');
  const when = useWhen();
  return (
    <Table<Batch>
      rowKey="id"
      size="middle"
      loading={loading}
      dataSource={rows}
      pagination={false}
      scroll={{ x: 'max-content' }}
      locale={{ emptyText: t('empty') }}
      columns={[
        {
          title: t('column.batch'),
          key: 'batch',
          render: (_: unknown, b) => (
            <Link href={`/people/invitations/${encodeURIComponent(b.id)}`}>
              {t('batchLabel', { when: when(b.createdAt) })}
            </Link>
          ),
        },
        {
          title: t('column.status'),
          key: 'status',
          render: (_: unknown, b) => <BatchStatusTag status={b.status} />,
        },
        {
          title: t('column.entries'),
          key: 'entries',
          render: (_: unknown, b) =>
            t('counts', {
              selected: b.counts.selected,
              sent: b.counts.sent,
              accepted: b.counts.accepted,
              failed: b.counts.failed + b.counts.expired + b.counts.unknown,
              deselected: b.counts.deselected,
            }),
        },
        {
          title: t('column.seats'),
          key: 'seats',
          render: (_: unknown, b) => <SeatCell batch={b} />,
        },
        {
          title: t('column.createdBy'),
          key: 'createdBy',
          render: (_: unknown, b) => b.createdBy,
        },
        {
          title: t('column.approved'),
          key: 'approved',
          render: (_: unknown, b) =>
            b.approvedAt === null
              ? ''
              : t('approvedBy', { when: when(b.approvedAt), who: b.approvedBy ?? '' }),
        },
      ]}
    />
  );
}

/** AUTH-060 step 1: a draft from candidates, all or the ones picked. Nothing is sent by this. */
function NewBatchDrawer({
  routeId,
  open,
  onClose,
}: {
  readonly routeId: string;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const t = useTranslations('invitations.new');
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<readonly string[]>([]);
  const list = useInfiniteQuery({
    queryKey: candidatesKey(routeId, search),
    enabled: open,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      fetchCandidates(routeId, { q: search, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const create = useMutation({
    mutationFn: (all: boolean) =>
      createBatch(routeId, all ? { all: true } : { identityIds: [...picked] }),
    onSuccess: async () => {
      setPicked([]);
      await queryClient.invalidateQueries({ queryKey: invitationsKey });
      onClose();
    },
  });

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size={720}
      title={t('title')}
      closable={{ 'aria-label': t('close') }}
      destroyOnHidden
    >
      <div className="flex flex-col gap-4">
        <Typography.Paragraph>{t('help')}</Typography.Paragraph>
        <Input.Search
          allowClear
          aria-label={t('search')}
          placeholder={t('searchPlaceholder')}
          onSearch={setSearch}
        />
        {list.isError ? <ErrorAlert error={list.error} /> : null}
        {create.isError ? <ErrorAlert error={create.error} /> : null}
        <Table<Candidate>
          rowKey={(c) => c.identity.id}
          size="small"
          loading={list.isLoading}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: t('none') }}
          rowSelection={{
            selectedRowKeys: [...picked],
            onChange: (keys) => setPicked(keys.map(String)),
          }}
          columns={[
            {
              title: t('column.person'),
              key: 'person',
              render: (_: unknown, c) =>
                c.identity.displayName ?? c.identity.login ?? c.identity.providerId,
            },
            { title: t('column.email'), key: 'email', render: (_: unknown, c) => c.identity.email },
            {
              title: t('column.teams'),
              key: 'teams',
              render: (_: unknown, c) => c.teamSlugs.join(', '),
            },
          ]}
        />
        {list.hasNextPage ? (
          <Button onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
            {t('loadMore')}
          </Button>
        ) : null}
        <Space wrap>
          <Button
            type="primary"
            disabled={picked.length === 0}
            loading={create.isPending}
            onClick={() => create.mutate(false)}
          >
            {t('createPicked', { count: picked.length })}
          </Button>
          <Button
            disabled={rows.length === 0}
            loading={create.isPending}
            onClick={() => create.mutate(true)}
          >
            {t('createAll')}
          </Button>
        </Space>
      </div>
    </Drawer>
  );
}
