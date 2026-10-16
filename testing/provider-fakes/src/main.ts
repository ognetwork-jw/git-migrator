import { startFakes, startOptionsFromEnv } from './start.ts';

/** Entry of `pnpm --filter @git-migrator/provider-fakes start`. Environment: see `startOptionsFromEnv`. */
const fakes = await startFakes(startOptionsFromEnv(process.env));
console.log(`fake Bitbucket listening on :${fakes.bitbucket.port}`);
if (fakes.github) console.log(`fake GitHub listening on :${fakes.github.port}`);
if (fakes.git) console.log(`fake git server listening on ${fakes.git.baseUrl}`);

const stop = () => {
  void fakes.close().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
