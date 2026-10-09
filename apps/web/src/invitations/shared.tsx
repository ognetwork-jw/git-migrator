'use client';

import { Tag } from 'antd';
import { useTranslations } from 'next-intl';
import { formatDateTime } from '../format.ts';
import type { Batch, BatchStatus, ItemStatus } from './api.ts';

const BATCH_COLOR: Record<BatchStatus, string | undefined> = {
  draft: 'default',
  approved: 'processing',
  sending: 'processing',
  sent: 'success',
  partial: 'warning',
};

const ITEM_COLOR: Record<ItemStatus, string | undefined> = {
  selected: 'processing',
  deselected: 'default',
  sent: 'warning',
  accepted: 'success',
  failed: 'error',
  expired: 'error',
  unknown: 'warning',
};

/** Statuses as colored tags; the text always says it too. */
export function BatchStatusTag({ status }: { readonly status: BatchStatus }) {
  const t = useTranslations('invitations.batchStatus');
  return <Tag color={BATCH_COLOR[status]}>{t(status)}</Tag>;
}

export function ItemStatusTag({ status }: { readonly status: ItemStatus }) {
  const t = useTranslations('invitations.itemStatus');
  return <Tag color={ITEM_COLOR[status]}>{t(status)}</Tag>;
}

/** The seat preview of AUTH-060 step 2: seats where known, "unknown" otherwise. */
export function useSeatText(preview: Batch['seatPreview']): string {
  const t = useTranslations('invitations.seats');
  if (preview.seatsTotal === null && preview.seatsFilled === null) {
    return t('unknown', { toInvite: preview.toInvite });
  }
  return t('known', {
    toInvite: preview.toInvite,
    filled: preview.seatsFilled ?? 0,
    projected: preview.projectedFilled ?? preview.toInvite,
    // 0 is how the provider reports "no seat limit".
    limited: preview.seatsTotal === null || preview.seatsTotal === 0 ? 'no' : 'yes',
    total: preview.seatsTotal ?? 0,
  });
}

export function useWhen() {
  return (value: string | null) => (value === null ? '' : formatDateTime(value));
}
