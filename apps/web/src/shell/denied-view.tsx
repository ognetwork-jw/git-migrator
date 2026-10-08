'use client';

import { Button, Result } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useActor } from './actor-context.tsx';
import { parseRequiredRole } from './navigation.ts';

/** `/denied` (UI-036): explains which role the page needs and which one the Actor has. */
export function DeniedView({ required }: { readonly required?: string | null }) {
  const t = useTranslations('denied');
  const roles = useTranslations('shell.role');
  const actor = useActor();
  const needed = parseRequiredRole(required);
  return (
    <Result
      status="403"
      title={t('title')}
      subTitle={
        needed === undefined
          ? t('bodyUnknown')
          : t('body', {
              required: roles(needed),
              role: roles(actor.role),
              name: actor.displayName,
            })
      }
      extra={
        <Link href="/">
          <Button type="primary">{t('back')}</Button>
        </Link>
      }
    />
  );
}
