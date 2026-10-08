import { DEFAULT_PORTS } from '@git-migrator/provider-fakes';
import { resetWorld, startWorldFakes } from './start.ts';

/**
 * Entry of `pnpm --filter @git-migrator/fixtures start`: all fakes with the `world` fixture
 * registered, and the world already built (`FIXTURE_WORLD=0` starts empty). Same environment as the
 * provider-fakes entry: FAKE_BITBUCKET_PORT, FAKE_GITHUB_PORT, FAKE_GIT_PORT, FAKE_GIT_ROOT,
 * FAKE_GIT_PUBLIC_URL, FAKES_HOST.
 */
const fakes = await startWorldFakes({
  bitbucketPort: process.env.FAKE_BITBUCKET_PORT
    ? Number(process.env.FAKE_BITBUCKET_PORT)
    : undefined,
  githubPort: process.env.FAKE_GITHUB_PORT
    ? Number(process.env.FAKE_GITHUB_PORT)
    : DEFAULT_PORTS.github,
  gitPort: process.env.FAKE_GIT_PORT ? Number(process.env.FAKE_GIT_PORT) : undefined,
  gitRootDir: process.env.FAKE_GIT_ROOT,
  hostname: process.env.FAKES_HOST,
  git: process.env.FAKE_GIT_PUBLIC_URL ? { publicUrl: process.env.FAKE_GIT_PUBLIC_URL } : {},
});
if (process.env.FIXTURE_WORLD !== '0') await resetWorld(fakes);
console.log(`fake Bitbucket listening on :${fakes.bitbucket.port}`);
if (fakes.github) console.log(`fake GitHub listening on :${fakes.github.port}`);
if (fakes.git) console.log(`fake git server listening on ${fakes.git.baseUrl}`);

const stop = () => {
  void fakes.close().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
