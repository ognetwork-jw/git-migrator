import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import messages from '../messages/en.json' with { type: 'json' };

/** Renders with the real English catalog and a fresh query client (for component tests). */
export function renderWithApp(ui: ReactElement, client = new QueryClient()) {
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={messages}>
          {ui}
        </NextIntlClientProvider>
      </QueryClientProvider>,
    ),
  };
}

/** jsdom has no `matchMedia`; antd and the theme hook ask for it. */
export function installMatchMedia(dark = false) {
  const listeners = new Set<() => void>();
  let matches = dark;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches() {
        return query.includes('prefers-color-scheme: dark') ? matches : false;
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  return {
    setDark(next: boolean) {
      matches = next;
      for (const listener of listeners) listener();
    },
  };
}
