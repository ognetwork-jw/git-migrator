'use client';

import { can } from '@git-migrator/auth/capabilities';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Descriptions, Steps, Table, Tag, Typography } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDateTime } from '../format.ts';
import { ErrorAlert } from '../mapping/shared.tsx';
import { ActionError } from '../migration-detail/action-error.tsx';
import { cancelRun } from '../migration-detail/api.ts';
import { splitDuration } from '../repositories/format.ts';
import { useActor } from '../shell/actor-context.tsx';
import { useLiveTopics } from '../shell/live-topics.tsx';
import {
  fetchLogAfter,
  fetchMutations,
  fetchRun,
  fetchSteps,
  LOG_MAX_LINES,
  LOG_PAGE,
  logKey,
  type MutationRow,
  mutationsKey,
  type RunLogRow,
  type RunStepRow,
  runKey,
  runRootKey,
  stepsKey,
} from './api.ts';
import { LogViewer } from './log-viewer.tsx';

/** Statuses in which a Run can still be cancelled (LIF-040). */
const CANCELLABLE = ['queued', 'running'];

const STEP_STATUS: Record<RunStepRow['status'], 'wait' | 'process' | 'finish' | 'error'> = {
  pending: 'wait',
  running: 'process',
  succeeded: 'finish',
  failed: 'error',
  skipped: 'wait',
};

const RUN_COLOR: Record<string, string | undefined> = {
  queued: 'default',
  running: 'processing',
  succeeded: 'success',
  partial: 'warning',
  failed: 'error',
  cancelled: 'default',
};

/**
 * The lines of a Run's log. The first fetch reads the log from the start; every live `run.log`
 * event fetches only what is new (the ids are time ordered), and the page keeps the newest
 * {@link LOG_MAX_LINES} lines.
 */
export function useRunLog(runId: string) {
  const cache = useRef<{ runId: string; rows: readonly RunLogRow[]; dropped: boolean }>({
    runId,
    rows: [],
    dropped: false,
  });
  const query = useQuery({
    queryKey: logKey(runId),
    structuralSharing: false,
    queryFn: async () => {
      if (cache.current.runId !== runId) cache.current = { runId, rows: [], dropped: false };
      let rows = cache.current.rows;
      for (;;) {
        const page = await fetchLogAfter(runId, rows[rows.length - 1]?.id);
        rows = [...rows, ...page];
        if (page.length < LOG_PAGE) break;
      }
      let dropped = cache.current.dropped;
      if (rows.length > LOG_MAX_LINES) {
        rows = rows.slice(rows.length - LOG_MAX_LINES);
        dropped = true;
      }
      cache.current = { runId, rows, dropped };
      return { rows, dropped };
    },
  });
  return query;
}

/** The current time, refreshed every second while `active` (a running Run's durations tick). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** The elapsed time of a step or Run as a message argument; `null` before it has started. */
export function elapsed(
  startedAt: string | null,
  finishedAt: string | null,
  now: number,
): { unit: 'seconds' | 'minutes' | 'hours' | 'days'; count: number } | null {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return splitDuration(Math.max(0, (end - start) / 1000));
}

function StepsTimeline({
  steps,
  now,
}: {
  readonly steps: readonly RunStepRow[];
  readonly now: number;
}) {
  const t = useTranslations('runDetail.steps');
  const tStatus = useTranslations('runDetail.stepStatus');
  if (steps.length === 0) {
    return <Typography.Text type="secondary">{t('empty')}</Typography.Text>;
  }
  return (
    <Steps
      orientation="vertical"
      size="small"
      items={steps.map((step) => {
        const time = elapsed(step.startedAt, step.finishedAt, now);
        return {
          key: step.id,
          status: STEP_STATUS[step.status],
          title: (
            <span className="flex flex-wrap items-center gap-2">
              <code className="font-mono text-sm">{step.stepKey}</code>
              <Tag>{tStatus(step.status)}</Tag>
            </span>
          ),
          content: (
            <span className="text-sm opacity-80">
              {time ? t(`duration.${time.unit}`, { count: time.count }) : t('notStarted')}
              {step.attempts > 1 ? ` · ${t('attempts', { count: step.attempts })}` : ''}
            </span>
          ),
        };
      })}
    />
  );
}

function MutationsTable({ runId }: { readonly runId: string }) {
  const t = useTranslations('runDetail.mutations');
  const mutations = useQuery({
    queryKey: mutationsKey(runId),
    queryFn: () => fetchMutations(runId),
  });
  if (mutations.isError) return <ErrorAlert error={mutations.error} />;
  return (
    <Table<MutationRow>
      size="small"
      rowKey="id"
      loading={mutations.isLoading}
      pagination={false}
      locale={{ emptyText: t('empty') }}
      dataSource={[...(mutations.data ?? [])]}
      columns={[
        {
          title: t('column.side'),
          dataIndex: 'side',
          render: (v: string) => (t.has(`side.${v}`) ? t(`side.${v}`) : v),
        },
        { title: t('column.facet'), dataIndex: 'facetKey' },
        {
          title: t('column.action'),
          dataIndex: 'action',
          render: (v: string) => (t.has(`action.${v}`) ? t(`action.${v}`) : v),
        },
        {
          title: t('column.paths'),
          dataIndex: 'paths',
          render: (paths: readonly string[]) => (
            <code className="break-words font-mono text-xs">{paths.join(', ')}</code>
          ),
        },
        {
          title: t('column.undone'),
          dataIndex: 'undoneAt',
          render: (v: string | null) => (v ? formatDateTime(v) : t('notUndone')),
        },
      ]}
    />
  );
}

/** A short, safe text of a Run's error: its code or message when it is a string, never the raw object. */
export function errorSummary(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  const text = typeof code === 'string' ? code : typeof message === 'string' ? message : undefined;
  return text === undefined ? undefined : text.slice(0, 300);
}

/**
 * UI-023: one Run. An antd Steps timeline of its steps with status and duration, the live log (a
 * virtualized viewer with a level filter that follows the tail), the Mutations the Run made, and a
 * Cancel button while it is queued or running. It follows `run:<id>` (JOB-060): `run.updated`
 * refreshes the steps and `run.log` appends to the log.
 */
export function RunDetailView({ id }: { readonly id: string }) {
  const t = useTranslations('runDetail');
  const tKind = useTranslations('runKind');
  const tStatus = useTranslations('runStatus');
  const actor = useActor();
  const queryClient = useQueryClient();
  useLiveTopics([`run:${id}`], () => [runRootKey(id)]);
  const run = useQuery({ queryKey: runKey(id), queryFn: () => fetchRun(id) });
  const steps = useQuery({ queryKey: stepsKey(id), queryFn: () => fetchSteps(id) });
  const log = useRunLog(id);
  const cancel = useMutation({
    mutationFn: () => cancelRun(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: runRootKey(id) }),
  });
  const now = useNow(
    run.data !== null && run.data !== undefined && CANCELLABLE.includes(run.data.status),
  );
  const stepNames = useMemo(
    () => new Map((steps.data ?? []).map((s) => [s.id, s.stepKey] as const)),
    [steps.data],
  );

  if (run.isError) return <ErrorAlert error={run.error} />;
  if (run.isLoading) return <Typography.Text type="secondary">{t('loading')}</Typography.Text>;
  const r = run.data;
  if (r === null || r === undefined) return <Alert type="warning" showIcon title={t('notFound')} />;

  const total = elapsed(r.startedAt ?? r.createdAt, r.finishedAt, now);
  const running = CANCELLABLE.includes(r.status);
  const summary = errorSummary(r.error);

  return (
    <div className="flex flex-col gap-4">
      <Link href={`/repositories/${encodeURIComponent(r.migrationId)}`}>
        {t('back', { name: r.migration.sourceRepository?.fullPath ?? r.migrationId })}
      </Link>
      <Descriptions
        size="small"
        bordered
        column={{ xs: 1, md: 2 }}
        items={[
          { key: 'kind', label: t('kind'), children: tKind.has(r.kind) ? tKind(r.kind) : r.kind },
          {
            key: 'status',
            label: t('status'),
            children: (
              <Tag color={RUN_COLOR[r.status]}>
                {tStatus.has(r.status) ? tStatus(r.status) : r.status}
              </Tag>
            ),
          },
          {
            key: 'started',
            label: t('started'),
            children: r.startedAt ? formatDateTime(r.startedAt) : t('notStarted'),
          },
          {
            key: 'finished',
            label: t('finished'),
            children: r.finishedAt ? formatDateTime(r.finishedAt) : t('notFinished'),
          },
          {
            key: 'duration',
            label: t('duration'),
            children: total
              ? t(`steps.duration.${total.unit}`, { count: total.count })
              : t('notStarted'),
          },
          { key: 'by', label: t('by'), children: r.triggeredBy?.displayName ?? t('system') },
        ]}
      />
      <div aria-live="polite" role="status" className="flex flex-col gap-2">
        {r.cancelRequestedAt && running ? (
          <Alert type="info" showIcon title={t('cancelRequested')} />
        ) : null}
        {summary ? <Alert type="error" showIcon title={t('error', { reason: summary })} /> : null}
        {cancel.isSuccess ? (
          <Alert type="success" showIcon title={t(`cancelOutcome.${cancel.data.outcome}`)} />
        ) : null}
      </div>
      {running && can(actor, 'operate') ? (
        <div>
          <Button danger loading={cancel.isPending} onClick={() => cancel.mutate()}>
            {t('cancel')}
          </Button>
        </div>
      ) : null}
      {cancel.isError ? <ActionError error={cancel.error} scope="cancel" /> : null}

      <section aria-label={t('steps.title')}>
        <Typography.Title level={3} className="text-lg">
          {t('steps.title')}
        </Typography.Title>
        {steps.isError ? (
          <ErrorAlert error={steps.error} />
        ) : (
          <StepsTimeline steps={steps.data ?? []} now={now} />
        )}
      </section>

      <section aria-label={t('log.title')}>
        <Typography.Title level={3} className="text-lg">
          {t('log.title')}
        </Typography.Title>
        {log.isError ? (
          <ErrorAlert error={log.error} />
        ) : (
          <LogViewer
            lines={log.data?.rows ?? []}
            stepNames={stepNames}
            truncated={log.data?.dropped ?? false}
          />
        )}
      </section>

      <section aria-label={t('mutations.title')}>
        <Typography.Title level={3} className="text-lg">
          {t('mutations.title')}
        </Typography.Title>
        <MutationsTable runId={id} />
      </section>
    </div>
  );
}
