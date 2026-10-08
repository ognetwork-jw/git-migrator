'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { decideGroup, fetchGroupMappings, type GroupMapping, groupsKey } from './api.ts';
import { ErrorAlert, RouteSelect, StatusTag, useRouteChoice } from './shared.tsx';

/** UI-028: Group to team mappings: planned slug (editable), status, member counts, collisions. */
export function GroupMappingView() {
  const t = useTranslations('mapping.groups');
  const common = useTranslations('mapping');
  const queryClient = useQueryClient();
  const [chosenRoute, setChosenRoute] = useState<string>();
  const [renaming, setRenaming] = useState<GroupMapping>();
  const { routes, routeId, query: routesQuery } = useRouteChoice(chosenRoute);

  const list = useQuery({
    queryKey: groupsKey(routeId ?? ''),
    enabled: routeId !== undefined,
    queryFn: () => fetchGroupMappings(routeId as string),
  });
  const decide = useMutation({
    mutationFn: (v: {
      mapping: GroupMapping;
      action: 'confirm' | 'rename';
      plannedSlug?: string;
    }) =>
      decideGroup(routeId as string, v.mapping.id, v.action, {
        ...(v.plannedSlug ? { plannedSlug: v.plannedSlug } : {}),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mapping', 'groups'] }),
  });

  if (routesQuery.isError) return <ErrorAlert error={routesQuery.error} />;
  if (routesQuery.isSuccess && routeId === undefined) {
    return <Typography.Paragraph type="secondary">{common('noRoutes')}</Typography.Paragraph>;
  }

  return (
    <div className="flex flex-col gap-4">
      <Space wrap>
        <RouteSelect routes={routes} value={routeId} onChange={setChosenRoute} />
      </Space>
      {list.isError ? <ErrorAlert error={list.error} /> : null}
      {decide.isError ? <ErrorAlert error={decide.error} /> : null}
      <Table<GroupMapping>
        rowKey="id"
        size="middle"
        loading={list.isLoading || list.isFetching}
        dataSource={list.data ?? []}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('empty') }}
        columns={[
          {
            title: t('column.source'),
            key: 'source',
            render: (_: unknown, g) => (
              <div>
                <div>{g.sourceGroup.name}</div>
                <Typography.Text type="secondary" className="text-xs">
                  {t('members', { count: g.sourceGroup.memberCount })}
                </Typography.Text>
              </div>
            ),
          },
          {
            title: t('column.plannedSlug'),
            key: 'slug',
            render: (_: unknown, g) => (
              <Space>
                <Typography.Text code>{g.plannedSlug}</Typography.Text>
                {g.collision ? <Tag color="warning">{t('collision')}</Tag> : null}
              </Space>
            ),
          },
          {
            title: t('column.status'),
            key: 'status',
            render: (_: unknown, g) => <StatusTag status={g.status} />,
          },
          {
            title: t('column.target'),
            key: 'target',
            render: (_: unknown, g) =>
              g.targetGroup === null ? (
                <Typography.Text type="secondary">{t('toCreate')}</Typography.Text>
              ) : (
                <div>
                  <div>{g.targetGroup.name}</div>
                  <Typography.Text type="secondary" className="text-xs">
                    {t('members', { count: g.targetGroup.memberCount })}
                  </Typography.Text>
                </div>
              ),
          },
          {
            title: t('column.actions'),
            key: 'actions',
            render: (_: unknown, g) => (
              <Space wrap size="small">
                {g.targetGroup !== null && g.status !== 'confirmed' ? (
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => decide.mutate({ mapping: g, action: 'confirm' })}
                  >
                    {t('action.confirm')}
                  </Button>
                ) : null}
                {g.status !== 'confirmed' ? (
                  <Button size="small" onClick={() => setRenaming(g)}>
                    {t('action.rename')}
                  </Button>
                ) : null}
              </Space>
            ),
          },
        ]}
      />
      <RenameModal
        mapping={renaming}
        onCancel={() => setRenaming(undefined)}
        onSubmit={(plannedSlug) => {
          if (renaming) decide.mutate({ mapping: renaming, action: 'rename', plannedSlug });
          setRenaming(undefined);
        }}
      />
    </div>
  );
}

/** A team slug: lowercase letters, digits and single hyphens, at most 100 characters. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function RenameModal({
  mapping,
  onCancel,
  onSubmit,
}: {
  readonly mapping: GroupMapping | undefined;
  readonly onCancel: () => void;
  readonly onSubmit: (slug: string) => void;
}) {
  const t = useTranslations('mapping.groups.rename');
  const [slug, setSlug] = useState<string>();
  const value = slug ?? mapping?.plannedSlug ?? '';
  const valid = value.length <= 100 && SLUG_PATTERN.test(value);
  return (
    <Modal
      open={mapping !== undefined}
      title={t('title')}
      okText={t('submit')}
      cancelText={t('cancel')}
      okButtonProps={{ disabled: !valid }}
      onCancel={() => {
        setSlug(undefined);
        onCancel();
      }}
      onOk={() => {
        onSubmit(value);
        setSlug(undefined);
      }}
      destroyOnHidden
    >
      <Typography.Paragraph>{t('body')}</Typography.Paragraph>
      <Input
        aria-label={t('slug')}
        value={value}
        maxLength={100}
        status={valid ? undefined : 'error'}
        onChange={(e) => setSlug(e.target.value)}
      />
      {valid ? null : <Typography.Text type="danger">{t('invalid')}</Typography.Text>}
    </Modal>
  );
}
