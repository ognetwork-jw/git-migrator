'use client';

import { useQuery } from '@tanstack/react-query';
import { Alert, Select, Tag } from 'antd';
import { useTranslations } from 'next-intl';
import { ApiError } from '../api/http.ts';
import { fetchRoutes, type MappingStatus, routesKey } from './api.ts';

const STATUS_COLOR: Record<MappingStatus, string | undefined> = {
  confirmed: 'success',
  suggested: 'processing',
  excluded: 'default',
  pending_invite: 'warning',
  unmapped: 'error',
};

/** A mapping status as a colored tag; the color is never the only signal (the text says it). */
export function StatusTag({ status }: { readonly status: MappingStatus }) {
  const t = useTranslations('mapping.status');
  return <Tag color={STATUS_COLOR[status]}>{t(status)}</Tag>;
}

/** The message for a failed call: `problem.<code>` with the generic one as fallback. */
export function ErrorAlert({ error }: { readonly error: unknown }) {
  const problems = useTranslations('problem');
  const code = error instanceof ApiError ? error.code : 'internal_error';
  return (
    <Alert
      type="error"
      showIcon
      role="alert"
      title={problems.has(code) ? problems(code) : problems('internal_error')}
    />
  );
}

/** Picks the Route whose mappings are shown; the first Route is the default. */
export function useRouteChoice(selected: string | undefined) {
  const query = useQuery({ queryKey: routesKey, queryFn: fetchRoutes });
  const routes = query.data ?? [];
  const routeId = routes.find((r) => r.id === selected)?.id ?? routes[0]?.id;
  return { query, routes, routeId };
}

export function RouteSelect({
  routes,
  value,
  onChange,
}: {
  readonly routes: readonly { id: string }[];
  readonly value: string | undefined;
  readonly onChange: (id: string) => void;
}) {
  const t = useTranslations('mapping');
  return (
    <Select
      aria-label={t('route')}
      className="min-w-48"
      value={value}
      onChange={onChange}
      options={routes.map((r) => ({ value: r.id, label: r.id }))}
    />
  );
}
