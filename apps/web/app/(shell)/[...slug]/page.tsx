import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { itemForPath } from '../../../src/shell/navigation.ts';
import { PageHeading, PageText } from '../../../src/ui/page-heading.tsx';

/**
 * The pages of the sidebar that a later task builds (UI-020 to UI-035) answer here until they
 * exist; any other address is a 404 inside the shell.
 */
export default async function PlannedPage({
  params,
}: {
  readonly params: Promise<{ readonly slug: string[] }>;
}) {
  const { slug } = await params;
  const item = itemForPath(`/${slug.join('/')}`);
  if (item === undefined) notFound();
  const nav = await getTranslations('nav.item');
  const t = await getTranslations('comingSoon');
  return (
    <>
      <PageHeading>{nav(item.id)}</PageHeading>
      <PageText>{t('body')}</PageText>
    </>
  );
}
