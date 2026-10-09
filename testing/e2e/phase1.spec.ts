/**
 * T-083, TST-021: the Phase-1 flow (TST-020) through the browser, against the production build of
 * the web app, the real API and worker, Postgres and the provider fakes (`harness/stack.ts`,
 * ADR-0485). The steps are one ordered scenario (`harness/phase1-flow.ts`): each `test.step` is a
 * numbered step of TST-021.
 */
import { test } from '@playwright/test';
import { runPhase1 } from './harness/phase1-flow.ts';

test('[TST-021] the Phase-1 flow: refresh, find auto-ok, migrate, watch the Run, verify', async ({
  context,
  page,
}, testInfo) => {
  await runPhase1(context, page, testInfo, {
    operator: 'operator@test.local',
    repoText: 'plat/auto-ok',
  });
});
