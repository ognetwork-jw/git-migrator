import { startStack } from './stack.ts';

/**
 * Playwright global setup: starts the stack once and hands the base URL to the specs through the
 * environment (workers inherit it). The returned function is the teardown.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const stack = await startStack();
  process.env.GM_E2E_BASE_URL = stack.baseUrl;
  return stack.stop;
}
