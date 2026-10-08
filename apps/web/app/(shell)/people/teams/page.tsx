import { getTranslations } from 'next-intl/server';
import { GroupMappingView } from '../../../../src/mapping/group-mapping-view.tsx';
import { authorizePage } from '../../../../src/server/authorize.ts';
import { PageHeading } from '../../../../src/ui/page-heading.tsx';

/** UI-028. Gated on the server (ADR-0321); data comes only through `/api/v1`. */
export const dynamic = 'force-dynamic';

export default async function TeamsPage() {
  await authorizePage('/people/teams');
  const nav = await getTranslations('nav.item');
  return (
    <>
      <PageHeading>{nav('teams')}</PageHeading>
      <GroupMappingView />
    </>
  );
}
