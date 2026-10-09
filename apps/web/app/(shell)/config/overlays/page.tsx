import { getTranslations } from 'next-intl/server';
import { OverlaysView } from '../../../../src/config/overlays-view.tsx';
import { authorizePage } from '../../../../src/server/authorize.ts';
import { PageHeading } from '../../../../src/ui/page-heading.tsx';

/** UI-032. Gated on the server (ADR-0321); data comes only through the RPC mount. */
export const dynamic = 'force-dynamic';

export default async function OverlaysPage() {
  await authorizePage('/config/overlays');
  const nav = await getTranslations('nav.item');
  return (
    <>
      <PageHeading>{nav('overlays')}</PageHeading>
      <OverlaysView />
    </>
  );
}
