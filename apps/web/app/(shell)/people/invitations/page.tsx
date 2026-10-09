import { getTranslations } from 'next-intl/server';
import { InvitationsView } from '../../../../src/invitations/invitations-view.tsx';
import { authorizePage } from '../../../../src/server/authorize.ts';
import { PageHeading } from '../../../../src/ui/page-heading.tsx';

/** UI-029. Gated on the server (ADR-0321); data comes only through `/api/v1`. */
export const dynamic = 'force-dynamic';

export default async function InvitationsPage() {
  await authorizePage('/people/invitations');
  const nav = await getTranslations('nav.item');
  return (
    <>
      <PageHeading>{nav('invitations')}</PageHeading>
      <InvitationsView />
    </>
  );
}
