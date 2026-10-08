import { startFakes } from './start.ts';

/** Entry of `pnpm --filter @git-migrator/provider-fakes start`. Env: FAKE_BITBUCKET_PORT. */
const fakes = await startFakes({
  bitbucketPort: process.env.FAKE_BITBUCKET_PORT
    ? Number(process.env.FAKE_BITBUCKET_PORT)
    : undefined,
  hostname: process.env.FAKES_HOST,
  bitbucket: process.env.FAKE_GIT_BASE_URL ? { gitBaseUrl: process.env.FAKE_GIT_BASE_URL } : {},
});
console.log(`fake Bitbucket listening on :${fakes.bitbucket.port}`);

const stop = () => {
  void fakes.close().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
