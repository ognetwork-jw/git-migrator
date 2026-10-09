import { getTranslations } from 'next-intl/server';
import { ActorsView } from '../../../../src/admin/actors-view.tsx';
import { authorizePage } from '../../../../src/server/authorize.ts';
import { PageHeading } from '../../../../src/ui/page-heading.tsx';

/** UI-034. Gated on the server (ADR-0321); data comes only through the RPC mount and `/api/v1`. */
export const dynamic = 'force-dynamic';

export default async function ActorsPage() {
  await authorizePage('/admin/actors');
  const nav = await getTranslations('nav.item');
  return (
    <>
      <PageHeading>{nav('actors')}</PageHeading>
      <ActorsView />
    </>
  );
}
