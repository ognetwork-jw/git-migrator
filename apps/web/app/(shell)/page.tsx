import { getTranslations } from 'next-intl/server';
import { DashboardView } from '../../src/dashboard/dashboard-view.tsx';
import { authorizePage } from '../../src/server/authorize.ts';
import { PageHeading } from '../../src/ui/page-heading.tsx';

/** UI-020. Gated on the server (ADR-0321); data comes only through `/api/v1`. */
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  await authorizePage('/');
  const t = await getTranslations('dashboard');
  return (
    <>
      <PageHeading>{t('title')}</PageHeading>
      <DashboardView />
    </>
  );
}
