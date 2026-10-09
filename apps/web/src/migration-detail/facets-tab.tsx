'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Collapse, Table, Tag, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { formatDateTime } from '../format.ts';
import { ErrorAlert } from '../mapping/shared.tsx';
import { ActionError } from './action-error.tsx';
import {
  createExpectedDifference,
  type DiffFacet,
  detailRootKey,
  diffKey,
  fetchDiff,
  type ParityDiff,
  revokeExpectedDifference,
} from './api.ts';
import { NoteDialog } from './dialogs.tsx';
import { decisionsOf, scalarText } from './json-diff.ts';
import { JsonTree } from './json-tree.tsx';

/** Longest note an accepted difference takes (the server bounds it too). */
const MAX_NOTE = 500;
/** Reasons the server refuses to revoke by hand (ADR-0415): the system owns those records. */
const SYSTEM_OWNED = ['identity_excluded', 'framework_mutation'];

const FIDELITY_COLOR: Record<string, string | undefined> = {
  exact: 'success',
  lossy: 'warning',
  unsupported: 'error',
  unreadable: 'default',
};

const PARITY_COLOR: Record<string, string | undefined> = {
  equal: 'success',
  different: 'error',
  unverifiable: 'default',
};

const shown = (value: unknown): string => {
  const text = scalarText(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};

function FacetPanel({
  migrationId,
  facet,
  operator,
}: {
  readonly migrationId: string;
  readonly facet: DiffFacet;
  readonly operator: boolean;
}) {
  const t = useTranslations('migrationDetail.facets');
  const tFidelity = useTranslations('migrationDetail.facets.fidelity');
  const tReason = useTranslations('migrationDetail.facets.reason');
  const queryClient = useQueryClient();
  const [accepting, setAccepting] = useState<ParityDiff | undefined>(undefined);
  const refresh = () => queryClient.invalidateQueries({ queryKey: detailRootKey(migrationId) });
  const accept = useMutation({
    mutationFn: (input: { path: string; note: string }) =>
      createExpectedDifference(migrationId, { facetKey: facet.facetKey, ...input }),
    onSuccess: () => {
      setAccepting(undefined);
      return refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeExpectedDifference(id),
    onSuccess: refresh,
  });
  const decisions = decisionsOf(facet.decisions);
  const parity = facet.parity;
  const excluded = new Set(parity?.excluded.map((e) => e.path));

  return (
    <div className="flex flex-col gap-4">
      {facet.sourceUnreadable.length + facet.targetUnreadable.length > 0 ? (
        <Typography.Text type="secondary">
          {t('unreadable', {
            fields: [...facet.sourceUnreadable, ...facet.targetUnreadable].join(', '),
          })}
        </Typography.Text>
      ) : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {(
          [
            ['source', facet.source, facet.desired, facet.sourceFetchedAt],
            ['desired', facet.desired, facet.target, null],
            ['target', facet.target, facet.desired, facet.targetFetchedAt],
          ] as const
        ).map(([side, value, other, fetchedAt]) => (
          <section key={side} aria-label={t(`side.${side}`)} className="min-w-0">
            <Typography.Title level={4} className="text-base">
              {t(`side.${side}`)}
            </Typography.Title>
            {fetchedAt ? (
              <Typography.Text type="secondary" className="text-xs">
                {t('fetched', { when: formatDateTime(fetchedAt) })}
              </Typography.Text>
            ) : null}
            <JsonTree value={value} compareTo={other} label={t(`side.${side}`)} />
          </section>
        ))}
      </div>

      <section aria-label={t('fidelityTitle')}>
        <Typography.Title level={4} className="text-base">
          {t('fidelityTitle')}
        </Typography.Title>
        {decisions.length === 0 ? (
          <Typography.Text type="secondary">{t('noDecisions')}</Typography.Text>
        ) : (
          <Table
            size="small"
            pagination={false}
            rowKey="path"
            dataSource={decisions}
            columns={[
              {
                title: t('column.path'),
                dataIndex: 'path',
                render: (v: string) => <code className="font-mono text-xs">{v}</code>,
              },
              {
                title: t('column.fidelity'),
                dataIndex: 'fidelity',
                render: (v: string) => (
                  <Tag color={FIDELITY_COLOR[v]}>{tFidelity.has(v) ? tFidelity(v) : v}</Tag>
                ),
              },
              {
                title: t('column.accepted'),
                dataIndex: 'accepted',
                render: (v: 'policy' | 'migration' | false) =>
                  v === false ? t('accepted.no') : t(`accepted.${v}`),
              },
              { title: t('column.policy'), dataIndex: 'policyKey' },
            ]}
          />
        )}
      </section>

      <section aria-label={t('parityTitle')}>
        <Typography.Title level={4} className="text-base">
          {t('parityTitle')}
        </Typography.Title>
        {parity === null ? (
          <Typography.Text type="secondary">{t('noParity')}</Typography.Text>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Tag color={PARITY_COLOR[parity.status]}>
                {t.has(`parity.${parity.status}`) ? t(`parity.${parity.status}`) : parity.status}
              </Tag>
              <Typography.Text type="secondary">
                {t('checked', { when: formatDateTime(parity.checkedAt) })}
              </Typography.Text>
            </div>
            {parity.diffs.length > 0 ? (
              <Table
                size="small"
                pagination={false}
                rowKey="path"
                dataSource={[...parity.diffs]}
                columns={[
                  {
                    title: t('column.path'),
                    dataIndex: 'path',
                    render: (v: string) => <code className="font-mono text-xs">{v}</code>,
                  },
                  {
                    title: t('side.desired'),
                    dataIndex: 'source',
                    render: (v: unknown) => <code className="font-mono text-xs">{shown(v)}</code>,
                  },
                  {
                    title: t('side.target'),
                    dataIndex: 'target',
                    render: (v: unknown) => <code className="font-mono text-xs">{shown(v)}</code>,
                  },
                  ...(operator
                    ? [
                        {
                          title: t('column.actions'),
                          key: 'actions',
                          render: (_: unknown, row: ParityDiff) =>
                            excluded.has(row.path) ? null : (
                              <Button size="small" onClick={() => setAccepting(row)}>
                                {t('accept.button')}
                              </Button>
                            ),
                        },
                      ]
                    : []),
                ]}
              />
            ) : (
              <Typography.Text type="secondary">{t('noDiffs')}</Typography.Text>
            )}
          </div>
        )}
      </section>

      <section aria-label={t('expectedTitle')}>
        <Typography.Title level={4} className="text-base">
          {t('expectedTitle')}
        </Typography.Title>
        {facet.expectedDifferences.length === 0 ? (
          <Typography.Text type="secondary">{t('noExpected')}</Typography.Text>
        ) : (
          <Table
            size="small"
            pagination={false}
            rowKey="id"
            dataSource={[...facet.expectedDifferences]}
            columns={[
              {
                title: t('column.path'),
                dataIndex: 'path',
                render: (v: string) => <code className="font-mono text-xs">{v}</code>,
              },
              {
                title: t('column.reason'),
                dataIndex: 'reason',
                render: (v: string) => <Tag>{tReason.has(v) ? tReason(v) : v}</Tag>,
              },
              {
                title: t('column.scope'),
                dataIndex: 'migrationId',
                render: (v: string | null) =>
                  v === null ? t('scope.route') : t('scope.migration'),
              },
              { title: t('column.note'), dataIndex: 'note' },
              ...(operator
                ? [
                    {
                      title: t('column.actions'),
                      key: 'actions',
                      render: (_: unknown, row: DiffFacet['expectedDifferences'][number]) =>
                        SYSTEM_OWNED.includes(row.reason) ? (
                          <Typography.Text type="secondary">{t('revoke.system')}</Typography.Text>
                        ) : (
                          <Button
                            size="small"
                            danger
                            loading={revoke.isPending && revoke.variables === row.id}
                            disabled={revoke.isPending}
                            aria-label={t('revoke.label', { path: row.path })}
                            onClick={() => revoke.mutate(row.id)}
                          >
                            {t('revoke.button')}
                          </Button>
                        ),
                    },
                  ]
                : []),
            ]}
          />
        )}
        {revoke.isError ? (
          <div className="mt-2">
            <ActionError error={revoke.error} scope="difference" />
          </div>
        ) : null}
      </section>

      <NoteDialog
        open={accepting !== undefined}
        texts={{
          title: t('accept.title'),
          ok: t('accept.ok'),
          body: accepting ? t('accept.body', { path: accepting.path }) : undefined,
        }}
        label={t('accept.note')}
        required
        maxLength={MAX_NOTE}
        loading={accept.isPending}
        error={accept.error}
        errorScope="difference"
        onCancel={() => {
          setAccepting(undefined);
          accept.reset();
        }}
        onSubmit={(note) => accepting && accept.mutate({ path: accepting.path, note })}
      />
    </div>
  );
}

/**
 * The Facets tab (UI-022): per Facet the source, desired and target documents side by side as JSON
 * trees, the field fidelity markers, the latest parity result with the option to accept a
 * difference, and the Expected Differences with revoke buttons. `selected` opens a Facet (the strip
 * above the tabs jumps here).
 */
export function FacetsTab({
  migrationId,
  operator,
  selected,
  onSelect,
}: {
  readonly migrationId: string;
  readonly operator: boolean;
  readonly selected: string | undefined;
  readonly onSelect: (facetKey: string | undefined) => void;
}) {
  const t = useTranslations('migrationDetail.facets');
  const diff = useQuery({ queryKey: diffKey(migrationId), queryFn: () => fetchDiff(migrationId) });
  if (diff.isError) return <ErrorAlert error={diff.error} />;
  if (diff.isLoading) return <Typography.Text type="secondary">{t('loading')}</Typography.Text>;
  const facets = diff.data?.facets ?? [];
  if (facets.length === 0) {
    return <Typography.Text type="secondary">{t('empty')}</Typography.Text>;
  }
  return (
    <Collapse
      accordion
      activeKey={selected}
      onChange={(key) => onSelect(Array.isArray(key) ? key[0] : key)}
      items={facets.map((facet) => ({
        key: facet.facetKey,
        label: (
          <span id={`facet-${facet.facetKey}`}>
            {facet.facetKey}
            {facet.parity ? (
              <Tag className="ms-2" color={PARITY_COLOR[facet.parity.status]}>
                {t.has(`parity.${facet.parity.status}`)
                  ? t(`parity.${facet.parity.status}`)
                  : facet.parity.status}
              </Tag>
            ) : null}
          </span>
        ),
        children: <FacetPanel migrationId={migrationId} facet={facet} operator={operator} />,
      }))}
    />
  );
}
