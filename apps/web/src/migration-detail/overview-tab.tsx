'use client';

import { joinSecretParams, type ParamValues } from '@git-migrator/guidance';
import { Tag, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { GuidanceView } from '../guidance/guidance-view.tsx';
import type { MigrationDetail, PlanItemRow } from './api.ts';
import { FINDING_ORDER, type FindingKind, targetFullName } from './rules.ts';

const KIND_COLOR: Record<FindingKind, string> = {
  blocker: 'error',
  pre_task: 'warning',
  post_task: 'gold',
  warning: 'default',
};

/** One finding of the Overview: from the Analysis, or a run-origin blocker (LIF-049). */
export interface Finding {
  readonly key: string;
  readonly kind: FindingKind;
  readonly code: string;
  readonly params: unknown;
  readonly facetKey?: string;
  readonly fieldPaths?: readonly string[];
  readonly runOrigin: boolean;
}

/** A run-origin blocker list as stored (`[{code, params, at}]`); anything malformed is skipped. */
export function runBlockersOf(value: unknown): { code: string; params: unknown }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const e = entry as { code?: unknown; params?: unknown } | null;
    return typeof e?.code === 'string' ? [{ code: e.code, params: e.params }] : [];
  });
}

/**
 * The findings grouped by kind in severity order (UI-022). Run-origin blockers come first in the
 * blocker group. Plain plan steps are not findings.
 */
export function groupFindings(
  items: readonly PlanItemRow[],
  runBlockers: readonly { code: string; params: unknown }[],
): { kind: FindingKind; findings: Finding[] }[] {
  const findings: Finding[] = [
    ...runBlockers.map(
      (b, index): Finding => ({
        key: `run-${index}-${b.code}`,
        kind: 'blocker',
        code: b.code,
        params: b.params,
        runOrigin: true,
      }),
    ),
    ...items.flatMap((item): Finding[] =>
      item.kind === 'step'
        ? []
        : [
            {
              key: item.id,
              kind: item.kind,
              code: item.code,
              params: joinSecretParams(item.params, item.secretParams),
              facetKey: item.facetKey,
              fieldPaths: item.fieldPaths,
              runOrigin: false,
            },
          ],
    ),
  ];
  return FINDING_ORDER.map((kind) => ({
    kind,
    findings: findings.filter((f) => f.kind === kind),
  })).filter((group) => group.findings.length > 0);
}

/**
 * The Overview tab (UI-022): the findings of the latest Analysis grouped as blockers, pre tasks,
 * post tasks and warnings, each with its guidance (UI-040).
 */
export function OverviewTab({ migration }: { readonly migration: MigrationDetail }) {
  const t = useTranslations('migrationDetail.overview');
  const tKind = useTranslations('migrationDetail.findingKind');
  const target = targetFullName(migration);
  const defaults = useMemo<ParamValues>(() => (target ? { repository: target } : {}), [target]);
  const groups = groupFindings(
    migration.latestAnalysis?.items ?? [],
    runBlockersOf(migration.runBlockers),
  );

  if (migration.latestAnalysis === null && groups.length === 0) {
    return <Typography.Text type="secondary">{t('notAnalyzed')}</Typography.Text>;
  }
  if (groups.length === 0) {
    return <Typography.Text type="secondary">{t('noFindings')}</Typography.Text>;
  }
  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <section key={group.kind} aria-label={tKind(group.kind)}>
          <Typography.Title level={3} className="text-lg">
            <Tag color={KIND_COLOR[group.kind]}>{tKind(group.kind)}</Tag>
            {t('count', { count: group.findings.length })}
          </Typography.Title>
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {group.findings.map((finding) => (
              <li key={finding.key} className="rounded border p-3">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  {finding.facetKey ? <Tag>{finding.facetKey}</Tag> : null}
                  {finding.runOrigin ? <Tag>{t('runOrigin')}</Tag> : null}
                  <code className="font-mono text-xs">{finding.code}</code>
                </div>
                <GuidanceView
                  code={finding.code}
                  params={finding.params}
                  fieldPaths={finding.fieldPaths}
                  defaults={defaults}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
