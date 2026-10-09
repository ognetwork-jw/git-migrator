'use client';

import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ApiError } from '../api/http.ts';
import { formatDateTime } from '../format.ts';
import { ErrorAlert, RouteSelect, useRouteChoice } from '../mapping/shared.tsx';
import {
  createOverlay,
  deleteOverlay,
  fetchCapabilityMatrix,
  fetchOverlays,
  matrixKey,
  type OverlayRow,
  overlaysKey,
  updateOverlay,
} from './api.ts';
import { overlayProblems, parseOverlayData } from './rules-draft.ts';

const PREVIEW_CHARS = 160;
const MAX_ISSUES_SHOWN = 20;

/** UI-032: per Route and Facet, a JSON overlay that is merged onto the desired target (LIF-048). */
export function OverlaysView() {
  const t = useTranslations('config.overlays');
  const queryClient = useQueryClient();
  const [chosenRoute, setChosenRoute] = useState<string>();
  const [editing, setEditing] = useState<{ row?: OverlayRow }>();
  const { routes, routeId, query: routesQuery } = useRouteChoice(chosenRoute);

  const overlays = useQuery({
    queryKey: overlaysKey(routeId ?? ''),
    enabled: routeId !== undefined,
    queryFn: () => fetchOverlays(routeId as string),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteOverlay(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['config', 'overlays'] }),
  });

  if (routesQuery.isError) return <ErrorAlert error={routesQuery.error} />;
  if (routesQuery.isSuccess && routeId === undefined) {
    return <Typography.Paragraph type="secondary">{t('noRoutes')}</Typography.Paragraph>;
  }

  return (
    <div className="flex flex-col gap-4">
      <Space wrap>
        <RouteSelect routes={routes} value={routeId} onChange={setChosenRoute} />
        <Button
          type="primary"
          icon={<PlusOutlined aria-hidden />}
          disabled={routeId === undefined}
          onClick={() => setEditing({})}
        >
          {t('add')}
        </Button>
      </Space>
      <Typography.Paragraph type="secondary">{t('help')}</Typography.Paragraph>

      {overlays.isError ? <ErrorAlert error={overlays.error} /> : null}
      {remove.isError ? <ErrorAlert error={remove.error} /> : null}

      <Table<OverlayRow>
        rowKey="id"
        size="middle"
        loading={overlays.isLoading || overlays.isFetching}
        dataSource={overlays.data ?? []}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('empty') }}
        columns={[
          {
            title: t('column.facet'),
            key: 'facet',
            render: (_: unknown, o) => <Typography.Text code>{o.facetKey}</Typography.Text>,
          },
          {
            title: t('column.status'),
            key: 'status',
            render: (_: unknown, o) => (
              <Tag>{o.enabled ? t('status.enabled') : t('status.disabled')}</Tag>
            ),
          },
          {
            title: t('column.data'),
            key: 'data',
            render: (_: unknown, o) => {
              const text = JSON.stringify(o.data);
              return (
                <Typography.Text code className="text-xs">
                  {text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text}
                </Typography.Text>
              );
            },
          },
          {
            title: t('column.updated'),
            key: 'updated',
            render: (_: unknown, o) => formatDateTime(o.updatedAt),
          },
          {
            title: t('column.actions'),
            key: 'actions',
            render: (_: unknown, o) => (
              <Space wrap size="small">
                <Button
                  size="small"
                  icon={<EditOutlined aria-hidden />}
                  onClick={() => setEditing({ row: o })}
                >
                  {t('edit')}
                </Button>
                <Popconfirm
                  title={t('deleteTitle')}
                  okText={t('deleteConfirm')}
                  cancelText={t('cancel')}
                  okButtonProps={{ danger: true }}
                  onConfirm={() => remove.mutate(o.id)}
                >
                  <Button size="small" danger icon={<DeleteOutlined aria-hidden />}>
                    {t('delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      {editing && routeId !== undefined ? (
        <OverlayModal
          key={editing.row?.id ?? 'new'}
          routeId={routeId}
          row={editing.row}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </div>
  );
}

function OverlayModal({
  routeId,
  row,
  onClose,
}: {
  readonly routeId: string;
  readonly row: OverlayRow | undefined;
  readonly onClose: () => void;
}) {
  const t = useTranslations('config.overlays');
  const queryClient = useQueryClient();
  const [facetKey, setFacetKey] = useState(row?.facetKey ?? '');
  const [enabled, setEnabled] = useState(row?.enabled ?? true);
  const [text, setText] = useState(row ? JSON.stringify(row.data, null, 2) : '{\n  \n}');
  const facets = useQuery({ queryKey: matrixKey, queryFn: fetchCapabilityMatrix });
  const parsed = parseOverlayData(text);
  const facetOptions = (facets.data?.rows ?? []).map((r) => ({
    value: r.facet,
    label: r.facet,
  }));
  // The same check the server runs (DOM-003): the Facet's schema, deep-partial and strict.
  const issues = parsed.ok && facetKey !== '' ? overlayProblems(facetKey, parsed.data) : [];
  const valid = parsed.ok && facetKey !== '' && issues.length === 0;

  const save = useMutation({
    mutationFn: () => {
      if (!parsed.ok || facetKey === '') throw new Error('save is blocked');
      return row
        ? updateOverlay(row.id, { data: parsed.data, enabled })
        : createOverlay(routeId, { facetKey, data: parsed.data, enabled });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['config', 'overlays'] });
      onClose();
    },
  });

  return (
    <Modal
      open
      destroyOnHidden
      width={720}
      title={row ? t('modal.editTitle') : t('modal.addTitle')}
      okText={t('save')}
      cancelText={t('cancel')}
      okButtonProps={{ disabled: !valid || save.isPending }}
      onCancel={onClose}
      onOk={() => save.mutate()}
    >
      <div className="flex flex-col gap-3">
        <Space wrap>
          <Select<string>
            aria-label={t('modal.facet')}
            placeholder={t('modal.facetPlaceholder')}
            className="min-w-64"
            value={facetKey || undefined}
            disabled={row !== undefined}
            onChange={setFacetKey}
            options={facetOptions}
            loading={facets.isLoading}
          />
          <Space>
            <Switch aria-label={t('modal.enabled')} checked={enabled} onChange={setEnabled} />
            <Typography.Text>{t('modal.enabled')}</Typography.Text>
          </Space>
        </Space>
        <Input.TextArea
          aria-label={t('modal.data')}
          rows={12}
          value={text}
          spellCheck={false}
          status={parsed.ok ? undefined : 'error'}
          className="font-mono text-sm"
          onChange={(e) => setText(e.target.value)}
        />
        {parsed.ok ? (
          <Typography.Text type="secondary">{t('modal.dataHelp')}</Typography.Text>
        ) : (
          <Typography.Text type="danger" role="alert">
            {t(`problem.${parsed.problem}`)}
          </Typography.Text>
        )}
        <IssueList issues={issues} />
        {facets.isError ? (
          <Alert type="warning" showIcon title={t('modal.facetsUnavailable')} />
        ) : null}
        {save.isError ? <ErrorAlert error={save.error} /> : null}
        {save.error instanceof ApiError ? <IssueList issues={save.error.errors} /> : null}
      </div>
    </Modal>
  );
}

/** The document problems, one per line with the path into the document (UI-032). */
function IssueList({ issues }: { readonly issues: readonly { path: string; message: string }[] }) {
  const t = useTranslations('config.overlays');
  if (issues.length === 0) return null;
  return (
    <div role="alert" className="flex flex-col gap-1">
      <Typography.Text type="danger">{t('problem.schema')}</Typography.Text>
      <ul className="flex max-h-40 flex-col gap-1 overflow-auto">
        {issues.slice(0, MAX_ISSUES_SHOWN).map((issue) => (
          <li key={`${issue.path}:${issue.message}`}>
            <Typography.Text code>
              {issue.path === '' ? t('problem.root') : issue.path}
            </Typography.Text>{' '}
            <Typography.Text>{issue.message}</Typography.Text>
          </li>
        ))}
      </ul>
      {issues.length > MAX_ISSUES_SHOWN ? (
        <Typography.Text type="secondary">
          {t('problem.more', { count: issues.length - MAX_ISSUES_SHOWN })}
        </Typography.Text>
      ) : null}
    </div>
  );
}
