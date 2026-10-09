import { getTranslations } from 'next-intl/server';
import { BatchView } from '../../../../../src/invitations/batch-view.tsx';
import { authorizePage } from '../../../../../src/server/authorize.ts';
import { PageHeading } from '../../../../../src/ui/page-heading.tsx';

/** UI-029: one Invitation Batch. Gated like the list (the path is under `/people/invitations`). */
export const dynamic = 'force-dynamic';

export default async function InvitationBatchPage({
  params,
}: {
  readonly params: Promise<{ readonly batchId: string }>;
}) {
  const { batchId } = await params;
  await authorizePage(`/people/invitations/${encodeURIComponent(batchId)}`);
  const t = await getTranslations('invitations');
  return (
    <>
      <PageHeading>{t('batchTitle')}</PageHeading>
      <BatchView batchId={batchId} />
    </>
  );
}
