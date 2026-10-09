import { getTranslations } from 'next-intl/server';
import { WebhookAllowlistView } from '../../../../src/config/webhook-view.tsx';
import { authorizePage } from '../../../../src/server/authorize.ts';
import { PageHeading } from '../../../../src/ui/page-heading.tsx';

/** UI-031. Gated on the server (ADR-0321); data comes only through the RPC mount. */
export const dynamic = 'force-dynamic';

export default async function WebhookAllowlistPage() {
  await authorizePage('/config/webhook-allowlist');
  const nav = await getTranslations('nav.item');
  return (
    <>
      <PageHeading>{nav('webhookAllowlist')}</PageHeading>
      <WebhookAllowlistView />
    </>
  );
}
