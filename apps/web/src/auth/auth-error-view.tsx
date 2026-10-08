'use client';

import { Button, Result } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

/** `/auth/error?error=<code>`: the text under `auth.error.<code>` (T-020 follow-up, AUTH-010). */
export function AuthErrorView({ code }: { readonly code: string }) {
  const t = useTranslations('auth');
  return (
    <Result
      status="warning"
      title={t('error.title')}
      subTitle={t(`error.${code}`)}
      extra={
        <Link href="/signin">
          <Button type="primary">{t('errorPage.backToSignIn')}</Button>
        </Link>
      }
    />
  );
}
