import { startFakes } from './start.ts';

/** Entry of `pnpm --filter @git-migrator/provider-fakes start`. Env: FAKE_BITBUCKET_PORT, FAKE_GIT_PORT, FAKE_GIT_ROOT, FAKE_GIT_PUBLIC_URL. */
const fakes = await startFakes({
  bitbucketPort: process.env.FAKE_BITBUCKET_PORT
    ? Number(process.env.FAKE_BITBUCKET_PORT)
    : undefined,
  gitPort: process.env.FAKE_GIT_PORT ? Number(process.env.FAKE_GIT_PORT) : undefined,
  gitRootDir: process.env.FAKE_GIT_ROOT,
  hostname: process.env.FAKES_HOST,
  bitbucket: process.env.FAKE_GIT_BASE_URL ? { gitBaseUrl: process.env.FAKE_GIT_BASE_URL } : {},
  git: process.env.FAKE_GIT_PUBLIC_URL ? { publicUrl: process.env.FAKE_GIT_PUBLIC_URL } : {},
});
console.log(`fake Bitbucket listening on :${fakes.bitbucket.port}`);
if (fakes.git) console.log(`fake git server listening on ${fakes.git.baseUrl}`);

const stop = () => {
  void fakes.close().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
