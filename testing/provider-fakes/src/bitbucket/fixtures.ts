import type { BitbucketState } from './state.ts';

/**
 * Builds a world into freshly reset state. T-043 registers `world` here. A builder may be async
 * (seeding the git server): `reset()` then returns a promise and the REST API answers 503 until it
 * settles (ADR-0130).
 */
export type FixtureBuilder = (state: BitbucketState) => void | Promise<void>;

export type FixtureRegistry = Record<string, FixtureBuilder>;

/** The built-in fixtures. `empty` is the reset state: the configured credentials, nothing else. */
export const BUILTIN_FIXTURES: FixtureRegistry = {
  empty: () => {},
};
