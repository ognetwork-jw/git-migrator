import { getTranslations } from 'next-intl/server';
import { NamingRulesView } from '../../../../src/config/naming-view.tsx';
import { authorizePage } from '../../../../src/server/authorize.ts';
import { PageHeading } from '../../../../src/ui/page-heading.tsx';

/** UI-030. Gated on the server (ADR-0321); data comes only through `/api/v1` and the RPC mount. */
export const dynamic = 'force-dynamic';

export default async function NamingPage() {
  await authorizePage('/config/naming');
  const nav = await getTranslations('nav.item');
  return (
    <>
      <PageHeading>{nav('naming')}</PageHeading>
      <NamingRulesView />
    </>
  );
}
