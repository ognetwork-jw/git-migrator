import { getTranslations } from 'next-intl/server';
import { authorizePage } from '../../../src/server/authorize.ts';
import { PageHeading } from '../../../src/ui/page-heading.tsx';
import { WavesView } from '../../../src/waves/waves-view.tsx';

/** UI-024. Gated on the server (ADR-0321); data comes only through the API. */
export const dynamic = 'force-dynamic';

export default async function WavesPage() {
  await authorizePage('/waves');
  const t = await getTranslations('waves');
  return (
    <>
      <PageHeading>{t('title')}</PageHeading>
      <WavesView />
    </>
  );
}
