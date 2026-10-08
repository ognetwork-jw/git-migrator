'use client';

import { Button, Result } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

/** A 404 inside the shell. */
export function NotFoundView() {
  const t = useTranslations('notFound');
  return (
    <Result
      status="404"
      title={t('title')}
      subTitle={t('body')}
      extra={
        <Link href="/">
          <Button type="primary">{t('back')}</Button>
        </Link>
      }
    />
  );
}
