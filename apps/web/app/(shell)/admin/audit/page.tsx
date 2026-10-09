import { getTranslations } from 'next-intl/server';
import { AuditLogView } from '../../../../src/admin/audit-view.tsx';
import { authorizePage } from '../../../../src/server/authorize.ts';
import { PageHeading } from '../../../../src/ui/page-heading.tsx';

/** UI-035. Gated on the server (ADR-0321); every role may read the log (AUTH-020). */
export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  await authorizePage('/admin/audit');
  const nav = await getTranslations('nav.item');
  return (
    <>
      <PageHeading>{nav('audit')}</PageHeading>
      <AuditLogView />
    </>
  );
}
