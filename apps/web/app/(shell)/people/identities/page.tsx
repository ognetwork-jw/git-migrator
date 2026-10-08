import { getTranslations } from 'next-intl/server';
import { IdentityMappingView } from '../../../../src/mapping/identity-mapping-view.tsx';
import { authorizePage } from '../../../../src/server/authorize.ts';
import { PageHeading } from '../../../../src/ui/page-heading.tsx';

/** UI-027. Gated on the server (ADR-0321); data comes only through `/api/v1`. */
export const dynamic = 'force-dynamic';

export default async function IdentitiesPage() {
  await authorizePage('/people/identities');
  const nav = await getTranslations('nav.item');
  return (
    <>
      <PageHeading>{nav('identities')}</PageHeading>
      <IdentityMappingView />
    </>
  );
}
