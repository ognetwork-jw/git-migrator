'use client';

import { UploadOutlined } from '@ant-design/icons';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Button, Input, Modal, Select, Space, Table, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { formatDateTime } from '../format.ts';
import {
  decideIdentity,
  fetchIdentityMappings,
  fetchTargetIdentities,
  type IdentityMapping,
  type IdentityRef,
  identitiesKey,
  MAPPING_STATUSES,
} from './api.ts';
import { CsvImportDrawer } from './csv-import-drawer.tsx';
import { ErrorAlert, RouteSelect, StatusTag, useRouteChoice } from './shared.tsx';

const MAX_REASON = 500;

const personLabel = (who: IdentityRef): string => who.displayName ?? who.login ?? who.providerId;

function Person({ who }: { readonly who: IdentityRef }) {
  return (
    <div>
      <div>{personLabel(who)}</div>
      <Typography.Text type="secondary" className="text-xs">
        {[who.login, who.email].filter(Boolean).join(' / ')}
      </Typography.Text>
    </div>
  );
}

/** UI-027: source Identities with mapping status, method and suggested target, and the actions. */
export function IdentityMappingView() {
  const t = useTranslations('mapping');
  const queryClient = useQueryClient();
  const [chosenRoute, setChosenRoute] = useState<string>();
  const [status, setStatus] = useState<string>('');
  const [search, setSearch] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [excluding, setExcluding] = useState<IdentityMapping>();
  const [changing, setChanging] = useState<IdentityMapping>();
  const { routes, routeId, query: routesQuery } = useRouteChoice(chosenRoute);

  const list = useInfiniteQuery({
    queryKey: identitiesKey(routeId ?? '', status, search),
    enabled: routeId !== undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      fetchIdentityMappings(routeId as string, {
        status,
        q: search,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  const decide = useMutation({
    mutationFn: (v: {
      mapping: IdentityMapping;
      action: 'confirm' | 'exclude' | 'unmap';
      targetIdentityId?: string;
      reason?: string;
    }) =>
      decideIdentity(routeId as string, v.mapping.id, v.action, {
        ...(v.targetIdentityId ? { targetIdentityId: v.targetIdentityId } : {}),
        ...(v.reason ? { reason: v.reason } : {}),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mapping', 'identities'] }),
  });

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
            ...MAPPING_STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) })),
          ]}
        />
        <Input.Search
          allowClear
          aria-label={t('filter.search')}
          placeholder={t('filter.searchPlaceholder')}
          onSearch={setSearch}
          className="w-64"
        />
        <Button icon={<UploadOutlined aria-hidden />} onClick={() => setImportOpen(true)}>
          {t('csv.open')}
        </Button>
      </Space>

      {list.isError ? <ErrorAlert error={list.error} /> : null}
      {decide.isError ? <ErrorAlert error={decide.error} /> : null}

      <Table<IdentityMapping>
        rowKey="id"
        size="middle"
        loading={list.isLoading || list.isFetching}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('empty') }}
        columns={[
          {
            title: t('column.source'),
            key: 'source',
            render: (_: unknown, m) => <Person who={m.source} />,
          },
          {
            title: t('column.status'),
            key: 'status',
            render: (_: unknown, m) => (
              <div>
                <StatusTag status={m.status} />
                {m.status === 'excluded' && m.reason ? (
                  <div className="text-xs">
                    <Typography.Text type="secondary">
                      {t('reasonLabel', { reason: m.reason })}
                    </Typography.Text>
                  </div>
                ) : null}
              </div>
            ),
          },
          {
            title: t('column.method'),
            key: 'method',
            render: (_: unknown, m) =>
              m.method === null
                ? ''
                : t.has(`method.${m.method}`)
                  ? t(`method.${m.method}`)
                  : m.method,
          },
          {
            title: t('column.target'),
            key: 'target',
            render: (_: unknown, m) =>
              m.target === null ? (
                ''
              ) : (
                <div>
                  <Person who={m.target} />
                  {m.status === 'suggested' && m.confidence !== null ? (
                    <Typography.Text type="secondary" className="text-xs">
                      {t('confidence', { value: Math.round(m.confidence * 100) })}
                    </Typography.Text>
                  ) : null}
                </div>
              ),
          },
          {
            title: t('column.decided'),
            key: 'decided',
            render: (_: unknown, m) =>
              m.decidedAt === null
                ? ''
                : t('decidedBy', { when: formatDateTime(m.decidedAt), who: m.decidedBy ?? '' }),
          },
          {
            title: t('column.actions'),
            key: 'actions',
            render: (_: unknown, m) => (
              <Space wrap size="small">
                {m.target !== null && m.status !== 'confirmed' ? (
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => decide.mutate({ mapping: m, action: 'confirm' })}
                  >
                    {t('action.confirm')}
                  </Button>
                ) : null}
                {m.status !== 'excluded' ? (
                  <Button size="small" onClick={() => setChanging(m)}>
                    {t('action.changeTarget')}
                  </Button>
                ) : null}
                {m.status !== 'excluded' ? (
                  <Button size="small" onClick={() => setExcluding(m)}>
                    {t('action.exclude')}
                  </Button>
                ) : null}
                {m.status !== 'unmapped' ? (
                  <Button
                    size="small"
                    onClick={() => decide.mutate({ mapping: m, action: 'unmap' })}
                  >
                    {t('action.unmap')}
                  </Button>
                ) : null}
              </Space>
            ),
          },
        ]}
      />
      {list.hasNextPage ? (
        <Button onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
          {t('loadMore')}
        </Button>
      ) : null}

      <ExcludeModal
        mapping={excluding}
        onCancel={() => setExcluding(undefined)}
        onSubmit={(reason) => {
          if (excluding) decide.mutate({ mapping: excluding, action: 'exclude', reason });
          setExcluding(undefined);
        }}
      />
      <ChangeTargetModal
        routeId={routeId}
        mapping={changing}
        onCancel={() => setChanging(undefined)}
        onSubmit={(targetIdentityId) => {
          if (changing) decide.mutate({ mapping: changing, action: 'confirm', targetIdentityId });
          setChanging(undefined);
        }}
      />
      {routeId !== undefined ? (
        <CsvImportDrawer
          routeId={routeId}
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onApplied={() => queryClient.invalidateQueries({ queryKey: ['mapping', 'identities'] })}
        />
      ) : null}
    </div>
  );
}

/** Exclusion needs a reason (AUTH-050 step 4). */
function ExcludeModal({
  mapping,
  onCancel,
  onSubmit,
}: {
  readonly mapping: IdentityMapping | undefined;
  readonly onCancel: () => void;
  readonly onSubmit: (reason: string) => void;
}) {
  const t = useTranslations('mapping.exclude');
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  return (
    <Modal
      open={mapping !== undefined}
      title={t('title')}
      okText={t('submit')}
      cancelText={t('cancel')}
      okButtonProps={{ disabled: trimmed === '' }}
      onCancel={onCancel}
      onOk={() => {
        onSubmit(trimmed);
        setReason('');
      }}
      destroyOnHidden
    >
      <Typography.Paragraph>
        {t('body', { name: mapping ? personLabel(mapping.source) : '' })}
      </Typography.Paragraph>
      <Input.TextArea
        aria-label={t('reason')}
        placeholder={t('reasonPlaceholder')}
        value={reason}
        maxLength={MAX_REASON}
        showCount
        rows={3}
        onChange={(e) => setReason(e.target.value)}
      />
    </Modal>
  );
}

/** "Change target": search the Route's target Identities and confirm the chosen one. */
function ChangeTargetModal({
  routeId,
  mapping,
  onCancel,
  onSubmit,
}: {
  readonly routeId: string | undefined;
  readonly mapping: IdentityMapping | undefined;
  readonly onCancel: () => void;
  readonly onSubmit: (targetIdentityId: string) => void;
}) {
  const t = useTranslations('mapping.changeTarget');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string>();
  const options = useQuery({
    queryKey: ['mapping', 'targets', routeId, search],
    enabled: routeId !== undefined && mapping !== undefined,
    queryFn: () => fetchTargetIdentities(routeId as string, search),
  });
  return (
    <Modal
      open={mapping !== undefined}
      title={t('title')}
      okText={t('submit')}
      cancelText={t('cancel')}
      okButtonProps={{ disabled: picked === undefined }}
      onCancel={onCancel}
      onOk={() => {
        if (picked) onSubmit(picked);
        setPicked(undefined);
      }}
      destroyOnHidden
    >
      <Typography.Paragraph>
        {t('body', { name: mapping ? personLabel(mapping.source) : '' })}
      </Typography.Paragraph>
      <Select
        showSearch
        aria-label={t('target')}
        placeholder={t('targetPlaceholder')}
        className="w-full"
        filterOption={false}
        onSearch={setSearch}
        onChange={setPicked}
        value={picked}
        loading={options.isFetching}
        notFoundContent={t('none')}
        options={(options.data ?? []).map((i) => ({
          value: i.id,
          label: [personLabel(i), i.email].filter(Boolean).join(' / '),
        }))}
      />
    </Modal>
  );
}
