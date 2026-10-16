import { AntdRegistry } from '@ant-design/nextjs-registry';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { COLOR_SCHEME_COOKIE, prefersDarkFromCookie } from '../src/ui/color-scheme.ts';
import { AppProviders } from '../src/ui/providers.tsx';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app');
  return { title: t('name'), description: t('description') };
}

/**
 * The root layout (UI-001). Ant Design's styles are collected during server rendering by the App
 * Router registry and emitted in the `antd` CSS layer (see `globals.css` for the layer order).
 */
export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  // The scheme the browser reported last time, so antd's first paint matches it (ADR-0520).
  const initialDark = prefersDarkFromCookie((await cookies()).get(COLOR_SCHEME_COOKIE)?.value);
  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <AntdRegistry layer>
            <AppProviders initialDark={initialDark}>{children}</AppProviders>
          </AntdRegistry>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
