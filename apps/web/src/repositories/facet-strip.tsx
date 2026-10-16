'use client';

import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  StopOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Tag } from 'antd';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import type { PlanItemKind, RepositoryRow } from './api.ts';

const SEVERITY: readonly PlanItemKind[] = ['blocker', 'pre_task', 'post_task', 'warning'];
const COLOR: Partial<Record<PlanItemKind, string>> = {
  blocker: 'error',
  pre_task: 'warning',
  post_task: 'gold',
  warning: 'default',
};

/**
 * A badge's icon by its worst finding, so the severity has a shape and not only a color (UI-001).
 * `clean`: no findings.
 */
export const FACET_ICON: Record<PlanItemKind | 'clean', ReactNode> = {
  blocker: <StopOutlined aria-hidden />,
  pre_task: <ExclamationCircleOutlined aria-hidden />,
  post_task: <ClockCircleOutlined aria-hidden />,
  warning: <WarningOutlined aria-hidden />,
  step: null,
  clean: <CheckCircleOutlined aria-hidden />,
};

export interface FacetBadge {
  readonly facetKey: string;
  /** `null`: the Facet is in the plan and has no findings. */
  readonly worst: PlanItemKind | null;
  readonly count: number;
  /** The first finding of the worst kind, when the items carry their codes (the hover reason). */
  readonly reason?: { readonly code: string; readonly params: unknown };
}

interface BadgeItem {
  readonly facetKey: string;
  readonly kind: PlanItemKind;
  readonly code?: string;
  readonly params?: unknown;
}

/** One badge per Facet in the plan, colored by its worst finding; plain steps are not findings (UI-021, UI-022). */
export function facetBadges(
  analysis: { readonly items: readonly BadgeItem[] } | null | undefined,
): FacetBadge[] {
  const byFacet = new Map<string, { worst: number; count: number; reason?: BadgeItem }>();
  for (const item of analysis?.items ?? []) {
    const rank = SEVERITY.indexOf(item.kind);
    const entry = byFacet.get(item.facetKey) ?? { worst: SEVERITY.length, count: 0 };
    if (rank >= 0) {
      if (rank < entry.worst) entry.reason = item;
      entry.worst = Math.min(entry.worst, rank);
      entry.count += 1;
    }
    byFacet.set(item.facetKey, entry);
  }
  return [...byFacet.entries()]
    .map(([facetKey, v]) => ({
      facetKey,
      worst: SEVERITY[v.worst] ?? null,
      count: v.count,
      ...(v.reason?.code === undefined
        ? {}
        : { reason: { code: v.reason.code, params: v.reason.params } }),
    }))
    .sort((a, b) => a.facetKey.localeCompare(b.facetKey));
}

/**
 * The Facet badge strip. Each badge says its worst finding in words and an icon; the color only
 * reinforces it (UI-001).
 */
export function FacetStrip({ analysis }: { readonly analysis: RepositoryRow['latestAnalysis'] }) {
  const t = useTranslations('repositories');
  const badges = facetBadges(analysis);
  if (badges.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
      {badges.map((b) => {
        const hint =
          b.worst === null
            ? t('facet.clean', { facet: b.facetKey })
            : t('facet.hint', { facet: b.facetKey, count: b.count, kind: t(`facet.${b.worst}`) });
        return (
          <li key={b.facetKey}>
            <Tag
              color={b.worst === null ? 'success' : COLOR[b.worst]}
              icon={FACET_ICON[b.worst ?? 'clean']}
              title={hint}
              aria-label={hint}
              className="me-0"
            >
              {b.facetKey}
            </Tag>
          </li>
        );
      })}
    </ul>
  );
}
