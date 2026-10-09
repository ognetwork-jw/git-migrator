import { getTranslations } from 'next-intl/server';
import { authorizePage } from '../../../../src/server/authorize.ts';
import { PageHeading } from '../../../../src/ui/page-heading.tsx';
import { WaveDetailView } from '../../../../src/waves/wave-detail-view.tsx';

/** UI-024. Gated on the server (ADR-0321); data comes only through the API. */
export const dynamic = 'force-dynamic';

export default async function WavePage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  await authorizePage('/waves');
  const { id } = await params;
  const t = await getTranslations('waves');
  return (
    <>
      <PageHeading>{t('title')}</PageHeading>
      <WaveDetailView id={id} />
    </>
  );
}
