import { getRequestConfig } from 'next-intl/server';

/**
 * next-intl without locale routing: English is the only catalog (UI-001, ADR-0093). Dates and
 * numbers are formatted on the client in the viewer's own locale and time zone.
 */
export default getRequestConfig(async () => ({
  locale: 'en',
  messages: (await import('../messages/en.json')).default,
}));
