'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App, ConfigProvider, theme } from 'antd';
import { type ReactNode, useState } from 'react';
import { usePrefersDark } from './use-prefers-dark.ts';

/** The antd theme for a color scheme: `theme.algorithm` follows the OS preference (UI-001). */
export const themeFor = (dark: boolean) => ({
  algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
  token: { fontFamily: 'var(--font-sans)' },
});

/** TanStack Query, the antd theme and the antd `App` context (notifications, modals). */
export function AppProviders({ children }: { readonly children: ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: 1 } } }),
  );
  const dark = usePrefersDark();
  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider theme={themeFor(dark)}>
        <App component={false}>{children}</App>
      </ConfigProvider>
    </QueryClientProvider>
  );
}
