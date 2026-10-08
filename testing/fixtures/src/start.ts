import {
  bitbucket,
  DEFAULT_MAX_BLOB_BYTES,
  DEFAULT_MAX_PUSH_BYTES,
  type FakeGitServer,
  type github,
  type RunningFakes,
  type StartOptions,
  startFakes,
} from '@git-migrator/provider-fakes';
import { cleanSourceGit, worldFixtures } from './world.ts';

/**
 * Starts the fake git server, Bitbucket and GitHub with the `world` fixture registered on both
 * REST fakes (TST-012). Nothing is built until `POST /__reset {"fixture":"world"}` is sent to the
 * fake Bitbucket (which also rebuilds the git `source` side) and to the fake GitHub (which sets the
 * target limits); `resetWorld` does both.
 *
 * Every fixture of both fakes, `empty` included, is wrapped so that a reset to it does not keep the
 * world's git state: a Bitbucket reset removes the `acme/*` source repositories and their LFS
 * objects, a GitHub reset restores the `target` limits to the configured ones (ADR-0130). The git
 * server itself is not gated during a reset: await `reset()` before touching it. The fake GitHub
 * always starts.
 */
export async function startWorldFakes(options: StartOptions = {}): Promise<RunningFakes> {
  let running: RunningFakes | undefined;
  const getGit = (): FakeGitServer | undefined => running?.git;
  const world = worldFixtures(getGit);
  const target = options.git === false ? undefined : options.git?.target;
  const restoreLimits = () =>
    getGit()?.setLimits('target', {
      maxBlobBytes:
        target?.maxBlobBytes === undefined ? DEFAULT_MAX_BLOB_BYTES : target.maxBlobBytes,
      maxPushBytes:
        target?.maxPushBytes === undefined ? DEFAULT_MAX_PUSH_BYTES : target.maxPushBytes,
    });

  const bbFixtures = {
    ...bitbucket.BUILTIN_FIXTURES,
    ...world.bitbucket,
    ...options.bitbucket?.fixtures,
  };
  const ghFixtures: Record<string, (state: github.GitHubState) => void | Promise<void>> = {
    empty: () => {},
    ...world.github,
    ...options.github?.fixtures,
  };
  const wrappedBb = Object.fromEntries(
    Object.entries(bbFixtures).map(([name, build]) => [
      name,
      async (state: bitbucket.BitbucketState) => {
        const git = getGit();
        if (git) await cleanSourceGit(git);
        await build(state);
      },
    ]),
  );
  const wrappedGh = Object.fromEntries(
    Object.entries(ghFixtures).map(([name, build]) => [
      name,
      async (state: github.GitHubState) => {
        restoreLimits();
        await build(state);
      },
    ]),
  );
  running = await startFakes({
    ...options,
    bitbucket: { ...options.bitbucket, fixtures: wrappedBb },
    github: { ...options.github, fixtures: wrappedGh },
  });
  return running;
}

/**
 * Resets the fakes to the world: GitHub first (drops its repositories and their bare repositories),
 * then Bitbucket (rebuilds the git `source` side). Same as sending `POST /__reset` with
 * `{"fixture":"world"}` to both.
 */
export async function resetWorld(fakes: RunningFakes, fixture = 'world'): Promise<void> {
  await fakes.github?.reset(fixture);
  await fakes.bitbucket.reset(fixture);
}
