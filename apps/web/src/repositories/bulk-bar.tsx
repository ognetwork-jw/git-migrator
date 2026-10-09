'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Popconfirm, Select, Space, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ErrorAlert } from '../mapping/shared.tsx';
import {
  BULK_MAX,
  type BulkAction,
  type BulkResult,
  bulkAction,
  fetchWaves,
  repositoriesKey,
  wavesKey,
} from './api.ts';
import type { RepositorySelection } from './selection.ts';

/**
 * UI-021, LIF-090: Analyze, Migrate ready, Assign to wave and Remove from wave over the rows
 * selected across pages. The server re-checks every id (role, Route, status, readiness), so what
 * the list shows only decides which ids are sent. Skipped items are listed with their reason.
 */
export function BulkBar({ selection }: { readonly selection: RepositorySelection }) {
  const t = useTranslations('repositories.bulk');
  const queryClient = useQueryClient();
  const [waveId, setWaveId] = useState<string | undefined>();
  const [result, setResult] = useState<BulkResult | undefined>();
  const waves = useQuery({ queryKey: wavesKey, queryFn: fetchWaves });

  const run = useMutation({
    mutationFn: (action: BulkAction) =>
      bulkAction({
        ids: selection.ids,
        action,
        ...(action === 'assign-to-wave' && waveId ? { waveId } : {}),
      }),
    onMutate: () => setResult(undefined),
    onSuccess: async (out) => {
      setResult(out);
      if (out.skipped.length === 0) selection.clear();
      await queryClient.invalidateQueries({ queryKey: repositoriesKey });
    },
  });

  const count = selection.count;
  const tooMany = count > BULK_MAX;
  const idle = count === 0 || tooMany || run.isPending;
  const pending = run.isPending ? run.variables : undefined;

  return (
    <div className="flex flex-col gap-2">
      <Space wrap role="group" aria-label={t('label')}>
        <Button
          disabled={idle}
          loading={pending === 'analyze'}
          onClick={() => run.mutate('analyze')}
        >
          {t('analyze')}
        </Button>
        <Popconfirm
          title={t('migrateConfirm')}
          okText={t('migrateConfirmOk')}
          cancelText={t('migrateConfirmCancel')}
          disabled={idle}
          onConfirm={() => run.mutate('migrate-ready')}
        >
          <Button disabled={idle} loading={pending === 'migrate-ready'}>
            {t('migrateReady')}
          </Button>
        </Popconfirm>
        <Select
          allowClear
          aria-label={t('assignSelect')}
          placeholder={t('assignPlaceholder')}
          className="min-w-44"
          value={waveId}
          onChange={(value?: string) => setWaveId(value)}
          options={(waves.data ?? []).map((w) => ({ value: w.id, label: w.name }))}
        />
        <Button
          disabled={idle || waveId === undefined}
          loading={pending === 'assign-to-wave'}
          onClick={() => run.mutate('assign-to-wave')}
        >
          {t('assign')}
        </Button>
        <Button
          disabled={idle}
          loading={pending === 'remove-from-wave'}
          onClick={() => run.mutate('remove-from-wave')}
        >
          {t('remove')}
        </Button>
      </Space>
      {tooMany ? (
        <Typography.Text type="warning">{t('tooMany', { max: BULK_MAX })}</Typography.Text>
      ) : null}
      {run.isPending ? (
        <Typography.Text type="secondary" aria-live="polite">
          {t('running', { count })}
        </Typography.Text>
      ) : null}
      {run.isError ? <ErrorAlert error={run.error} /> : null}
      {result ? (
        <BulkResultAlert
          result={result}
          selection={selection}
          onClose={() => setResult(undefined)}
        />
      ) : null}
    </div>
  );
}

function BulkResultAlert({
  result,
  selection,
  onClose,
}: {
  readonly result: BulkResult;
  readonly selection: RepositorySelection;
  readonly onClose: () => void;
}) {
  const t = useTranslations('repositories.bulk');
  const reasons = useTranslations('repositories.bulk.reason');
  return (
    <Alert
      showIcon
      closable={{ onClose, 'aria-label': t('dismiss') }}
      type={result.skipped.length === 0 ? 'success' : 'warning'}
      title={t('resultTitle')}
      description={
        <div role="status" className="flex flex-col gap-1">
          <span>{t('accepted', { count: result.accepted.length })}</span>
          {result.skipped.length > 0 ? (
            <>
              <span>{t('skipped', { count: result.skipped.length })}</span>
              <ul className="m-0 list-disc pl-5">
                {result.skipped.map((s) => (
                  <li key={s.id}>
                    {t('skippedItem', {
                      name: selection.items.get(s.id)?.path ?? s.id,
                      reason: reasons.has(s.reason as never)
                        ? reasons(s.reason as never)
                        : s.reason,
                    })}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      }
    />
  );
}
