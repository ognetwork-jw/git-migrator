import { getTranslations } from 'next-intl/server';
import { EndpointsView } from '../../../src/endpoints/endpoints-view.tsx';
import { authorizePage } from '../../../src/server/authorize.ts';
import { PageHeading } from '../../../src/ui/page-heading.tsx';

/** UI-025. Gated on the server (ADR-0321); data comes only through the API. */
export const dynamic = 'force-dynamic';

export default async function EndpointsPage() {
  await authorizePage('/endpoints');
  const t = await getTranslations('endpoints');
  return (
    <>
      <PageHeading>{t('title')}</PageHeading>
      <EndpointsView />
    </>
  );
}
