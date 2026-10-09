'use client';

import { PlusOutlined } from '@ant-design/icons';
import { can } from '@git-migrator/auth/capabilities';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Form, Input, Modal, Popconfirm, Progress, Space, Table } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { dashboardKey, fetchDashboard } from '../dashboard/api.ts';
import { formatDateTime } from '../format.ts';
import { ErrorAlert } from '../mapping/shared.tsx';
import { DONE_STATUSES } from '../repositories/query.ts';
import { useActor } from '../shell/actor-context.tsx';
import { useLiveTopics } from '../shell/live-topics.tsx';
import {
  createWave,
  deleteWave,
  fetchWaveRows,
  updateWave,
  type WaveInput,
  type WaveRow,
  wavePageKey,
} from './api.ts';

/** What the list follows (ADR-0270): membership and status changes move the progress. */
export const WAVE_TOPICS: readonly string[] = ['list:migrations'];
const waveKeysFor = () => [dashboardKey, ['waves']] as const;

const MAX_NAME = 200;
const MAX_DESCRIPTION = 2000;

/** The date part of an instant, for a `date` input. */
const toDateInput = (iso: string | null): string => (iso ? iso.slice(0, 10) : '');
/** A `date` input value as an instant (UTC midnight), or `null` for none. */
export const fromDateInput = (value: string): string | null => {
  if (value.trim() === '') return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export const doneCount = (byStatus: Readonly<Record<string, number>>): number =>
  DONE_STATUSES.reduce((sum, s) => sum + (byStatus[s] ?? 0), 0);

/** UI-024: Waves, create, edit and delete; progress is the count of finished repositories. */
export function WavesView() {
  const t = useTranslations('waves');
  const actor = useActor();
  const manage = can(actor, 'manageWaves');
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<WaveRow | 'new' | undefined>();

  useLiveTopics(WAVE_TOPICS, waveKeysFor);
  const rows = useQuery({ queryKey: wavePageKey, queryFn: fetchWaveRows });
  const dashboard = useQuery({ queryKey: dashboardKey, queryFn: fetchDashboard });
  const progress = new Map((dashboard.data?.waves ?? []).map((w) => [w.id, w]));

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['waves'] }),
      queryClient.invalidateQueries({ queryKey: dashboardKey }),
      queryClient.invalidateQueries({ queryKey: ['repository-waves'] }),
      queryClient.invalidateQueries({ queryKey: ['repositories'] }),
    ]);
  };
  const remove = useMutation({ mutationFn: deleteWave, onSuccess: refresh });

  return (
    <div className="flex flex-col gap-4">
      {manage ? (
        <div>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
            {t('create')}
          </Button>
        </div>
      ) : null}
      {rows.isError ? <ErrorAlert error={rows.error} /> : null}
      {remove.isError ? <ErrorAlert error={remove.error} /> : null}
      {dashboard.data?.wavesTruncated ? (
        <Alert
          type="warning"
          showIcon
          title={t('truncated', { count: dashboard.data.waves.length })}
        />
      ) : null}
      <Table<WaveRow>
        rowKey="id"
        loading={rows.isLoading}
        dataSource={rows.data ?? []}
        locale={{ emptyText: t('empty') }}
        pagination={false}
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: t('column.name'),
            key: 'name',
            render: (_: unknown, row) => (
              <Link href={`/waves/${encodeURIComponent(row.id)}`}>{row.name}</Link>
            ),
          },
          {
            title: t('column.targetDate'),
            key: 'targetDate',
            render: (_: unknown, row) =>
              row.targetDate ? formatDateTime(row.targetDate) : t('noDate'),
          },
          {
            title: t('column.description'),
            key: 'description',
            render: (_: unknown, row) => row.description ?? '',
          },
          {
            title: t('column.progress'),
            key: 'progress',
            render: (_: unknown, row) => {
              const wave = progress.get(row.id);
              if (!wave) return null;
              const done = doneCount(wave.byStatus);
              return (
                <Progress
                  size="small"
                  percent={wave.total === 0 ? 0 : Math.round((done / wave.total) * 100)}
                  aria-label={row.name}
                  format={() => t('progress', { done, total: wave.total })}
                />
              );
            },
          },
          ...(manage
            ? [
                {
                  title: t('column.actions'),
                  key: 'actions',
                  render: (_: unknown, row: WaveRow) => (
                    <Space>
                      <Button
                        size="small"
                        aria-label={t('editLabel', { name: row.name })}
                        onClick={() => setEditing(row)}
                      >
                        {t('edit')}
                      </Button>
                      <Popconfirm
                        title={t('deleteConfirm', { name: row.name })}
                        okText={t('deleteOk')}
                        cancelText={t('deleteCancel')}
                        onConfirm={() => remove.mutate(row.id)}
                      >
                        <Button
                          size="small"
                          danger
                          aria-label={t('deleteLabel', { name: row.name })}
                        >
                          {t('delete')}
                        </Button>
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]
            : []),
        ]}
      />
      {editing !== undefined ? (
        <WaveForm
          wave={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={async () => {
            setEditing(undefined);
            await refresh();
          }}
        />
      ) : null}
    </div>
  );
}

interface FormValues {
  name: string;
  targetDate: string;
  description: string;
}

function WaveForm({
  wave,
  onClose,
  onSaved,
}: {
  readonly wave: WaveRow | undefined;
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void>;
}) {
  const t = useTranslations('waves');
  const [form] = Form.useForm<FormValues>();
  const save = useMutation({
    mutationFn: (values: FormValues) => {
      const input: WaveInput = {
        name: values.name.trim(),
        targetDate: fromDateInput(values.targetDate ?? ''),
        description: values.description?.trim() ? values.description.trim() : null,
      };
      return wave ? updateWave(wave.id, input) : createWave(input);
    },
    onSuccess: () => onSaved(),
  });
  return (
    <Modal
      open
      title={wave ? t('editTitle') : t('createTitle')}
      okText={t('save')}
      cancelText={t('cancel')}
      confirmLoading={save.isPending}
      onCancel={onClose}
      onOk={() =>
        form.validateFields().then(
          (values) => save.mutate(values),
          () => undefined,
        )
      }
    >
      <Form<FormValues>
        form={form}
        layout="vertical"
        initialValues={{
          name: wave?.name ?? '',
          targetDate: toDateInput(wave?.targetDate ?? null),
          description: wave?.description ?? '',
        }}
      >
        <Form.Item
          name="name"
          label={t('field.name')}
          rules={[{ required: true, whitespace: true, max: MAX_NAME }]}
        >
          <Input />
        </Form.Item>
        <Form.Item name="targetDate" label={t('field.targetDate')}>
          <Input type="date" />
        </Form.Item>
        <Form.Item
          name="description"
          label={t('field.description')}
          rules={[{ max: MAX_DESCRIPTION }]}
        >
          <Input.TextArea rows={3} />
        </Form.Item>
      </Form>
      {save.isError ? <ErrorAlert error={save.error} /> : null}
    </Modal>
  );
}
