'use client';

import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Modal, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { ErrorAlert, RouteSelect, useRouteChoice } from '../mapping/shared.tsx';
import {
  createWebhook,
  deleteWebhook,
  fetchWebhooks,
  updateWebhook,
  type WebhookRow,
  webhooksKey,
} from './api.ts';
import { MAX_NOTE_LENGTH, matchingPatterns, patternProblem } from './rules-draft.ts';

const TESTER_DEBOUNCE_MS = 200;

/** The value after it has stayed the same for `delay` ms, so typing does not match on every key. */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/** UI-031: the Route's webhook allowlist, CRUD, and a pattern tester (FAC-WEB-002). */
export function WebhookAllowlistView() {
  const t = useTranslations('config.webhooks');
  const queryClient = useQueryClient();
  const [chosenRoute, setChosenRoute] = useState<string>();
  const [editing, setEditing] = useState<{ row?: WebhookRow }>();
  const [testUrl, setTestUrl] = useState('');
  const testedUrl = useDebounced(testUrl, TESTER_DEBOUNCE_MS);
  const { routes, routeId, query: routesQuery } = useRouteChoice(chosenRoute);

  const entries = useQuery({
    queryKey: webhooksKey(routeId ?? ''),
    enabled: routeId !== undefined,
    queryFn: () => fetchWebhooks(routeId as string),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteWebhook(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['config', 'webhooks'] }),
  });

  if (routesQuery.isError) return <ErrorAlert error={routesQuery.error} />;
  if (routesQuery.isSuccess && routeId === undefined) {
    return <Typography.Paragraph type="secondary">{t('noRoutes')}</Typography.Paragraph>;
  }

  const rows = entries.data ?? [];
  const matches = matchingPatterns(testedUrl, rows);

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

      {entries.isError ? <ErrorAlert error={entries.error} /> : null}
      {remove.isError ? <ErrorAlert error={remove.error} /> : null}

      <Table<WebhookRow>
        rowKey="id"
        size="middle"
        loading={entries.isLoading || entries.isFetching}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('empty') }}
        columns={[
          {
            title: t('column.pattern'),
            key: 'pattern',
            render: (_: unknown, r) => <Typography.Text code>{r.pattern}</Typography.Text>,
          },
          {
            title: t('column.note'),
            key: 'note',
            render: (_: unknown, r) => r.note ?? '',
          },
          {
            title: t('column.actions'),
            key: 'actions',
            render: (_: unknown, r) => (
              <Space wrap size="small">
                <Button
                  size="small"
                  icon={<EditOutlined aria-hidden />}
                  onClick={() => setEditing({ row: r })}
                >
                  {t('edit')}
                </Button>
                <Popconfirm
                  title={t('deleteTitle')}
                  okText={t('deleteConfirm')}
                  cancelText={t('cancel')}
                  okButtonProps={{ danger: true }}
                  onConfirm={() => remove.mutate(r.id)}
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

      <section aria-labelledby="webhook-tester" className="flex flex-col gap-3">
        <Typography.Title id="webhook-tester" level={2} className="!text-lg">
          {t('tester.title')}
        </Typography.Title>
        <Input
          aria-label={t('tester.url')}
          placeholder={t('tester.urlPlaceholder')}
          value={testUrl}
          maxLength={2048}
          allowClear
          onChange={(e) => setTestUrl(e.target.value)}
        />
        {testedUrl.trim() === '' ? null : matches.length === 0 ? (
          <Alert type="info" showIcon title={t('tester.none')} />
        ) : (
          <div className="flex flex-col gap-2">
            <Alert type="success" showIcon title={t('tester.matched', { count: matches.length })} />
            <ul className="flex flex-col gap-1">
              {matches.map((m) => (
                <li key={m.id}>
                  <Tag color="success">{t('tester.match')}</Tag>
                  <Typography.Text code>{m.pattern}</Typography.Text>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Typography.Text type="secondary" className="text-xs">
          {t('tester.privacy')}
        </Typography.Text>
      </section>

      {editing && routeId !== undefined ? (
        <WebhookModal
          key={editing.row?.id ?? 'new'}
          routeId={routeId}
          row={editing.row}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </div>
  );
}

function WebhookModal({
  routeId,
  row,
  onClose,
}: {
  readonly routeId: string;
  readonly row: WebhookRow | undefined;
  readonly onClose: () => void;
}) {
  const t = useTranslations('config.webhooks');
  const queryClient = useQueryClient();
  const [pattern, setPattern] = useState(row?.pattern ?? '');
  const [note, setNote] = useState(row?.note ?? '');
  const problem = patternProblem(pattern);

  const save = useMutation({
    mutationFn: () => {
      const value = pattern.trim();
      const text = note.trim() === '' ? null : note.trim();
      return row ? updateWebhook(row.id, value, text) : createWebhook(routeId, value, text);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['config', 'webhooks'] });
      onClose();
    },
  });

  return (
    <Modal
      open
      destroyOnHidden
      title={row ? t('modal.editTitle') : t('modal.addTitle')}
      okText={t('save')}
      cancelText={t('cancel')}
      okButtonProps={{ disabled: problem !== undefined || save.isPending }}
      onCancel={onClose}
      onOk={() => save.mutate()}
    >
      <div className="flex flex-col gap-3">
        <Input
          aria-label={t('modal.pattern')}
          placeholder={t('modal.patternPlaceholder')}
          value={pattern}
          maxLength={2048}
          status={pattern !== '' && problem !== undefined ? 'error' : undefined}
          onChange={(e) => setPattern(e.target.value)}
        />
        {pattern !== '' && problem !== undefined ? (
          <Typography.Text type="danger">{t(`problem.${problem}`)}</Typography.Text>
        ) : (
          <Typography.Text type="secondary">{t('modal.patternHelp')}</Typography.Text>
        )}
        <Input
          aria-label={t('modal.note')}
          placeholder={t('modal.notePlaceholder')}
          value={note}
          maxLength={MAX_NOTE_LENGTH}
          onChange={(e) => setNote(e.target.value)}
        />
        {save.isError ? <ErrorAlert error={save.error} /> : null}
      </div>
    </Modal>
  );
}
