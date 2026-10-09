import { getTranslations } from 'next-intl/server';
import { MigrationDetailView } from '../../../../src/migration-detail/detail-view.tsx';
import { authorizePage } from '../../../../src/server/authorize.ts';
import { PageHeading } from '../../../../src/ui/page-heading.tsx';

/** UI-022. Gated on the server (ADR-0321); data comes only through the API. */
export const dynamic = 'force-dynamic';

export default async function RepositoryDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly migrationId: string }>;
}) {
  await authorizePage('/repositories');
  const { migrationId } = await params;
  const t = await getTranslations('migrationDetail');
  return (
    <>
      <PageHeading>{t('title')}</PageHeading>
      <MigrationDetailView id={migrationId} />
    </>
  );
}
