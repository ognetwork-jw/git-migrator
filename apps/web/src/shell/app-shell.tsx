'use client';

import { LogoutOutlined, MenuOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Drawer, Result, Spin, Tag, Typography } from 'antd';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useState } from 'react';
import { ACTOR_QUERY_KEY, fetchActor } from '../api/actor.ts';
import { signOut } from '../auth/client.ts';
import { hardNavigate } from '../auth/navigate.ts';
import { signInHref } from '../auth/paths.ts';
import { ActorProvider } from './actor-context.tsx';
import { LiveStatus } from './live-status.tsx';
import { LiveTopicsProvider } from './live-topics.tsx';
import { NavMenu } from './nav-menu.tsx';
import { canOpen, deniedHref } from './navigation.ts';

const SIGN_IN_PATH = '/signin';
/** `/denied` explains a missing role, so it must stay reachable for any signed-in Actor. */
const DENIED_PATH = '/denied';

function Centered({ children }: { readonly children: ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-4">{children}</div>;
}

/**
 * The signed-in layout (UI-010): a sidebar from 1024 px up and a drawer below it, a header with
 * the Actor, their role and sign-out, and a `main` landmark. It loads the Actor from the API, sends
 * unauthenticated visitors to `/signin` and Actors without the role for a page to `/denied`; the
 * server enforces the same rules on every request (AUTH-021).
 */
export function AppShell({ children }: { readonly children: ReactNode }) {
  const t = useTranslations('shell');
  const problems = useTranslations('problem');
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const query = useQuery({ queryKey: ACTOR_QUERY_KEY, queryFn: () => fetchActor() });
  const result = query.data;
  const actor = result?.kind === 'ok' ? result.actor : undefined;
  const unauthenticated = result?.kind === 'unauthenticated';
  const denied = actor !== undefined && pathname !== DENIED_PATH && !canOpen(actor, pathname);

  useEffect(() => {
    if (unauthenticated) router.replace(signInHref(pathname, window.location.search));
    else if (denied) router.replace(deniedHref(pathname));
  }, [unauthenticated, denied, router, pathname]);

  if (result?.kind === 'problem' || query.isError) {
    const code = result?.kind === 'problem' ? result.code : 'not_ready';
    return (
      <Centered>
        <Result
          status="error"
          title={t('failed')}
          subTitle={problems.has(code) ? problems(code) : problems('internal_error')}
          extra={
            <Button type="primary" onClick={() => void query.refetch()}>
              {t('retry')}
            </Button>
          }
        />
      </Centered>
    );
  }

  if (actor === undefined || denied) {
    return (
      <Centered>
        <div role="status" className="flex flex-col items-center gap-3">
          <Spin size="large" />
          <Typography.Text type="secondary">{t('loading')}</Typography.Text>
        </div>
      </Centered>
    );
  }

  const onSignOut = async () => {
    setSigningOut(true);
    await signOut();
    queryClient.clear();
    hardNavigate(SIGN_IN_PATH);
  };

  return (
    <ActorProvider value={actor}>
      <LiveTopicsProvider>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:start-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-black dark:focus:bg-neutral-900 dark:focus:text-white"
        >
          {t('skipToContent')}
        </a>
        <div className="min-h-screen bg-neutral-100 text-neutral-900 lg:grid lg:grid-cols-[16rem_minmax(0,1fr)] dark:bg-black dark:text-neutral-100">
          <aside className="sticky top-0 hidden h-screen overflow-y-auto border-e border-neutral-200 bg-white lg:block dark:border-neutral-800 dark:bg-neutral-900">
            <Brand />
            <NavMenu actor={actor} />
          </aside>
          <div className="flex min-w-0 flex-col">
            <header className="flex items-center gap-3 border-b border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900">
              <Button
                className="lg:hidden"
                type="text"
                icon={<MenuOutlined aria-hidden />}
                aria-label={t('openMenu')}
                onClick={() => setMenuOpen(true)}
              />
              <Link href="/" className="font-semibold lg:hidden">
                <BrandName />
              </Link>
              <div className="ms-auto flex items-center gap-3">
                <LiveStatus />
                <span className="hidden text-sm sm:inline" title={actor.email ?? undefined}>
                  {actor.displayName}
                </span>
                <Tag className="me-0" data-testid="actor-role">
                  {t(`role.${actor.role}`)}
                </Tag>
                <Button
                  icon={<LogoutOutlined aria-hidden />}
                  loading={signingOut}
                  onClick={() => void onSignOut()}
                >
                  {t('signOut')}
                </Button>
              </div>
            </header>
            <main id="main" tabIndex={-1} className="flex-1 p-4 outline-none sm:p-6">
              {children}
            </main>
          </div>
        </div>
        <Drawer
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          placement="left"
          title={t('menuTitle')}
          size={288}
          closable={{ 'aria-label': t('closeMenu') }}
          styles={{ body: { padding: 0 } }}
        >
          <NavMenu actor={actor} onNavigate={() => setMenuOpen(false)} />
        </Drawer>
      </LiveTopicsProvider>
    </ActorProvider>
  );
}

function BrandName() {
  const t = useTranslations('app');
  return <>{t('name')}</>;
}

function Brand() {
  return (
    <div className="px-6 py-4 text-lg font-semibold">
      <Link href="/">
        <BrandName />
      </Link>
    </div>
  );
}
