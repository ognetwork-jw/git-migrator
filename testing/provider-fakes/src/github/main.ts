import { DEFAULT_GITHUB_PORT, startFakeGitHub } from './start.ts';

/** `pnpm --filter @git-migrator/provider-fakes start:github` */
const port = Number(process.env.FAKE_GITHUB_PORT ?? DEFAULT_GITHUB_PORT);
const hostname = process.env.FAKES_HOST ?? '127.0.0.1';
const fake = await startFakeGitHub({
  port,
  hostname,
  gitBaseUrl: process.env.FAKE_GIT_BASE_URL ? `${process.env.FAKE_GIT_BASE_URL}/target` : undefined,
});
console.log(`fake GitHub listening on ${fake.url}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void fake.close().then(() => process.exit(0));
  });
