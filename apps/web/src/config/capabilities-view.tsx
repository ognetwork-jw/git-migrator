'use client';

import { useQuery } from '@tanstack/react-query';
import { Select, Space, Table, Tag, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { ErrorAlert } from '../mapping/shared.tsx';
import {
  type CapabilityMatrix,
  type Fidelity,
  fetchCapabilityMatrix,
  fetchRouteConfigs,
  type MatrixCell,
  type MatrixField,
  matrixKey,
  routeConfigKey,
} from './api.ts';

export type Pair = { readonly source: string; readonly target: string };

type MatrixRow = CapabilityMatrix['rows'][number];

/** One field that is not exact for the chosen pair, with the Facet it belongs to. */
interface FieldRow extends MatrixField {
  readonly id: string;
  readonly facet: string;
}

const FIDELITY_COLOR: Record<Fidelity, string> = {
  exact: 'success',
  translated: 'processing',
  lossy: 'warning',
  unreadable: 'warning',
  unsupported: 'error',
};

/** The ordered source → target pairs the matrix covers, in the order the server lists them. */
export function pairsOf(matrix: CapabilityMatrix): Pair[] {
  const seen = new Map<string, Pair>();
  for (const row of matrix.rows) {
    for (const cell of row.cells) {
      const key = `${cell.source}\u0000${cell.target}`;
      if (!seen.has(key)) seen.set(key, { source: cell.source, target: cell.target });
    }
  }
  return [...seen.values()];
}

export const cellFor = (cells: readonly MatrixCell[], pair: Pair): MatrixCell | undefined =>
  cells.find((c) => c.source === pair.source && c.target === pair.target);

/**
 * UI-033: Facet rows and, per ordered pair of adapters, the fidelity of the Facet. Below it, the
 * fields that are not exact for a chosen pair, and the Route policies that accept lossy fields.
 */
export function CapabilityMatrixView() {
  const t = useTranslations('config.capabilities');
  const matrix = useQuery({ queryKey: matrixKey, queryFn: fetchCapabilityMatrix });
  const routes = useQuery({ queryKey: routeConfigKey, queryFn: fetchRouteConfigs });
  const [pairKey, setPairKey] = useState<string>();

  const pairs = useMemo(() => (matrix.data ? pairsOf(matrix.data) : []), [matrix.data]);
  // The first Route's pair is the default: it is the one an operator most likely came to check.
  const firstRoute = routes.data?.[0];
  const routePair = firstRoute
    ? {
        source: firstRoute.sourceEndpoint.providerType,
        target: firstRoute.targetEndpoint.providerType,
      }
    : undefined;
  const pair =
    pairs.find((p) => `${p.source}→${p.target}` === pairKey) ??
    (routePair
      ? pairs.find((p) => p.source === routePair.source && p.target === routePair.target)
      : undefined) ??
    pairs[0];
  const pairLabel = (p: Pair) => t('pair', { source: p.source, target: p.target });

  if (matrix.isError) return <ErrorAlert error={matrix.error} />;

  return (
    <div className="flex flex-col gap-6">
      <Typography.Paragraph type="secondary">{t('help')}</Typography.Paragraph>

      <Table<MatrixRow>
        rowKey="facet"
        size="middle"
        loading={matrix.isLoading}
        dataSource={matrix.data?.rows.map((r) => ({ ...r })) ?? []}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('empty') }}
        columns={[
          {
            title: t('column.facet'),
            key: 'facet',
            fixed: 'left',
            render: (_: unknown, row) => (
              <Space direction="vertical" size={0}>
                <Typography.Text code>{row.facet}</Typography.Text>
                <Typography.Text type="secondary" className="text-xs">
                  {t(`scope.${row.scope}`)}
                  {row.inScope ? '' : ` · ${t('notInScope')}`}
                </Typography.Text>
              </Space>
            ),
          },
          ...pairs.map((p) => ({
            title: pairLabel(p),
            key: `${p.source}→${p.target}`,
            render: (_: unknown, row: MatrixRow) => {
              const cell = cellFor(row.cells, p);
              if (!cell) return '';
              return (
                <Space direction="vertical" size={2}>
                  <Tag color={FIDELITY_COLOR[cell.fidelity as Fidelity]}>
                    {t.has(`fidelity.${cell.fidelity}`)
                      ? t(`fidelity.${cell.fidelity}`)
                      : cell.fidelity}
                  </Tag>
                  <Typography.Text type="secondary" className="text-xs">
                    {t('readWrite', {
                      read: cell.read ? t('yes') : t('no'),
                      write: cell.write ? t('yes') : t('no'),
                    })}
                  </Typography.Text>
                </Space>
              );
            },
          })),
        ]}
      />

      {pair ? (
        <section aria-labelledby="capability-fields" className="flex flex-col gap-3">
          <Space wrap>
            <Typography.Title id="capability-fields" level={2} className="!m-0 !text-lg">
              {t('fields.title')}
            </Typography.Title>
            <Select<string>
              aria-label={t('fields.pair')}
              className="min-w-72"
              value={`${pair.source}→${pair.target}`}
              onChange={setPairKey}
              options={pairs.map((p) => ({
                value: `${p.source}→${p.target}`,
                label: pairLabel(p),
              }))}
            />
          </Space>
          <Table<FieldRow>
            rowKey="id"
            size="small"
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: t('fields.empty') }}
            dataSource={(matrix.data?.rows ?? []).flatMap((row): FieldRow[] => {
              const cell = cellFor(row.cells, pair);
              return (cell?.fields ?? [])
                .filter((f) => f.fidelity !== 'exact')
                .map((f) => ({ ...f, id: `${row.facet}:${f.path}`, facet: row.facet }));
            })}
            columns={[
              { title: t('fields.column.facet'), key: 'facet', render: (_: unknown, f) => f.facet },
              { title: t('fields.column.path'), key: 'path', render: (_: unknown, f) => f.path },
              {
                title: t('fields.column.source'),
                key: 'source',
                render: (_: unknown, f) => f.source.kind,
              },
              {
                title: t('fields.column.target'),
                key: 'target',
                render: (_: unknown, f) => f.target.kind,
              },
              {
                title: t('fields.column.fidelity'),
                key: 'fidelity',
                render: (_: unknown, f) => (
                  <Tag color={FIDELITY_COLOR[f.fidelity]}>
                    {t.has(`fidelity.${f.fidelity}`) ? t(`fidelity.${f.fidelity}`) : f.fidelity}
                  </Tag>
                ),
              },
            ]}
          />
        </section>
      ) : null}

      <section aria-labelledby="capability-policies" className="flex flex-col gap-3">
        <Typography.Title id="capability-policies" level={2} className="!text-lg">
          {t('policies.title')}
        </Typography.Title>
        <Typography.Paragraph type="secondary">{t('policies.help')}</Typography.Paragraph>
        {routes.isError ? <ErrorAlert error={routes.error} /> : null}
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          loading={routes.isLoading}
          dataSource={routes.data ?? []}
          locale={{ emptyText: t('policies.empty') }}
          columns={[
            {
              title: t('policies.column.route'),
              key: 'route',
              render: (_: unknown, r) => <Typography.Text code>{r.id}</Typography.Text>,
            },
            {
              title: t('policies.column.pair'),
              key: 'pair',
              render: (_: unknown, r) => (
                <Space direction="vertical" size={0}>
                  <span>
                    {pairLabel({
                      source: r.sourceEndpoint.providerType,
                      target: r.targetEndpoint.providerType,
                    })}
                  </span>
                  <Typography.Text type="secondary" className="text-xs">
                    {t('policies.endpoints', {
                      source: r.sourceEndpointId,
                      target: r.targetEndpointId,
                    })}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: t('policies.column.acceptLossy'),
              key: 'acceptLossy',
              render: (_: unknown, r) => {
                const keys = r.policies.acceptLossy ?? [];
                return keys.length === 0 ? (
                  t('policies.none')
                ) : (
                  <Space wrap size={4}>
                    {keys.map((k) => (
                      <Tag key={k}>{k}</Tag>
                    ))}
                  </Space>
                );
              },
            },
          ]}
        />
      </section>
    </div>
  );
}
