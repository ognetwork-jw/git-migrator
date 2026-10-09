import { getTranslations } from 'next-intl/server';
import { EndpointMigrationView } from '../../../../../../src/endpoints/endpoint-migration-view.tsx';
import { authorizePage } from '../../../../../../src/server/authorize.ts';
import { PageHeading } from '../../../../../../src/ui/page-heading.tsx';

/** UI-026. Gated on the server (ADR-0321); the Route's id is data, never a path to a file. */
export const dynamic = 'force-dynamic';

export default async function EndpointMigrationPage({
  params,
}: {
  readonly params: Promise<{ readonly routeId: string }>;
}) {
  const { routeId } = await params;
  await authorizePage('/endpoints');
  const t = await getTranslations('endpoints');
  return (
    <>
      <PageHeading>{t('migrationTitle')}</PageHeading>
      <EndpointMigrationView routeId={routeId} />
    </>
  );
}
