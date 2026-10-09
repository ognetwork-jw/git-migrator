'use client';

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { Alert, Button, Descriptions, Input, Modal, Select, Space, Table, Typography } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useLiveInvalidation } from '../live/index.ts';
import type { IdentityRef } from '../mapping/api.ts';
import { ErrorAlert } from '../mapping/shared.tsx';
import {
  approveBatch,
  batchKey,
  confirmInvitee,
  decideItem,
  fetchBatch,
  ITEM_STATUSES,
  type Item,
  invitationsKey,
} from './api.ts';
import { invitationTopics } from './invitations-view.tsx';
import { BatchStatusTag, ItemStatusTag, useSeatText, useWhen } from './shared.tsx';

const MAX_REASON = 500;

const personLabel = (who: IdentityRef): string => who.displayName ?? who.login ?? who.providerId;

/** UI-029: one batch with its seat preview, entries, approval and per-entry send status. */
export function BatchView({ batchId }: { readonly batchId: string }) {
  const t = useTranslations('invitations');
  const when = useWhen();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [deselecting, setDeselecting] = useState<Item>();
  // The count and token the operator is shown are frozen when the dialog opens.
  const [approving, setApproving] = useState<{ count: number; token: string }>();
  const [revoking, setRevoking] = useState<Item>();
  useLiveInvalidation({
    topics: invitationTopics([`invitation:${batchId}`]),
    queryKeysFor: () => [invitationsKey],
  });

  const query = useInfiniteQuery({
    queryKey: batchKey(batchId, status),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      fetchBatch(batchId, { status, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const batch = query.data?.pages[0]?.batch;
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: invitationsKey });

  const decide = useMutation({
    mutationFn: (v: {
      item: Item;
      action: 'select' | 'deselect' | 'revoke' | 'resolve';
      reason?: string;
      outcome?: 'invited' | 'not_invited';
    }) =>
      decideItem(batchId, v.item.id, v.action, {
        ...(v.reason ? { reason: v.reason } : {}),
        ...(v.outcome ? { outcome: v.outcome } : {}),
      }),
    onSuccess: refresh,
  });
  const approve = useMutation({
    mutationFn: (v: { count: number; token: string }) => approveBatch(batchId, v.count, v.token),
    onSuccess: refresh,
  });
  const confirm = useMutation({
    mutationFn: (v: { item: Item; target: IdentityRef }) =>
      confirmInvitee(batch?.routeId as string, v.item.mappingId as string, v.target.id),
    onSuccess: refresh,
  });
  const seatText = useSeatText(
    batch?.seatPreview ?? {
      toInvite: 0,
      seatsTotal: null,
      seatsFilled: null,
      projectedFilled: null,
    },
  );

  if (query.isError && batch === undefined) return <ErrorAlert error={query.error} />;
  if (batch === undefined) return null;
  const isDraft = batch.status === 'draft';
  const finalCount = batch.counts.selected;

  return (
    <div className="flex flex-col gap-4">
      <Link href="/people/invitations">{t('back')}</Link>
      <Descriptions
        size="small"
        column={{ xs: 1, md: 2 }}
        items={[
          {
            key: 'status',
            label: t('column.status'),
            children: <BatchStatusTag status={batch.status} />,
          },
          { key: 'route', label: t('column.route'), children: batch.routeId },
          { key: 'seats', label: t('column.seats'), children: seatText },
          {
            key: 'created',
            label: t('column.createdBy'),
            children: `${batch.createdBy}, ${when(batch.createdAt)}`,
          },
          {
            key: 'approved',
            label: t('column.approved'),
            children:
              batch.approvedAt === null
                ? t('notApproved')
                : t('approvedBy', { when: when(batch.approvedAt), who: batch.approvedBy ?? '' }),
          },
          ...(batch.nextAttemptAt === null
            ? []
            : [{ key: 'next', label: t('nextAttempt'), children: when(batch.nextAttemptAt) }]),
        ]}
      />
      {batch.nextAttemptAt !== null ? (
        <Alert type="info" showIcon title={t('rateLimited')} />
      ) : null}
      {isDraft ? (
        <Alert type="info" showIcon title={t('draftHelp')} />
      ) : (
        <Alert type="info" showIcon title={t('approvedHelp')} />
      )}

      {batch.counts.unknown > 0 ? <Alert type="warning" showIcon title={t('unknownHelp')} /> : null}
      <Space wrap>
        <Select
          aria-label={t('filter.itemStatus')}
          className="min-w-44"
          value={status}
          onChange={setStatus}
          options={[
            { value: '', label: t('filter.allStatuses') },
            ...ITEM_STATUSES.map((s) => ({ value: s, label: t(`itemStatus.${s}`) })),
          ]}
        />
        {isDraft ? (
          <Button
            type="primary"
            disabled={finalCount === 0}
            onClick={() => setApproving({ count: finalCount, token: batch.selectionToken })}
          >
            {t('approve.open')}
          </Button>
        ) : null}
      </Space>

      {query.isError ? <ErrorAlert error={query.error} /> : null}
      {decide.isError ? <ErrorAlert error={decide.error} /> : null}
      {approve.isError ? <ErrorAlert error={approve.error} /> : null}
      {confirm.isError ? <ErrorAlert error={confirm.error} /> : null}

      <Table<Item>
        rowKey="id"
        size="middle"
        loading={query.isLoading || query.isFetching}
        dataSource={rows}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('noEntries') }}
        columns={[
          {
            title: t('column.person'),
            key: 'person',
            render: (_: unknown, i) => (
              <div>
                <div>{personLabel(i.source)}</div>
                <Typography.Text type="secondary" className="text-xs">
                  {i.email}
                </Typography.Text>
              </div>
            ),
          },
          {
            title: t('column.teams'),
            key: 'teams',
            render: (_: unknown, i) => i.teamSlugs.join(', '),
          },
          {
            title: t('column.sendStatus'),
            key: 'status',
            render: (_: unknown, i) => (
              <div>
                <ItemStatusTag status={i.status} />
                {i.status === 'deselected' && i.deselectReason ? (
                  <div className="text-xs">
                    <Typography.Text type="secondary">
                      {t('reasonLabel', { reason: i.deselectReason })}
                    </Typography.Text>
                  </div>
                ) : null}
                {i.error ? (
                  <div className="text-xs">
                    <Typography.Text type="secondary">
                      {t('errorLabel', { error: i.error })}
                    </Typography.Text>
                  </div>
                ) : null}
                {i.sentAt ? (
                  <div className="text-xs">
                    <Typography.Text type="secondary">
                      {t('sentAt', { when: when(i.sentAt) })}
                    </Typography.Text>
                  </div>
                ) : null}
              </div>
            ),
          },
          {
            title: t('column.maybeInvitee'),
            key: 'suggestions',
            render: (_: unknown, i) =>
              i.status === 'sent' && i.mappingId !== null
                ? i.suggestions.map((s) => (
                    <div key={s.id}>
                      <Button
                        size="small"
                        loading={confirm.isPending}
                        onClick={() => confirm.mutate({ item: i, target: s })}
                      >
                        {t('suggestion.confirm', { name: personLabel(s) })}
                      </Button>
                    </div>
                  ))
                : null,
          },
          {
            title: t('column.actions'),
            key: 'actions',
            render: (_: unknown, i) => (
              <Space wrap size="small">
                {isDraft && i.status === 'selected' ? (
                  <Button size="small" onClick={() => setDeselecting(i)}>
                    {t('action.deselect')}
                  </Button>
                ) : null}
                {isDraft && i.status === 'deselected' ? (
                  <Button size="small" onClick={() => decide.mutate({ item: i, action: 'select' })}>
                    {t('action.select')}
                  </Button>
                ) : null}
                {i.status === 'unknown' ? (
                  <>
                    <Button
                      size="small"
                      onClick={() =>
                        decide.mutate({ item: i, action: 'resolve', outcome: 'invited' })
                      }
                    >
                      {t('action.wasInvited')}
                    </Button>
                    <Button
                      size="small"
                      onClick={() =>
                        decide.mutate({ item: i, action: 'resolve', outcome: 'not_invited' })
                      }
                    >
                      {t('action.wasNotInvited')}
                    </Button>
                  </>
                ) : null}
                {i.status === 'sent' ? (
                  <Button size="small" danger onClick={() => setRevoking(i)}>
                    {t('action.revoke')}
                  </Button>
                ) : null}
              </Space>
            ),
          },
        ]}
      />
      {query.hasNextPage ? (
        <Button onClick={() => void query.fetchNextPage()} loading={query.isFetchingNextPage}>
          {t('loadMore')}
        </Button>
      ) : null}

      <ReasonModal
        item={deselecting}
        onCancel={() => setDeselecting(undefined)}
        onSubmit={(reason) => {
          if (deselecting) decide.mutate({ item: deselecting, action: 'deselect', reason });
          setDeselecting(undefined);
        }}
      />
      <Modal
        open={approving !== undefined}
        title={t('approve.title')}
        okText={t('approve.submit', { count: approving?.count ?? 0 })}
        cancelText={t('approve.cancel')}
        okButtonProps={{ disabled: (approving?.count ?? 0) === 0 }}
        onCancel={() => setApproving(undefined)}
        onOk={() => {
          if (approving) approve.mutate(approving);
          setApproving(undefined);
        }}
        destroyOnHidden
      >
        <Typography.Paragraph>
          {t('approve.body', { count: approving?.count ?? 0 })}
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary">{seatText}</Typography.Paragraph>
      </Modal>
      <Modal
        open={revoking !== undefined}
        title={t('revoke.title')}
        okText={t('revoke.submit')}
        cancelText={t('revoke.cancel')}
        okButtonProps={{ danger: true }}
        onCancel={() => setRevoking(undefined)}
        onOk={() => {
          if (revoking) decide.mutate({ item: revoking, action: 'revoke' });
          setRevoking(undefined);
        }}
        destroyOnHidden
      >
        <Typography.Paragraph>
          {t('revoke.body', { name: revoking ? personLabel(revoking.source) : '' })}
        </Typography.Paragraph>
        {revoking && !revoking.providerIdKnown ? (
          <Typography.Paragraph type="warning">{t('revoke.unlocated')}</Typography.Paragraph>
        ) : null}
      </Modal>
    </div>
  );
}

/** Deselecting needs a reason (AUTH-060 step 3). */
function ReasonModal({
  item,
  onCancel,
  onSubmit,
}: {
  readonly item: Item | undefined;
  readonly onCancel: () => void;
  readonly onSubmit: (reason: string) => void;
}) {
  const t = useTranslations('invitations.deselect');
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  return (
    <Modal
      open={item !== undefined}
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
        {t('body', { name: item ? personLabel(item.source) : '' })}
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
