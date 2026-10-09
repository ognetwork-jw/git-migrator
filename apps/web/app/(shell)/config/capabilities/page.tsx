import { getTranslations } from 'next-intl/server';
import { CapabilityMatrixView } from '../../../../src/config/capabilities-view.tsx';
import { authorizePage } from '../../../../src/server/authorize.ts';
import { PageHeading } from '../../../../src/ui/page-heading.tsx';

/** UI-033. Gated on the server (ADR-0321); the matrix comes through `/api/v1`. */
export const dynamic = 'force-dynamic';

export default async function CapabilitiesPage() {
  await authorizePage('/config/capabilities');
  const nav = await getTranslations('nav.item');
  return (
    <>
      <PageHeading>{nav('capabilities')}</PageHeading>
      <CapabilityMatrixView />
    </>
  );
}
