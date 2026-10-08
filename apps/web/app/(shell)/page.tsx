import { getTranslations } from 'next-intl/server';
import { PageHeading, PageText } from '../../src/ui/page-heading.tsx';

export default async function DashboardPage() {
  const t = await getTranslations('dashboard');
  return (
    <>
      <PageHeading>{t('title')}</PageHeading>
      <PageText>{t('placeholder')}</PageText>
    </>
  );
}
