import { getRequestConfig } from 'next-intl/server';
import { messages } from '../src/messages.ts';

/**
 * next-intl without locale routing: English is the only catalog (UI-001, ADR-0093). Dates and
 * numbers are formatted on the client in the viewer's own locale and time zone. The guidance
 * catalog is mounted beside the interface strings (see `src/messages.ts`).
 */
export default getRequestConfig(async () => ({
  locale: 'en',
  messages,
}));
