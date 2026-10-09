import { getTranslations } from 'next-intl/server';
import { RunDetailView } from '../../../../src/run-detail/run-detail-view.tsx';
import { authorizePage } from '../../../../src/server/authorize.ts';
import { PageHeading } from '../../../../src/ui/page-heading.tsx';

/** UI-023. Gated on the server (ADR-0321); data comes only through the API. */
export const dynamic = 'force-dynamic';

export default async function RunPage({
  params,
}: {
  readonly params: Promise<{ readonly runId: string }>;
}) {
  await authorizePage('/runs');
  const { runId } = await params;
  const t = await getTranslations('runDetail');
  return (
    <>
      <PageHeading>{t('title')}</PageHeading>
      <RunDetailView id={runId} />
    </>
  );
}
