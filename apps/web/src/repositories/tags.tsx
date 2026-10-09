'use client';

import { Tag } from 'antd';
import { useTranslations } from 'next-intl';

const STATUS_COLOR: Record<string, string | undefined> = {
  discovered: 'default',
  analyzed: 'blue',
  running: 'processing',
  migrated: 'success',
  verified: 'success',
  manually_completed: 'success',
  failed: 'error',
  partial: 'warning',
  drifted: 'warning',
  rolled_back: 'default',
  source_missing: 'error',
};

const READINESS_COLOR: Record<string, string | undefined> = {
  ready: 'success',
  needs_attention: 'warning',
  blocked: 'error',
  unanalyzed: 'default',
};

/** A Migration status as a tag. The text carries the meaning, the color only reinforces it (UI-001). */
export function MigrationStatusTag({ status }: { readonly status: string }) {
  const t = useTranslations('migrationStatus');
  return <Tag color={STATUS_COLOR[status]}>{t.has(status) ? t(status) : status}</Tag>;
}

/** Readiness as a tag; `null` (never analyzed) reads as "Not analyzed". */
export function ReadinessTag({ readiness }: { readonly readiness: string | null }) {
  const t = useTranslations('readiness');
  const key = readiness ?? 'unanalyzed';
  return <Tag color={READINESS_COLOR[key]}>{t.has(key) ? t(key) : key}</Tag>;
}
