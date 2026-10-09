/**
 * `pnpm e2e:live:reset` (TST-032): puts the live fixture back to its starting state. It deletes the
 * target repository and undoes the source read-only changes; it is idempotent. When
 * `GM_E2E_APP_URL` names a running app that still has the Migration, the app's own rollback and
 * undo Runs go first (sign-in as the test operator with GM_TEST_USER_PASSWORD).
 *
 * It refuses to run in CI and without the live configuration, like the test itself.
 */
import { createAppPort } from '../src/live/app.ts';
import { resetLive } from '../src/live/reset.ts';
import { contextFromEnv, portsFor } from '../src/live/runtime.ts';

async function main(): Promise<void> {
  // The package script sets GM_E2E_TARGET=live; `contextFromEnv` applies the same refusals as the test.
  const ctx = contextFromEnv(process.env);
  if (ctx.target !== 'live') throw new Error('the reset only runs against the live accounts');
  const appUrl = process.env.GM_E2E_APP_URL;
  const password = process.env.GM_TEST_USER_PASSWORD;
  const app =
    appUrl && password
      ? createAppPort({
          baseUrl: appUrl,
          email: ctx.operatorEmail,
          password,
          slug: ctx.fixture.slug,
          endpointId: ctx.bitbucket.endpointId,
          projectKey: ctx.fixture.projectKey,
        })
      : undefined;
  const report = await resetLive(ctx, { ...portsFor(ctx), app, log: (line) => console.log(line) });
  console.log(
    `reset done: target ${report.targetDeleted ? 'deleted' : 'was absent'}, ${report.restrictionsRemoved} restriction(s) removed, description ${report.descriptionRestored ? 'restored' : 'unchanged'}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
