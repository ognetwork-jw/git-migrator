'use client';

import { joinSecretParams, type ParamValues } from '@git-migrator/guidance';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Collapse, Input, Tag, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import { formatDateTime } from '../format.ts';
import { GuidanceView } from '../guidance/guidance-view.tsx';
import { ErrorAlert } from '../mapping/shared.tsx';
import { ActionError } from './action-error.tsx';
import {
  detailRootKey,
  fetchTasks,
  saveTaskNote,
  type TaskAction,
  type TaskRow,
  taskAction,
  tasksKey,
} from './api.ts';
import { NoteDialog } from './dialogs.tsx';

/** Longest task note (the column is free text; this keeps the page and the audit trail sane). */
const MAX_NOTE = 1000;

const STATUS_COLOR: Record<TaskRow['status'], string | undefined> = {
  open: 'warning',
  done: 'success',
  dismissed: 'default',
};

/** Actions a task in `status` offers (LIF-006): open can be done or dismissed; the rest reopen. */
export function actionsFor(status: TaskRow['status']): readonly TaskAction[] {
  return status === 'open'
    ? ['done', 'dismiss']
    : status === 'dismissed'
      ? ['done', 'reopen']
      : ['reopen'];
}

function NoteEditor({
  task,
  migrationId,
  editable,
}: {
  readonly task: TaskRow;
  readonly migrationId: string;
  readonly editable: boolean;
}) {
  const t = useTranslations('migrationDetail.tasks');
  const queryClient = useQueryClient();
  const labelId = useId();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const save = useMutation({
    mutationFn: (note: string) => saveTaskNote(task.id, note),
    onSuccess: async () => {
      setDraft(undefined);
      await queryClient.invalidateQueries({ queryKey: detailRootKey(migrationId) });
    },
  });
  if (!editable) {
    return task.note ? (
      <p className="m-0">
        <strong>{t('note')}</strong> {task.note}
      </p>
    ) : null;
  }
  const value = draft ?? task.note ?? '';
  return (
    <div className="flex flex-col gap-1">
      <span id={labelId}>{t('note')}</span>
      <Input.TextArea
        aria-labelledby={labelId}
        rows={2}
        maxLength={MAX_NOTE}
        value={value}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div>
        <Button
          size="small"
          loading={save.isPending}
          disabled={draft === undefined || draft === (task.note ?? '')}
          onClick={() => save.mutate(value)}
        >
          {t('saveNote')}
        </Button>
      </div>
      {save.isError ? <ActionError error={save.error} scope="note" /> : null}
    </div>
  );
}

function TaskItem({
  task,
  migrationId,
  operator,
  defaults,
}: {
  readonly task: TaskRow;
  readonly migrationId: string;
  readonly operator: boolean;
  readonly defaults: ParamValues;
}) {
  const t = useTranslations('migrationDetail.tasks');
  const queryClient = useQueryClient();
  const [dismissing, setDismissing] = useState(false);
  const act = useMutation({
    mutationFn: (input: { action: TaskAction; note?: string }) =>
      taskAction(migrationId, task.id, input.action, input.note),
    onSuccess: () => {
      setDismissing(false);
      return queryClient.invalidateQueries({ queryKey: detailRootKey(migrationId) });
    },
  });
  return (
    <div className="flex flex-col gap-3">
      <GuidanceView
        code={task.code}
        params={joinSecretParams(task.params, task.secretParams)}
        fieldPaths={task.sourcePlanItem?.fieldPaths}
        defaults={defaults}
        showTitle={false}
      />
      <NoteEditor task={task} migrationId={migrationId} editable={operator} />
      {task.status !== 'open' && task.completedAt ? (
        <Typography.Text type="secondary">
          {t('completed', {
            when: formatDateTime(task.completedAt),
            who: task.completedBy?.displayName ?? t('system'),
          })}
        </Typography.Text>
      ) : null}
      {operator ? (
        <div className="flex flex-wrap gap-2">
          {actionsFor(task.status).map((action) => (
            <Button
              key={action}
              size="small"
              type={action === 'done' ? 'primary' : 'default'}
              loading={act.isPending && act.variables?.action === action}
              disabled={act.isPending}
              onClick={() => (action === 'dismiss' ? setDismissing(true) : act.mutate({ action }))}
            >
              {t(`action.${action}`)}
            </Button>
          ))}
        </div>
      ) : null}
      {act.isError && !dismissing ? <ActionError error={act.error} scope="task" /> : null}
      <NoteDialog
        open={dismissing}
        texts={{ title: t('dismiss.title'), ok: t('dismiss.ok'), body: t('dismiss.body') }}
        label={t('dismiss.note')}
        required={false}
        maxLength={MAX_NOTE}
        loading={act.isPending}
        error={act.error}
        errorScope="task"
        onCancel={() => {
          setDismissing(false);
          act.reset();
        }}
        onSubmit={(note) => act.mutate({ action: 'dismiss', note })}
      />
    </div>
  );
}

/**
 * The Tasks tab (UI-022): the checklist of manual tasks with done, reopen and dismiss, a note per
 * task, and guidance rendered with copyable values (UI-040). Pre tasks come first, then post
 * tasks. Each row is a `TaskItem`, so a later task can add controls without reshaping the tab.
 */
export function TasksTab({
  migrationId,
  operator,
  targetName,
}: {
  readonly migrationId: string;
  readonly operator: boolean;
  readonly targetName: string | null;
}) {
  const t = useTranslations('migrationDetail.tasks');
  const tStatus = useTranslations('migrationDetail.tasks.status');
  const tasks = useQuery({
    queryKey: tasksKey(migrationId),
    queryFn: () => fetchTasks(migrationId),
  });
  const defaults = useMemo<ParamValues>(
    () => (targetName ? { repository: targetName } : {}),
    [targetName],
  );
  if (tasks.isError) return <ErrorAlert error={tasks.error} />;
  if (tasks.isLoading) return <Typography.Text type="secondary">{t('loading')}</Typography.Text>;
  const rows = [...(tasks.data ?? [])].sort(
    (a, b) => Number(a.phase === 'post') - Number(b.phase === 'post'),
  );
  if (rows.length === 0) return <Typography.Text type="secondary">{t('empty')}</Typography.Text>;
  const open = rows.filter((r) => r.status === 'open').length;
  return (
    <div className="flex flex-col gap-3">
      <Typography.Text>{t('summary', { open, total: rows.length })}</Typography.Text>
      <Collapse
        defaultActiveKey={rows.filter((r) => r.status === 'open').map((r) => r.id)}
        items={rows.map((task) => ({
          key: task.id,
          label: (
            <span className="flex flex-wrap items-center gap-2">
              <Tag color={STATUS_COLOR[task.status]}>{tStatus(task.status)}</Tag>
              <Tag>{t(`phase.${task.phase}`)}</Tag>
              <Tag>{task.facetKey}</Tag>
              <code className="font-mono text-xs">{task.code}</code>
              {task.verifiable ? <Tag>{t('verifiable')}</Tag> : null}
            </span>
          ),
          children: (
            <TaskItem
              task={task}
              migrationId={migrationId}
              operator={operator}
              defaults={defaults}
            />
          ),
        }))}
      />
    </div>
  );
}
