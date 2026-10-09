import { getTranslations } from 'next-intl/server';
import { parseInitialFilters } from '../../../src/repositories/query.ts';
import { RepositoriesView } from '../../../src/repositories/repositories-view.tsx';
import { authorizePage } from '../../../src/server/authorize.ts';
import { PageHeading } from '../../../src/ui/page-heading.tsx';

/** UI-021. Gated on the server (ADR-0321); data comes only through the API. */
export const dynamic = 'force-dynamic';

export default async function RepositoriesPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await authorizePage('/repositories');
  const t = await getTranslations('repositories');
  const { routeId, filters } = parseInitialFilters(await searchParams);
  return (
    <>
      <PageHeading>{t('title')}</PageHeading>
      <RepositoriesView
        {...(routeId ? { initialRouteId: routeId } : {})}
        initialFilters={filters}
      />
    </>
  );
}
